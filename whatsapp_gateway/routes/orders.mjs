/**
 * Checkout, Order Placement, Payment Verification & Order Status Routes
 * Extracted from http_routes.mjs (see routes/INDEX.md)
 */
import { parseJsonBody } from "../http_helpers.mjs";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config.mjs";
import { getAllShops } from "../tenant_resolver.mjs";

export async function handleOrdersRoutes({
  req,
  res,
  parsedUrl,
  GROUPS,
  safeSendMessage,
  sharedOrderGuard,
}) {
    if (req.method === "POST" && (parsedUrl.pathname === "/order" || parsedUrl.pathname === "/api/order" || parsedUrl.pathname === "/api/checkout")) {
      try {
        const body = await parseJsonBody(req);
        const meta = body.metadata || {};
        const items = body.items || meta.items || [];
        const customer = body.customer || meta.customer || {};
        const custName = customer.name || meta.clientName || body.customer_name || "Store Customer";
        const custPhone = customer.phone || meta.clientPhone || body.customer_phone || "+254710720949";
        const total = body.payment?.amount || meta.totalAmount || body.total_amount || body.total || 0;
        const shopTitle = body.shopName || body.tenantName || body.tenantId || "Store";
        const orderId = body.orderId || meta.orderId || body.order_id || `ORD-${Date.now().toString().slice(-6)}`;
        const supabaseId = body.supabaseId || meta.supabaseId || null;
        const pickup = customer.address || customer.fulfillmentType || meta.deliveryAddress || meta.fulfillmentType || "In-Store Pickup";

        // Order Guard check on legacy /order & /api/checkout when items are provided
        // If order was already reserved by /api/v1/storefront/checkout (via guardOrderId or orderId), reuse that hold!
        const candidateHoldId = body.guardOrderId || orderId;
        const existingHold = sharedOrderGuard.getHold(candidateHoldId) || sharedOrderGuard.getHold(orderId);
        if (Array.isArray(items) && items.length > 0 && (!existingHold || !["HELD", "APPROVED", "COMMITTED"].includes(existingHold.status))) {
          const shopSlugOrId = body.shop_id || body.shopId || body.tenantId || body.shopSlug || "default";
          const legacyEnv = sealCheckoutEnvelope({
            order_id: candidateHoldId,
            shop_id: shopSlugOrId,
            shop_slug: body.shopSlug || body.tenantId,
            customer_name: custName,
            customer_phone: custPhone,
            delivery_address: pickup,
            items
          }, {
            piiKey: PII_ENCRYPTION_KEY,
            inspectorKey: ORDER_GUARD_KEY,
            hmacSecret: ORDER_GUARD_HMAC_SECRET
          });
          const ogVerdict = await sharedOrderGuard.inspectAndReserve(legacyEnv);
          if (ogVerdict.decision === "REJECTED") {
            res.writeHead(409);
            return res.end(JSON.stringify({ success: false, ...ogVerdict, can_show_payment: false }));
          }
        }

        // 0. Instant Pre-Paid Till Pool Lookback (Customer paid Till 1-10m BEFORE clicking Place Order)
        let preMatchedReceipt = null;
        try {
          const fsMod = await import("fs");
          const pathMod = await import("path");
          const poolPath = pathMod.resolve(process.cwd(), "till_receipt_pool.json");
          if (fsMod.existsSync(poolPath) && Number(total) > 0) {
            const pool = JSON.parse(fsMod.readFileSync(poolPath, "utf-8") || "[]");
            const nowMs = Date.now();
            const lookbackMs = 10 * 60 * 1000; // 10 minutes
            const custPhoneSuffix = (custPhone || "").replace(/\D/g, "").slice(-9);
            const custNameTokens = (custName || "").toLowerCase().split(/\s+/).filter(t => t.length >= 3 && t !== "store" && t !== "customer");

            const candidates = pool.filter(r =>
              r.direction !== "OUTFLOW" &&
              (r.status === "UNCLAIMED_POOL" || r.status === "AMBIGUOUS") &&
              Number(r.amount) === Number(total) &&
              (!r.received_at || (nowMs - new Date(r.received_at).getTime()) <= lookbackMs)
            );

            // Match by phone suffix or registered name token
            preMatchedReceipt = (custPhoneSuffix.length === 9
              ? candidates.find(r => (r.payer_phone || "").replace(/\D/g, "").slice(-9) === custPhoneSuffix)
              : null) || (custNameTokens.length > 0
              ? candidates.find(r => {
                  const pName = (r.payer_name || "").toLowerCase();
                  return custNameTokens.some(tok => pName.includes(tok));
                })
              : null) || null;

            if (preMatchedReceipt) {
              preMatchedReceipt.status = "CLAIMED";
              preMatchedReceipt.order_id = supabaseId || orderId;
              fsMod.writeFileSync(poolPath, JSON.stringify(pool, null, 2), "utf-8");

              if (supabaseId || orderId) {
                const targetPrimary = supabaseId || orderId;
                const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetPrimary);
                const filter = isUUID ? `id=eq.${targetPrimary}` : `notes=eq.${orderId}`;
                await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}`, {
                  method: "PATCH",
                  headers: {
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal"
                  },
                  body: JSON.stringify({
                    status: "paid",
                    internal_status: "PAID",
                    mpesa_code: preMatchedReceipt.code
                  })
                });
              }
              try {
                await sharedOrderGuard.commitOrder(body.guardOrderId || orderId);
              } catch (_) {}
              console.log(`[INSTANT POOL CLEARANCE] Order ${orderId} pre-settled on creation via receipt ${preMatchedReceipt.code}`);
            }
          }
        } catch (poolErr) {
          console.warn("[INSTANT POOL CLEARANCE WARN]", poolErr.message);
        }

        // Resolve authoritative Shop & WhatsApp Groups from Supabase (getAllShops)
        let matchedShop = null;
        try {
          const allShops = await getAllShops();
          const qSlug = (body.tenantId || body.shopSlug || body.shop_slug || "").toLowerCase().trim();
          const qId = (body.shopId || body.shop_id || "").trim();
          const qName = (shopTitle || "").toLowerCase().trim();
          matchedShop = allShops.find(s =>
            (qId && s.id === qId) ||
            (qSlug && s.slug?.toLowerCase() === qSlug) ||
            (qName && s.name?.toLowerCase() === qName)
          ) || null;
        } catch (e) {}

        const resolvedShopSlug = matchedShop?.slug || body.tenantId || body.shop_slug || "creative-galore";
        const shopRouting = matchedShop?.fulfillment_settings?.whatsapp_routing || {};

        // 1. Post to room_server orders pipeline with shop_slug
        try {
          await import("./http_helpers.mjs").then(async ({ httpRequest }) => {
            await httpRequest("http://127.0.0.1:5050/api/orders/webhook", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                order_id: orderId,
                shop_slug: resolvedShopSlug,
                customer_name: custName,
                customer_phone: custPhone,
                items: items.map(i => ({ name: i.name, qty: i.quantity || i.qty || 1, price: i.price || 0 })),
                total_amount: total,
                currency: "KES",
                notes: preMatchedReceipt
                  ? `[${matchedShop?.name || shopTitle}] Pickup: ${pickup} | Auto-Settled M-Pesa: ${preMatchedReceipt.code}`
                  : `[${matchedShop?.name || shopTitle}] Pickup: ${pickup}`,
                skip_whatsapp_notify: true
              })
            });
          });
        } catch (postErr) {
          console.warn("[HTTP IPC] Forward to room_server /api/orders/webhook:", postErr.message);
        }

        // 2. Dispatch Order Alert to Perpetua Floor Operations AND Shop Operations Group
        const targetJid = GROUPS.general.jid;
        const shopGroupJid = shopRouting.operations_jid || body.target?.groupJid || body.targetGroupJid || meta.targetGroupJid;
        const itemLines = items.map(i => `  • ${i.quantity || i.qty || 1}x *${i.name}*`).join("\n") || `  • ${body.summary || "Catalog Items"}`;
        const card = preMatchedReceipt
          ? `💰 *[ORDER PAID & VERIFIED (INSTANT POOL)]* \`${orderId}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🏪 *Store:* ${shopTitle}\n` +
            `👤 *Customer:* ${custName} (${custPhone})\n` +
            `📍 *Pickup:* ${pickup}\n` +
            `💰 *Paid:* KES ${Number(total).toLocaleString()} (\`${preMatchedReceipt.code}\` ✅)\n` +
            `📋 *Items:*\n${itemLines}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *Next Step:* Reply \`!pack ${String(supabaseId || orderId).slice(0, 8).toUpperCase()}\` to begin packaging.`
          : `🛍️ *[NEW STOREFRONT ORDER]* \`${orderId}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🏪 *Store:* ${shopTitle}\n` +
            `👤 *Customer:* ${custName} (${custPhone})\n` +
            `📍 *Pickup:* ${pickup}\n` +
            `💰 *Total:* KES ${Number(total).toLocaleString()}\n` +
            `📋 *Items:*\n${itemLines}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ _Advance station using:_ \`!paid ${orderId} <ref>\``;

        if (targetJid) {
          await safeSendMessage(targetJid, { text: card });
        }
        if (shopGroupJid && shopGroupJid !== targetJid) {
          console.log(`[WHATSAPP DISPATCH] Sending order card to shop group: ${shopGroupJid}`);
          await safeSendMessage(shopGroupJid, { text: card });
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          status: preMatchedReceipt ? "PAID" : "ingested",
          isPaid: Boolean(preMatchedReceipt),
          cleared: Boolean(preMatchedReceipt),
          mpesa_code: preMatchedReceipt?.code || null,
          order_id: orderId
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

// POST /api/order/verify-payment, /api/v1/orders/verify-payment & /api/store/verify-mpesa
    // SOURCE OF TRUTH: CLIENT_SUBMITTED_CLAIM (Supports Hardware Till Pool Match + 3-Factor Full SMS Self-Verification when Phone is Offline)
    if (req.method === "POST" && (parsedUrl.pathname === "/api/order/verify-payment" || parsedUrl.pathname === "/api/v1/orders/verify-payment" || parsedUrl.pathname === "/api/store/verify-mpesa")) {
      try {
        const body = await parseJsonBody(req);
        const { orderId, supabaseId, tenantId, shopName, code, smsText, amount, customer, items, targetGroupJid } = body;
        const primaryId = supabaseId || orderId;
        const rawClientInput = String(smsText || code || "").trim();
        console.log(`[CLIENT PAYMENT CLAIM] Source=CLIENT_SUBMITTED | Order=${orderId} (DB: ${primaryId}) | RawInput="${rawClientInput}" | KES ${amount}`);

        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;

        // 1. Resilient Client Input Parser:
        // Accepts EITHER a 10-char code ("UK6DC1DCIM") OR a full/partially-redacted Customer M-Pesa SMS
        // (even if the customer deleted their "New M-PESA balance" or transaction fee for privacy!).
        // NEVER reads or uses "New M-PESA balance" from a client message so client balances never corrupt our ledgers!
        const extractedCodeMatch = rawClientInput.match(/\b([A-Z0-9]{10})\b\s*Confirmed/i) ||
                                   rawClientInput.match(/^[A-Z0-9]{10}$/i) ||
                                   rawClientInput.match(/\b([A-Z0-9]{10})\b/);
        const cleanCode = extractedCodeMatch ? (extractedCodeMatch[1] || extractedCodeMatch[0]).trim().toUpperCase() : "";

        const clientAmtMatch = rawClientInput.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+(?:paid\s+to|sent\s+to)/i) ||
                               rawClientInput.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
        const clientClaimedAmount = clientAmtMatch ? parseFloat(clientAmtMatch[1].replace(/,/g, "")) : null;
        const clientMerchantMatch = rawClientInput.match(/(?:paid\s+to|sent\s+to)\s+(.+?)(?:\.\s*on\s+|\s+on\s+\d|\.|$)/i);
        const clientClaimedMerchant = clientMerchantMatch ? clientMerchantMatch[1].trim() : null;

        if (!/^[A-Z0-9]{10}$/.test(cleanCode)) {
          res.writeHead(422);
          return res.end(JSON.stringify({
            code: "SCHEMA_VALIDATION_ERROR",
            source_of_truth: "CLIENT_SUBMITTED_CLAIM",
            error: "Could not find a valid 10-character M-Pesa transaction code (e.g. UK6DC1DCIM) in your message."
          }));
        }

        // If the customer pasted a full/partial SMS that includes an amount, verify they didn't paste an SMS for a smaller amount!
        const expectedOrderAmount = Number(amount || 0);
        if (clientClaimedAmount !== null && expectedOrderAmount > 0 && clientClaimedAmount < expectedOrderAmount) {
          res.writeHead(422);
          return res.end(JSON.stringify({
            code: "AMOUNT_MISMATCH_IN_CLIENT_SMS",
            source_of_truth: "CLIENT_SUBMITTED_CLAIM",
            error: `The pasted M-Pesa message shows KES ${clientClaimedAmount}, which is less than the order total of KES ${expectedOrderAmount}.`
          }));
        }

        // 2. Single-Use M-Pesa Deduplication Guarantee (Stage 3 Invariant)
        const isPrimaryUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(primaryId || "");
        const dupRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?mpesa_code=eq.${cleanCode}&status=eq.paid&select=id,notes`, {
          headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` }
        });
        const existingPaid = await dupRes.json();
        const conflict = (existingPaid || []).filter(o =>
          (isPrimaryUUID && o.id !== primaryId) || (!isPrimaryUUID && o.notes !== orderId && o.id !== orderId)
        );
        if (conflict.length > 0) {
          res.writeHead(409);
          return res.end(JSON.stringify({
            code: "CODE_ALREADY_REDEEMED",
            error: `M-Pesa transaction code ${cleanCode} has already been redeemed on another settled order.`
          }));
        }

        // 3. Resolve Shop & WhatsApp Routing
        let matchedShop = null;
        try {
          const allShops = await getAllShops();
          const qSlug = (tenantId || body.shopSlug || "").toLowerCase().trim();
          const qName = (shopName || "").toLowerCase().trim();
          matchedShop = allShops.find(s =>
            (qSlug && s.slug?.toLowerCase() === qSlug) ||
            (qName && s.name?.toLowerCase() === qName) ||
            (orderId && String(orderId).toUpperCase().includes(s.fulfillment_settings?.whatsapp_routing?.order_prefix || "__NONE__")) ||
            s.fulfillment_settings?.whatsapp_routing?.operations_jid === targetGroupJid ||
            s.fulfillment_settings?.whatsapp_routing?.community_jid === targetGroupJid
          ) || null;
        } catch (e) {}

        // 4A. Hardware Till Pool Check:
        // Check if that exact 10-char code has ALREADY been received from the physical Till SIM in till_receipt_pool.json
        let hardwareVerifiedEntry = null;
        let alreadyClaimedInPool = false;
        try {
          const fsMod = await import("fs");
          const pathMod = await import("path");
          const poolPath = pathMod.resolve(process.cwd(), "till_receipt_pool.json");
          if (fsMod.existsSync(poolPath)) {
            const pool = JSON.parse(fsMod.readFileSync(poolPath, "utf-8") || "[]");
            const poolEntry = pool.find(r => (r.code || "").toUpperCase() === cleanCode);
            const reqAmt = Number(amount || 0);
            if (poolEntry) {
              if (poolEntry.status === "CLAIMED" && poolEntry.order_id && poolEntry.order_id !== primaryId && poolEntry.order_id !== orderId) {
                alreadyClaimedInPool = true;
              } else if (poolEntry.status !== "CLAIMED" && (!reqAmt || Number(poolEntry.amount) >= reqAmt)) {
                poolEntry.status = "CLAIMED";
                poolEntry.order_id = primaryId || orderId;
                fsMod.writeFileSync(poolPath, JSON.stringify(pool, null, 2), "utf-8");
                hardwareVerifiedEntry = poolEntry;
              }
            }
          }
        } catch (_) {}

        if (alreadyClaimedInPool) {
          res.writeHead(409);
          return res.end(JSON.stringify({
            code: "CODE_ALREADY_REDEEMED",
            error: `M-Pesa transaction code ${cleanCode} has already been claimed on another order.`
          }));
        }

        // 4B. 3-Factor Full SMS Self-Verification (When Till Phone is Offline):
        // 1) Merchant name matches SAVANNAH ATELIER (or shop's registered Till name),
        // 2) Exact KES amount >= order amount, and
        // 3) Unused 10-character M-Pesa code (verified above via Single-Use Deduplication).
        const allowedMerchants = [
          "SAVANNAH ATELIER",
          matchedShop?.mpesa_till_name,
          matchedShop?.name,
          shopName
        ].filter(Boolean).map(m => m.toUpperCase().trim());

        const merchantMatched = Boolean(
          clientClaimedMerchant &&
          allowedMerchants.some(m => clientClaimedMerchant.toUpperCase().includes(m) || m.includes(clientClaimedMerchant.toUpperCase()))
        );
        const threeFactorSmsVerified = Boolean(
          !hardwareVerifiedEntry &&
          merchantMatched &&
          clientClaimedAmount !== null &&
          expectedOrderAmount > 0 &&
          clientClaimedAmount >= expectedOrderAmount
        );

        const custName = customer?.name || "Customer";
        const custPhone = customer?.phone || "";
        const pickup = customer?.address || customer?.fulfillmentType || "In-Store Pickup";
        const shortUuid = primaryId ? String(primaryId).slice(0, 8).toUpperCase() : (orderId || "").slice(0, 8).toUpperCase();
        const refLabel = (orderId && orderId !== primaryId) ? `#${shortUuid} (\`${orderId}\`)` : `#${shortUuid}`;
        const storeLabel = matchedShop?.name || shopName || "Storefront";
        const itemLines = Array.isArray(items) && items.length > 0
          ? items.map(i => `  • ${i.quantity || i.qty || 1}x *${i.name}*`).join("\n")
          : "  • Order Items";

        let resolvedOpsJid = matchedShop?.fulfillment_settings?.whatsapp_routing?.operations_jid || targetGroupJid;
        let resolvedMgmtJid = matchedShop?.fulfillment_settings?.whatsapp_routing?.management_jid || null;
        const verifyTargets = new Set([
          GROUPS?.general?.jid || "120363429929736148@g.us",
          GROUPS?.adminOversight?.jid || "120363415291701803@g.us",
          resolvedOpsJid,
          resolvedMgmtJid
        ].filter(Boolean));

        // CASE A: Code is NOT in the Hardware Till Pool
        // -> Keep order PENDING, do NOT mark PAID, and require human admin/assistant approval (`!paid`)!
        if (!hardwareVerifiedEntry) {
          if (primaryId) {
            try {
              const filter = isPrimaryUUID ? `id=eq.${primaryId}` : `notes=eq.${orderId}`;
              const claimNote = `[UNVERIFIED CLIENT CLAIM: ${cleanCode} for KES ${amount || 0} — Awaiting Till SMS or Admin !paid Approval]`;
              await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}`, {
                method: "PATCH",
                headers: {
                  "apikey": SERVICE_KEY,
                  "Authorization": `Bearer ${SERVICE_KEY}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  status: "pending",
                  internal_status: "PENDING_PAYMENT",
                  notes: orderId && !/^[0-9a-f-]{36}$/i.test(orderId) ? `${orderId} | ${claimNote}` : claimNote
                })
              });
              console.log(`[ZERO-TRUST GUARD] Order ${primaryId} kept PENDING (Code ${cleanCode} not in Till Pool — awaiting admin approval).`);
            } catch (dbErr) {
              console.error("[BACKEND DB ERROR]", dbErr.message);
            }
          }

          if (safeSendMessage) {
            const claimCard =
              `⏳ *[UNVERIFIED PAYMENT CLAIM — DO NOT DISPATCH YET! — ${storeLabel.toUpperCase()}]*\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n` +
              `• *Source of Truth:* 👤 \`CLIENT_SUBMITTED_CLAIM\` *(Not from Till SIM Forwarder!)*\n` +
              `• *Order:* ${refLabel}\n` +
              `• *Customer:* ${custName}${custPhone ? ` (${custPhone})` : ""}\n` +
              `• *Order Amount:* KES ${Number(amount || 0).toLocaleString()}${clientClaimedAmount !== null ? ` (Client SMS says: KES ${clientClaimedAmount.toLocaleString()})` : ""}\n` +
              `• *Client Claimed Ref:* \`${cleanCode}\` ⚠️ *(NOT yet in Till Pool)*\n` +
              (clientClaimedMerchant ? `• *Client SMS Merchant:* ${clientClaimedMerchant}\n` : "") +
              `• *Items:*\n${itemLines}\n` +
              `━━━━━━━━━━━━━━━━━━━━━━\n` +
              `🛑 *SECURITY HOLD:* This message came from the *CLIENT*, not your Till SIM forwarder. Any client M-Pesa balance inside their message was ignored so it never corrupts your ledger.\n` +
              `👉 *Assistant / Admin Action:* Verify the real Till SMS first, then manually approve with:\n` +
              `\`!paid ${shortUuid} ${cleanCode}\``;

            for (const vJid of verifyTargets) {
              safeSendMessage(vJid, { text: claimCard });
            }
          }

          res.writeHead(200);
          return res.end(JSON.stringify({
            success: true,
            source_of_truth: "CLIENT_SUBMITTED_CLAIM",
            status: "PENDING_ADMIN_APPROVAL",
            isPaid: false,
            hardwareVerified: false,
            clientBalanceIgnored: true,
            paired: false,
            orderId: primaryId || orderId,
            code: cleanCode,
            message: `Payment claim ${cleanCode} submitted for verification. Your order will be marked PAID as soon as the Till receipt reflects or an assistant approves it.`
          }));
        }

        // CASE B: Code IS in the Hardware Till Pool -> Safe to mark PAID!
        if (primaryId || body.guardOrderId) {
          // Order Guard Atomic Commit: held -> sold (try guardOrderId first, then orderId, then primaryId)
          const holdCandidates = [body.guardOrderId, orderId, primaryId].filter(Boolean);
          let ogCommit = { success: false, code: "HOLD_NOT_FOUND" };
          for (const hId of holdCandidates) {
            ogCommit = await sharedOrderGuard.commitOrder(hId);
            if (ogCommit.success || ogCommit.code !== "HOLD_NOT_FOUND") break;
          }
          if (!ogCommit.success && ogCommit.code === "REFUND_REQUIRED") {
            if (safeSendMessage) {
              const refundAlert =
                `⚠️ *[LATE PAYMENT — REFUND REQUIRED — ${storeLabel.toUpperCase()}]*\n` +
                `• *Order:* ${refLabel}\n` +
                `• *M-Pesa Ref:* \`${cleanCode}\` (KES ${Number(amount || 0).toLocaleString()})\n` +
                `• *Reason:* Hold expired and ${ogCommit.item || "item"} is now sold out.\n` +
                `• *Action:* Please refund customer ${custName} (${custPhone || "N/A"}).`;
              for (const vJid of verifyTargets) {
                safeSendMessage(vJid, { text: refundAlert });
              }
            }
            res.writeHead(409);
            return res.end(JSON.stringify({
              success: false,
              code: "REFUND_REQUIRED",
              error: ogCommit.error,
              mpesa_code: cleanCode
            }));
          }
          if (!ogCommit.success && (ogCommit.code === "APPROVAL_REQUIRED" || ogCommit.code === "HOLD_NOT_RECOVERABLE")) {
            res.writeHead(409);
            return res.end(JSON.stringify({
              success: false,
              code: ogCommit.code,
              error: ogCommit.error
            }));
          }

          try {
            const filter = isPrimaryUUID ? `id=eq.${primaryId}` : `notes=eq.${orderId}`;
            const patchPayload = { status: "paid", internal_status: "PAID", mpesa_code: cleanCode };
            if (orderId && !/^[0-9a-f-]{36}$/i.test(orderId)) {
              patchPayload.notes = orderId;
            }
            await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}`, {
              method: "PATCH",
              headers: {
                "apikey": SERVICE_KEY,
                "Authorization": `Bearer ${SERVICE_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(patchPayload)
            });
            console.log(`[BACKEND SETTLEMENT] Order ${primaryId} (${orderId}) hardware-verified via Till Pool and promoted to PAID.`);
          } catch (dbErr) {
            console.error("[BACKEND DB ERROR]", dbErr.message);
          }
        }

        // 5. Sync with Perpetual Core (:5050) without triggering duplicate WhatsApp messages
        const resolvedShopSlug = matchedShop?.slug || tenantId || "creative-galore";
        try {
          const { httpRequest } = await import("./http_helpers.mjs");
          const roomOrderId = orderId || primaryId;
          await httpRequest("http://127.0.0.1:5050/api/orders/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              order_id: roomOrderId,
              shop_slug: resolvedShopSlug,
              customer_name: custName,
              customer_phone: custPhone,
              items: Array.isArray(items) ? items.map(i => ({ name: i.name, qty: i.quantity || i.qty || 1, price: i.price || 0 })) : [],
              total_amount: Number(amount) || 0,
              currency: "KES",
              notes: `[${matchedShop?.name || shopName || "Store"}] Pickup: ${pickup} | Hardware-Verified M-Pesa: ${cleanCode}`,
              skip_whatsapp_notify: true
            })
          });
        } catch (e) {}

        // 6. Broadcast unified Order + Payment Verified card to Shop Groups & Perpetual Main Groups
        if (safeSendMessage) {
          const verifyCard =
            `💰 *[ORDER PAID & TILL-POOL VERIFIED — ${storeLabel.toUpperCase()}]*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `• *Order:* ${refLabel}\n` +
            `• *Customer:* ${custName}${custPhone ? ` (${custPhone})` : ""}\n` +
            `• *Fulfillment:* ${pickup}\n` +
            `• *Amount Paid:* KES ${Number(amount || 0).toLocaleString()}\n` +
            `• *M-Pesa Ref:* \`${cleanCode}\` ✅ *(${hardwareVerifiedEntry ? "Confirmed in Till Pool" : "3-Factor Merchant SMS Verified"})*\n` +
            `• *Items:*\n${itemLines}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *Next Step:* Reply \`!pack ${shortUuid}\` to begin packaging.`;

          for (const vJid of verifyTargets) {
            safeSendMessage(vJid, { text: verifyCard });
          }
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          status: "PAID",
          isPaid: true,
          cleared: true,
          hardwareVerified: Boolean(hardwareVerifiedEntry),
          threeFactorSmsVerified: Boolean(threeFactorSmsVerified),
          paired: true,
          orderId: primaryId || orderId,
          code: cleanCode,
          pickupPin: String(Math.floor(1000 + Math.random() * 9000)),
          message: `Payment code ${cleanCode} verified.`
        }));
      } catch (err) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/order/status (Authoritative Edge & Database Status Check + Reverse Till Pool Lookback + Non-Clearable Guard)
    if (req.method === "GET" && parsedUrl.pathname === "/api/order/status") {
      const orderId = parsedUrl.searchParams.get("orderId");
      if (!orderId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: "Missing orderId" }));
      }
      try {
        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const hdrs = {
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json"
        };
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
        const filter = isUUID ? `id=eq.${orderId}` : `notes=eq.${orderId}`;
        const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}&select=id,shop_id,status,mpesa_code,total_price,client_name,client_phone,notes,created_at`, {
          headers: hdrs
        });
        const rows = await dbRes.json();
        let order = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

        // Guard 1: Order does not exist — never waste polling cycles
        if (!order) {
          res.writeHead(200);
          return res.end(JSON.stringify({
            success: true,
            orderId,
            status: "NOT_FOUND",
            isPaid: false,
            canAutoClear: false,
            terminal: true,
            reason: "Order record not found."
          }));
        }

        const statusLower = (order.status || "pending").toLowerCase();
        const paidStatuses = new Set(["paid", "preparing", "cooking", "packaging", "verified", "ready", "in_transit", "dispatched", "delivered", "completed"]);
        const terminalFailureStatuses = new Set(["cancelled", "rejected", "expired", "failed", "refunded"]);
        let isPaid = paidStatuses.has(statusLower);

        // Guard 2: Order is in a terminal failure/cancelled state — stop polling immediately
        if (terminalFailureStatuses.has(statusLower)) {
          res.writeHead(200);
          return res.end(JSON.stringify({
            success: true,
            orderId,
            status: order.status.toUpperCase(),
            isPaid: false,
            canAutoClear: false,
            terminal: true,
            reason: `Order is ${statusLower} and cannot be auto-cleared.`
          }));
        }

        // Guard 3: Stale order (> 30 minutes old and still unpaid) — cannot auto-clear via background window
        const nowMs = Date.now();
        const orderAgeMs = order.created_at ? (nowMs - new Date(order.created_at).getTime()) : 0;
        const maxAutoClearAgeMs = 30 * 60 * 1000;
        if (!isPaid && orderAgeMs > maxAutoClearAgeMs) {
          res.writeHead(200);
          return res.end(JSON.stringify({
            success: true,
            orderId,
            status: "EXPIRED",
            isPaid: false,
            canAutoClear: false,
            terminal: true,
            requiresCode: true,
            reason: "Background auto-verification window (30 mins) has elapsed. Please enter your 10-character M-Pesa code or alert the cashier."
          }));
        }

        let canAutoClear = true;
        let requiresCode = false;
        let stopReason = null;

        // Reverse Pool Lookback: If order is still PENDING, check till_receipt_pool.json (with mtimeMs memoization)
        if (!isPaid) {
          try {
            const fsMod = await import("fs");
            const pathMod = await import("path");
            const poolPath = pathMod.resolve(process.cwd(), "till_receipt_pool.json");
            if (fsMod.existsSync(poolPath)) {
              const stat = fsMod.statSync(poolPath);
              globalThis.__tillPoolCheckCache = globalThis.__tillPoolCheckCache || new Map();
              const lastCheckedMtime = globalThis.__tillPoolCheckCache.get(order.id);

              // Only parse disk file if till_receipt_pool.json has changed since we last checked this orderId
              if (lastCheckedMtime !== stat.mtimeMs) {
                const pool = JSON.parse(fsMod.readFileSync(poolPath, "utf-8") || "[]");
                const orderAmt = Number(order.total_price || 0);
                const orderPhoneSuffix = (order.client_phone || "").replace(/\D/g, "").slice(-9);
                const orderNameTokens = (order.client_name || "").toLowerCase().split(/\s+/).filter(t => t.length >= 3);
                const windowMs = (Number(process.env.TILL_MATCH_WINDOW_MINUTES) || 15) * 60 * 1000;

                const unclaimedMatches = pool.filter(r =>
                  r.direction !== "OUTFLOW" &&
                  (r.status === "UNCLAIMED_POOL" || r.status === "AMBIGUOUS") &&
                  Number(r.amount) === orderAmt &&
                  (!r.received_at || (nowMs - new Date(r.received_at).getTime()) <= maxAutoClearAgeMs)
                );

                // Priority 1: Phone suffix match
                let matchedReceipt = orderPhoneSuffix.length === 9
                  ? unclaimedMatches.find(r => (r.payer_phone || "").replace(/\D/g, "").slice(-9) === orderPhoneSuffix)
                  : null;
                // Priority 2: Registered Name token match
                if (!matchedReceipt && orderNameTokens.length > 0) {
                  matchedReceipt = unclaimedMatches.find(r => {
                    const pName = (r.payer_name || "").toLowerCase();
                    return orderNameTokens.some(tok => pName.includes(tok));
                  }) || null;
                }
                // Priority 3: Single fresh unclaimed receipt within 15-minute checkout window (only if NOT marked AMBIGUOUS by a multi-order collision)
                if (!matchedReceipt && unclaimedMatches.length === 1 && unclaimedMatches[0].status !== "AMBIGUOUS") {
                  const recAge = unclaimedMatches[0].received_at ? (nowMs - new Date(unclaimedMatches[0].received_at).getTime()) : 0;
                  if (recAge <= windowMs) {
                    matchedReceipt = unclaimedMatches[0];
                  }
                }

                if (matchedReceipt) {
                  matchedReceipt.status = "CLAIMED";
                  matchedReceipt.order_id = order.id;
                  fsMod.writeFileSync(poolPath, JSON.stringify(pool, null, 2), "utf-8");

                  const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                  const updatedNotes = order.notes
                    ? `${order.notes}\n• [${timeStr} TILL-LOOKBACK]: Auto-settled (${matchedReceipt.code} - ${matchedReceipt.payer_name})`
                    : `• [${timeStr} TILL-LOOKBACK]: Auto-settled (${matchedReceipt.code} - ${matchedReceipt.payer_name})`;

                  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
                    method: "PATCH",
                    headers: { ...hdrs, "Prefer": "return=minimal" },
                    body: JSON.stringify({
                      status: "paid",
                      internal_status: "PAID",
                      mpesa_code: matchedReceipt.code,
                      notes: updatedNotes
                    })
                  });
                  isPaid = true;
                  order = { ...order, status: "paid", mpesa_code: matchedReceipt.code };
                  globalThis.__tillPoolCheckCache.delete(order.id);
                } else if (unclaimedMatches.some(r => r.status === "AMBIGUOUS") || unclaimedMatches.length > 1) {
                  // Guard 4: Ambiguous collision (2+ orders/receipts of exact same amount & neither phone nor name matched)
                  // Background polling can NEVER disambiguate this without the 10-character M-Pesa code or staff command!
                  canAutoClear = false;
                  requiresCode = true;
                  stopReason = "We detected multiple KES " + orderAmt.toLocaleString() + " payments from a different phone number/name. Please enter your 10-character M-Pesa code to claim yours immediately.";
                } else {
                  globalThis.__tillPoolCheckCache.set(order.id, stat.mtimeMs);
                }
              }
            }
          } catch (_) {}
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          orderId,
          status: order ? order.status.toUpperCase() : "PENDING",
          isPaid,
          canAutoClear,
          requiresCode,
          reason: stopReason,
          mpesaCode: order?.mpesa_code || null
        }));
      } catch (err) {
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, orderId, status: "PENDING", isPaid: false, canAutoClear: true }));
      }
    }

    // =========================================================================
    // AUTONOMOUS TILL SIM SMS FORWARDER WEBHOOK (/api/till/receipt & /till-app)
    // =========================================================================
  return false;
}

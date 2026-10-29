/**
 * HTTP IPC Routes for WhatsApp Gateway
 * Handles targeted dispatches to the 3 Departmental Groups from room_server.
 */
import { parseJsonBody } from "./http_helpers.mjs";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";
import { getAllShops } from "./tenant_resolver.mjs";

export function createHttpRouter({ GROUPS, getConnectionState, getBotJid, safeSendMessage, getSock }) {
  return async function handleHttpRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // GET /api/all-participating
    if (req.method === "GET" && parsedUrl.pathname === "/api/all-participating") {
      try {
        const sock = getSock ? getSock() : null;
        if (!sock) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Socket not ready" }));
        }
        const allGroups = await sock.groupFetchAllParticipating();
        const list = Object.values(allGroups).map(g => ({
          id: g.id,
          subject: g.subject,
          owner: g.owner,
          creation: g.creation ? new Date(g.creation * 1000).toISOString() : null,
          participantsCount: g.participants ? g.participants.length : 0,
          isCommunity: Boolean(g.isCommunity),
          isCommunityAnnounce: Boolean(g.isCommunityAnnounce),
          linkedParent: g.linkedParent || null
        }));
        res.writeHead(200);
        return res.end(JSON.stringify({ count: list.length, groups: list }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/groups/create
    if (req.method === "POST" && parsedUrl.pathname === "/api/groups/create") {
      try {
        const sock = getSock ? getSock() : null;
        if (!sock) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Socket not ready" }));
        }
        const body = await parseJsonBody(req);
        const title = body.title || body.name;
        if (!title) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing title" }));
        }
        const participants = body.participants || [];
        const result = await sock.groupCreate(title, participants);
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, group: result }));
      } catch (err) {
        console.error("[GROUP CREATE ERROR]", err);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/shops/provision
    if (req.method === "POST" && parsedUrl.pathname === "/api/shops/provision") {
      try {
        const sock = getSock ? getSock() : null;
        const body = await parseJsonBody(req);
        const { name, slug, phone, owner_phone, currency = "KES", pipeline_type = "kitchen" } = body;

        if (!name || !slug) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing required fields: 'name' and 'slug'" }));
        }

        const contactPhone = owner_phone || phone || "";
        let participantJid = null;
        if (contactPhone) {
          const digits = contactPhone.replace(/\D/g, "");
          const cleanDigits = digits.startsWith("0") ? `254${digits.slice(1)}` : digits;
          if (cleanDigits.length >= 9) {
            participantJid = `${cleanDigits}@s.whatsapp.net`;
          }
        }
        const participants = participantJid ? [participantJid] : [];

        // 1. Check or Insert Shop in Supabase
        let shopRecord = null;
        const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?slug=eq.${slug}&select=*`, {
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          }
        });
        const existing = await existingRes.json();
        if (Array.isArray(existing) && existing.length > 0) {
          shopRecord = existing[0];
        } else {
          const createRes = await fetch(`${SUPABASE_URL}/rest/v1/shops`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=representation"
            },
            body: JSON.stringify({
              name,
              slug,
              phone: contactPhone,
              whatsapp_number: contactPhone,
              fulfillment_settings: {
                pipeline_type,
                currency
              }
            })
          });
          const created = await createRes.json();
          shopRecord = Array.isArray(created) ? created[0] : created;
        }

        // 2. Create WhatsApp Groups via Baileys if socket is active
        let operationsGroup = null;
        let managementGroup = null;
        let operationsInvite = null;
        let managementInvite = null;

        if (sock) {
          try {
            // Floor Operations Group
            operationsGroup = await sock.groupCreate(`${name} - Operations`, participants);
            try {
              const code = await sock.groupInviteCode(operationsGroup.id);
              operationsInvite = `https://chat.whatsapp.com/${code}`;
            } catch (e) {
              console.warn("[PROVISION] Could not get operations invite code:", e.message);
            }

            // Management Group
            managementGroup = await sock.groupCreate(`${name} - Management`, participants);
            try {
              const code = await sock.groupInviteCode(managementGroup.id);
              managementInvite = `https://chat.whatsapp.com/${code}`;
            } catch (e) {
              console.warn("[PROVISION] Could not get management invite code:", e.message);
            }

            // Send welcoming card to Operations group
            await safeSendMessage(operationsGroup.id, {
              text: `🏬 *Welcome to ${name} — Operations Hub!*\n\n` +
                    `This channel coordinates real-time order fulfillments and kitchen stations.\n\n` +
                    `*Staff Commands:*\n` +
                    `• *!orders* — View active order pipeline\n` +
                    `• *!paid <order_id> <ref>* — Confirm payment\n` +
                    `• *!cook <order_id>* — Mark cooking finished\n` +
                    `• *!pack <order_id>* — Box goods & food\n` +
                    `• *!dispatch <order_id> <rider>* — Hand off to courier\n\n` +
                    `_Live connected to TMS Whitelabel platform._`
            });

            // Send welcoming card to Management group
            await safeSendMessage(managementGroup.id, {
              text: `💼 *Welcome to ${name} — Management Oversight!*\n\n` +
                    `This channel receives daily sales pulses, executive summaries, and P&L rollups.\n\n` +
                    `*Manager Commands:*\n` +
                    `• *!summary* — Gross revenue & order counts\n` +
                    `• *!status* — Open orders & till status\n` +
                    `• *!product add* — Add new catalog product\n\n` +
                    `_All updates publish live to your TMS Storefront._`
            });
          } catch (grpErr) {
            console.error("[PROVISION] Error creating WhatsApp groups:", grpErr.message);
          }
        }

        // 3. Update Supabase Shop with WhatsApp Routing
        const currentSettings = shopRecord.fulfillment_settings || {};
        const updatedSettings = {
          ...currentSettings,
          whatsapp_routing: {
            ...(currentSettings.whatsapp_routing || {}),
            operations_jid: operationsGroup ? operationsGroup.id : (currentSettings.whatsapp_routing?.operations_jid || null),
            operations_invite: operationsInvite || (currentSettings.whatsapp_routing?.operations_invite || null),
            management_jid: managementGroup ? managementGroup.id : (currentSettings.whatsapp_routing?.management_jid || null),
            management_invite: managementInvite || (currentSettings.whatsapp_routing?.management_invite || null)
          }
        };

        if (shopRecord.id) {
          await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${shopRecord.id}`, {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              fulfillment_settings: updatedSettings
            })
          });
        }

        // Invalidate cache
        await getAllShops(true);

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          shop: {
            id: shopRecord.id,
            name: shopRecord.name || name,
            slug: shopRecord.slug || slug
          },
          whatsapp: {
            operations: {
              jid: operationsGroup ? operationsGroup.id : null,
              invite_url: operationsInvite
            },
            management: {
              jid: managementGroup ? managementGroup.id : null,
              invite_url: managementInvite
            }
          }
        }));
      } catch (err) {
        console.error("[SHOP PROVISION ERROR]", err);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /health
    if (req.method === "GET" && parsedUrl.pathname === "/health") {
      res.writeHead(200);
      return res.end(JSON.stringify({
        status: "ok",
        connection: getConnectionState(),
        bot_jid: getBotJid(),
        groups: {
          general: { name: GROUPS.general.name, jid: GROUPS.general.jid },
          itHelpdesk: { name: GROUPS.itHelpdesk.name, jid: GROUPS.itHelpdesk.jid },
          adminOversight: { name: GROUPS.adminOversight.name, jid: GROUPS.adminOversight.jid }
        }
      }));
    }

    // GET /groups
    if (req.method === "GET" && parsedUrl.pathname === "/groups") {
      res.writeHead(200);
      return res.end(JSON.stringify({ groups: GROUPS }));
    }

    // POST /api/notify-group (Direct card message to specific group key or direct JID)
    if (req.method === "POST" && parsedUrl.pathname === "/api/notify-group") {
      try {
        const body = await parseJsonBody(req);
        const directJid = body.jid || (typeof body.group === "string" && body.group.includes("@") ? body.group : null);
        const groupKey = body.group || "general";
        const targetGroup = GROUPS[groupKey] || GROUPS.general;
        const resolvedJid = directJid || targetGroup?.jid;

        if (!resolvedJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: `Group '${groupKey}' JID not resolved` }));
        }

        const msgText = body.message || body.text;
        if (!msgText) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing message text" }));
        }

        await safeSendMessage(resolvedJid, { text: msgText });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", group: groupKey, jid: resolvedJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/broadcast-task (General / Operations)
    if (req.method === "POST" && parsedUrl.pathname === "/api/broadcast-task") {
      try {
        const body = await parseJsonBody(req);
        const targetJid = GROUPS.general.jid;
        if (!targetJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "General group not bound" }));
        }

        const icon = body.status === "DONE" ? "✅" : body.status === "IN_PROGRESS" ? "🟣" : body.status === "CLAIMED" ? "🔵" : "🟡";
        const msg =
          `${icon} *[TASK UPDATE]* \`${body.task_id || "TASK"}\`\n` +
          `• *Title:* ${body.title || "Untitled"}\n` +
          `• *State:* ${body.status}\n` +
          `• *Scope:* Perpetua Shared Room`;

        await safeSendMessage(targetJid, { text: msg });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", jid: targetJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/broadcast-error (IT Helpdesk)
    if (req.method === "POST" && parsedUrl.pathname === "/api/broadcast-error") {
      try {
        const body = await parseJsonBody(req);
        const targetJid = GROUPS.itHelpdesk.jid;
        if (!targetJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "IT Helpdesk group not bound" }));
        }

        const msg =
          `🚨 *[IT INCIDENT ALERT]*\n` +
          `• *Error:* ${body.error_type || "RUNTIME_ERROR"}\n` +
          `• *Title:* ${body.title || "Unspecified"}\n` +
          (body.task_id ? `• *Task:* \`${body.task_id}\`\n` : "") +
          `• *Trace:* \`${body.error_details || "No trace"}\`\n` +
          `_Desk: Use !ticket or !resolve to track._`;

        await safeSendMessage(targetJid, { text: msg });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", jid: targetJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/broadcast-admin (Admin Oversight)
    if (req.method === "POST" && parsedUrl.pathname === "/api/broadcast-admin") {
      try {
        const body = await parseJsonBody(req);
        const targetJid = GROUPS.adminOversight.jid;
        if (!targetJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Admin group not bound" }));
        }

        const msg =
          `📊 *[ADMIN AUDIT]*\n` +
          `• *Action:* ${body.action}\n` +
          `• *Actor:* ${body.actor || "SYSTEM"}\n` +
          (body.task_id ? `• *Task:* \`${body.task_id}\`\n` : "") +
          `• *Time:* ${new Date().toISOString()}`;

        await safeSendMessage(targetJid, { text: msg });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", jid: targetJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /order (TMS Whitelabel Core Order Ingress Bridge)
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
        const pickup = customer.address || customer.fulfillmentType || meta.deliveryAddress || meta.fulfillmentType || "In-Store Pickup";

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
                notes: `[${matchedShop?.name || shopTitle}] Pickup: ${pickup}`,
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
        const card =
          `🛍️ *[NEW STOREFRONT ORDER]* \`${orderId}\`\n` +
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
        return res.end(JSON.stringify({ status: "ingested", order_id: orderId }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

// POST /api/order/verify-payment & /api/v1/orders/verify-payment
    if (req.method === "POST" && (parsedUrl.pathname === "/api/order/verify-payment" || parsedUrl.pathname === "/api/v1/orders/verify-payment")) {
      try {
        const body = await parseJsonBody(req);
        const { orderId, supabaseId, tenantId, shopName, code, amount, customer, items, targetGroupJid } = body;
        const primaryId = supabaseId || orderId;
        console.log(`[PAYMENT VERIFICATION] Order ${orderId} (DB: ${primaryId}) | Code ${code} | KES ${amount}`);

        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const cleanCode = (code || "").trim().toUpperCase();

        // 1. Boundary Regex Validation (Stage 2 Zero-Trust Perimeter)
        if (!/^[A-Z0-9]{10}$/.test(cleanCode)) {
          res.writeHead(422);
          return res.end(JSON.stringify({
            code: "SCHEMA_VALIDATION_ERROR",
            error: "M-Pesa transaction reference must be exactly 10 alphanumeric characters (e.g. SHK89271KJ)."
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

        // 4. Authoritative Backend Settlement: Mark order as PAID in Supabase
        if (primaryId) {
          try {
            const filter = isPrimaryUUID ? `id=eq.${primaryId}` : `notes=eq.${orderId}`;
            const patchPayload = { status: "paid", mpesa_code: cleanCode };
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
            console.log(`[BACKEND SETTLEMENT] Order ${primaryId} (${orderId}) promoted to PAID in Supabase.`);
          } catch (dbErr) {
            console.error("[BACKEND DB ERROR]", dbErr.message);
          }
        }

        // 5. Sync with Perpetual Core (:5050) without triggering duplicate WhatsApp messages
        const resolvedShopSlug = matchedShop?.slug || tenantId || "creative-galore";
        const custName = customer?.name || "Customer";
        const custPhone = customer?.phone || "";
        const pickup = customer?.address || customer?.fulfillmentType || "In-Store Pickup";
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
              notes: `[${matchedShop?.name || shopName || "Store"}] Pickup: ${pickup} | M-Pesa: ${cleanCode}`,
              skip_whatsapp_notify: true
            })
          });
        } catch (e) {}

        // 6. Broadcast unified Order + Payment Verified card to Shop Groups & Perpetual Main Groups
        if (safeSendMessage) {
          const itemLines = Array.isArray(items) && items.length > 0
            ? items.map(i => `  • ${i.quantity || i.qty || 1}x *${i.name}*`).join("\n")
            : "  • Order Items";
          const shortUuid = primaryId ? String(primaryId).slice(0, 8).toUpperCase() : (orderId || "").slice(0, 8).toUpperCase();
          const refLabel = (orderId && orderId !== primaryId) ? `#${shortUuid} (\`${orderId}\`)` : `#${shortUuid}`;
          const storeLabel = matchedShop?.name || shopName || "Storefront";

          const verifyCard =
            `💰 *[ORDER PAID & VERIFIED — ${storeLabel.toUpperCase()}]*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `• *Order:* ${refLabel}\n` +
            `• *Customer:* ${custName}${custPhone ? ` (${custPhone})` : ""}\n` +
            `• *Fulfillment:* ${pickup}\n` +
            `• *Amount Paid:* KES ${Number(amount || 0).toLocaleString()}\n` +
            `• *M-Pesa Ref:* \`${cleanCode}\` ✅\n` +
            `• *Items:*\n${itemLines}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *Next Step:* Reply \`!pack ${shortUuid}\` to begin packaging.`;

          let resolvedOpsJid = matchedShop?.fulfillment_settings?.whatsapp_routing?.operations_jid || targetGroupJid;
          let resolvedMgmtJid = matchedShop?.fulfillment_settings?.whatsapp_routing?.management_jid || null;

          const verifyTargets = new Set([
            GROUPS?.general?.jid || "120363429929736148@g.us",
            GROUPS?.adminOversight?.jid || "120363415291701803@g.us",
            resolvedOpsJid,
            resolvedMgmtJid
          ].filter(Boolean));
          for (const vJid of verifyTargets) {
            safeSendMessage(vJid, { text: verifyCard });
          }
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          status: "PAID",
          paired: true,
          orderId: primaryId || orderId,
          code: cleanCode,
          pickupPin: String(Math.floor(1000 + Math.random() * 9000)),
          message: `Payment code ${cleanCode} registered and verified.`
        }));
      } catch (err) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/order/status (Authoritative Edge & Database Status Check)
    if (req.method === "GET" && parsedUrl.pathname === "/api/order/status") {
      const orderId = parsedUrl.searchParams.get("orderId");
      if (!orderId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: "Missing orderId" }));
      }
      try {
        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
        const filter = isUUID ? `id=eq.${orderId}` : `notes=eq.${orderId}`;
        const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}&select=id,status,mpesa_code`, {
          headers: {
            "apikey": SERVICE_KEY,
            "Authorization": `Bearer ${SERVICE_KEY}`
          }
        });
        const rows = await dbRes.json();
        const order = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
        const paidStatuses = new Set(["paid", "preparing", "cooking", "packaging", "verified", "ready", "in_transit", "dispatched", "delivered", "completed"]);
        const isPaid = Boolean(order?.status && paidStatuses.has(order.status.toLowerCase()));
        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          orderId,
          status: order ? order.status.toUpperCase() : "PENDING",
          isPaid,
          mpesaCode: order?.mpesa_code || null
        }));
      } catch (err) {
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, orderId, status: "PENDING", isPaid: false }));
      }
    }


    // =========================================================================
    // BLACKBOXED STOREFRONT & ORDER API (Stage 5 API Layer)
    // =========================================================================

    // 1. GET /api/v1/storefront/:slug/catalog
    const storefrontCatalogMatch = parsedUrl.pathname.match(/^\/api\/v1\/storefront\/([^\/]+)\/catalog$/);
    if (req.method === "GET" && storefrontCatalogMatch) {
      const slug = storefrontCatalogMatch[1];
      try {
        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const hdrs = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };

        // Fetch shop
        const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?slug=eq.${slug}&select=id,name,slug,phone,whatsapp_number,mpesa_till_number,logo_url,tagline,operating_hours,appearance_config,fulfillment_settings,operational_region`, { headers: hdrs });
        const shops = await shopRes.json();
        if (!shops || shops.length === 0) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: "Shop not found" }));
        }
        const shop = shops[0];
        const shopId = shop.id;

        // Fetch active menu items & active promotions in parallel
        const [itemsRes, promoRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shopId}&is_active=eq.true&select=id,name,description,price,category,image_url,is_active,attributes`, { headers: hdrs }),
          fetch(`${SUPABASE_URL}/rest/v1/promotions?shop_id=eq.${shopId}&is_active=eq.true&select=id,name,description,discount_type,discount_value,min_items,bundle_price`, { headers: hdrs })
        ]);

        const items = await itemsRes.json();
        const promotions = await promoRes.json();
        const categories = Array.from(new Set((items || []).map(i => i.category).filter(Boolean))).sort();

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          shop,
          categories,
          items: items || [],
          promotions: promotions || []
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2. POST /api/v1/storefront/quote (Pure Server-Side Pricing Engine)
    if (req.method === "POST" && parsedUrl.pathname === "/api/v1/storefront/quote") {
      try {
        const body = await parseJsonBody(req);
        const { shop_id, items, fulfillment_type, coupon_code } = body;
        if (!shop_id || !Array.isArray(items) || items.length === 0) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Invalid quote request: shop_id and items are required." }));
        }

        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const hdrs = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };

        // Fetch actual prices from menu_items to prevent client price tampering
        const itemIds = items.map(i => i.id).filter(Boolean);
        const itemRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?id=in.(${itemIds.join(",")})&select=id,name,price`, { headers: hdrs });
        const dbItems = await itemRes.json();
        const priceMap = new Map((dbItems || []).map(i => [i.id, i]));

        let grossSubtotal = 0;
        const evaluatedItems = [];
        for (const it of items) {
          const dbItem = priceMap.get(it.id);
          const unitPrice = dbItem ? Number(dbItem.price) : 0;
          const qty = Number(it.quantity) || 1;
          grossSubtotal += (unitPrice * qty);
          evaluatedItems.append ? evaluatedItems.append(it) : evaluatedItems.push({
            id: it.id,
            name: dbItem ? dbItem.name : "Item",
            unit_price: unitPrice,
            quantity: qty,
            line_total: unitPrice * qty
          });
        }

        // Evaluate delivery fee if fulfillment_type === 'delivery'
        let deliveryFee = 0;
        if (fulfillment_type === "delivery") {
          const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${shop_id}&select=operational_region`, { headers: hdrs });
          const shopRows = await shopRes.json();
          const region = shopRows?.[0]?.operational_region || "Nairobi";
          const logRes = await fetch(`${SUPABASE_URL}/rest/v1/system_logistics_config?region_name=eq.${region}&is_active=eq.true&select=flat_delivery_fee`, { headers: hdrs });
          const logRows = await logRes.json();
          if (logRows?.[0]?.flat_delivery_fee) {
            deliveryFee = Number(logRows[0].flat_delivery_fee);
          } else {
            deliveryFee = 150; // Standard Nairobi default
          }
        }

        // Evaluate coupon / promotion
        let discount = 0;
        if (coupon_code) {
          const promoRes = await fetch(`${SUPABASE_URL}/rest/v1/promotions?shop_id=eq.${shop_id}&is_active=eq.true&select=*`, { headers: hdrs });
          const promos = await promoRes.json();
          const matchedPromo = (promos || []).find(p => (p.name || "").toLowerCase() === coupon_code.toLowerCase().trim());
          if (matchedPromo) {
            if (matchedPromo.discount_type === "percent") {
              discount = (grossSubtotal * Number(matchedPromo.discount_value || 0)) / 100;
            } else if (matchedPromo.discount_type === "flat") {
              discount = Math.min(grossSubtotal, Number(matchedPromo.discount_value || 0));
            }
          }
        }

        const totalPayable = Math.max(0, grossSubtotal - discount + deliveryFee);

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          subtotal: grossSubtotal,
          discount,
          delivery_fee: deliveryFee,
          total_payable: totalPayable,
          items: evaluatedItems
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 3. POST /api/v1/merchant/orders/:id/advance (FSM Transition Guard)
    const advanceMatch = parsedUrl.pathname.match(/^\/api\/v1\/merchant\/orders\/([^\/]+)\/advance$/);
    if (req.method === "POST" && advanceMatch) {
      const orderId = advanceMatch[1];
      try {
        const body = await parseJsonBody(req);
        const { target_station, actor_name, notes } = body;
        const normalizedTarget = (target_station || "").toLowerCase().trim();

        const STATION_TRANSITIONS = {
          pending: ["paid", "cancelled"],
          paid: ["preparing", "cancelled"],
          preparing: ["ready", "cancelled"],
          ready: ["dispatched", "completed"],
          dispatched: ["completed"],
          completed: [],
          cancelled: []
        };

        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
        const filter = isUUID ? `id=eq.${orderId}` : `notes=eq.${orderId}`;

        const ordRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}&select=id,status`, {
          headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` }
        });
        const orders = await ordRes.json();
        if (!orders || orders.length === 0) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: "Order not found" }));
        }

        const currentStation = (orders[0].status || "pending").toLowerCase();
        const allowed = STATION_TRANSITIONS[currentStation] || [];

        if (!allowed.includes(normalizedTarget)) {
          res.writeHead(400);
          return res.end(JSON.stringify({
            code: "ILLEGAL_STATION_TRANSITION",
            error: `Cannot advance order from '${currentStation}' to '${normalizedTarget}'. Allowed next stations: [${allowed.join(", ")}]`
          }));
        }

        // Commit station update in Supabase
        const fullOrdRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orders[0].id}`, {
          method: "PATCH",
          headers: {
            "apikey": SERVICE_KEY,
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify({ status: normalizedTarget })
        });
        const updatedRows = await fullOrdRes.json().catch(() => []);
        const updatedOrd = updatedRows?.[0] || orders[0];

        // Broadcast station advance to Shop Group AND Perpetual Main Group
        if (safeSendMessage) {
          try {
            const allShops = await getAllShops();
            const shop = allShops.find(s => s.id === updatedOrd.shop_id);
            const routing = shop?.fulfillment_settings?.whatsapp_routing || {};
            const advCard =
              `🔄 *[ORDER STATION ADVANCED — ${(shop?.name || "STORE").toUpperCase()}]*\n` +
              `• *Order:* #${(updatedOrd.id || "").slice(0, 8).toUpperCase()}\n` +
              `• *Transition:* \`${currentStation.toUpperCase()}\` ➡️ *\`${normalizedTarget.toUpperCase()}\`*\n` +
              `• *Customer:* ${updatedOrd.client_name || "Customer"}\n` +
              `• *Total:* KES ${Number(updatedOrd.total_price || 0).toLocaleString()}\n` +
              `• *Actor:* ${actor_name || "Merchant"}`;

            const advTargets = new Set([
              GROUPS?.general?.jid || "120363429929736148@g.us",
              routing.operations_jid,
              (normalizedTarget === "completed" || normalizedTarget === "cancelled" || normalizedTarget === "dispatched")
                ? (GROUPS?.adminOversight?.jid || "120363415291701803@g.us")
                : null,
              (normalizedTarget === "completed" || normalizedTarget === "cancelled")
                ? routing.management_jid
                : null
            ].filter(Boolean));

            for (const tJid of advTargets) {
              safeSendMessage(tJid, { text: advCard });
            }
          } catch (e) {
            console.warn("[ADVANCE BROADCAST WARN]", e.message);
          }
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          order_id: orders[0].id,
          previous_station: currentStation,
          current_station: normalizedTarget,
          actor: actor_name || "Merchant"
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Fallback 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  };
}

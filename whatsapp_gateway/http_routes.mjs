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

    // GET / (Root Gateway Dashboard)
    if (req.method === "GET" && (parsedUrl.pathname === "/" || parsedUrl.pathname === "")) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      return res.end(JSON.stringify({
        service: "TMS WhatsApp Operations Gateway",
        status: "active",
        port: 5174,
        health: "http://127.0.0.1:5174/health",
        groups: "http://127.0.0.1:5174/groups"
      }, null, 2));
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

        // 3. Update Supabase Shop with Complete Self-Contained Configuration & WhatsApp Routing
        const currentSettings = shopRecord.fulfillment_settings || {};
        const isFoodPipeline = pipeline_type === "kitchen" || body.industry_type === "food" || body.industry_type === "restaurant";
        const defaultStations = isFoodPipeline
          ? [
              { id: "pending_payment", label: "Awaiting Payment", icon: "⏳", notify_customer: false, notify_ops: true, command_triggers: [] },
              { id: "confirmed", label: "Order Confirmed", icon: "✅", notify_customer: true, notify_ops: true, command_triggers: ["!paid", "!confirm"] },
              { id: "cooking", label: "In Kitchen", icon: "🍳", notify_customer: true, notify_ops: false, command_triggers: ["!cook", "!prep", "!kitchen"] },
              { id: "packed", label: "Packed & Boxed", icon: "🥡", notify_customer: true, notify_ops: true, command_triggers: ["!pack", "!ready"] },
              { id: "out_for_delivery", label: "Out for Delivery", icon: "🛵", notify_customer: true, notify_ops: true, command_triggers: ["!dispatch", "!deliver"] },
              { id: "completed", label: "Delivered", icon: "🎉", notify_customer: true, notify_ops: false, command_triggers: ["!done", "!complete"] }
            ]
          : [
              { id: "pending_payment", label: "Awaiting Payment", icon: "⏳", notify_customer: false, notify_ops: true, command_triggers: [] },
              { id: "confirmed", label: "Order Confirmed", icon: "✅", notify_customer: true, notify_ops: true, command_triggers: ["!paid", "!confirm"] },
              { id: "picking", label: "Picking Items", icon: "🪡", notify_customer: true, notify_ops: false, command_triggers: ["!pick", "!prepare"] },
              { id: "packed", label: "Packed & Boxed", icon: "📦", notify_customer: true, notify_ops: true, command_triggers: ["!pack", "!ready"] },
              { id: "dispatched", label: "Out for Delivery", icon: "🛵", notify_customer: true, notify_ops: true, command_triggers: ["!dispatch", "!deliver"] },
              { id: "completed", label: "Delivered", icon: "🎉", notify_customer: true, notify_ops: false, command_triggers: ["!done", "!complete"] }
            ];

        const orderPrefix = body.order_prefix || currentSettings.whatsapp_routing?.order_prefix || slug.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || "TMS";
        const isPreorder = Boolean(body.is_preorder ?? currentSettings.is_preorder ?? false);
        const pickupPoints = Array.isArray(body.pickup_points)
          ? body.pickup_points
          : (Array.isArray(currentSettings.pickup_points) ? currentSettings.pickup_points : []);

        const updatedSettings = {
          ...currentSettings,
          currency,
          pipeline_type,
          is_preorder: isPreorder,
          preorder_mode: isPreorder,
          cutoff_time: body.cutoff_time || currentSettings.cutoff_time || (isPreorder ? "17:00" : null),
          accepts_pickup: body.accepts_pickup ?? currentSettings.accepts_pickup ?? true,
          accepts_delivery: body.accepts_delivery ?? currentSettings.accepts_delivery ?? true,
          accepts_dine_in: body.accepts_dine_in ?? currentSettings.accepts_dine_in ?? isFoodPipeline,
          accepts_pickup_point: body.accepts_pickup_point ?? currentSettings.accepts_pickup_point ?? (pickupPoints.length > 0),
          pickup_points: pickupPoints,
          pipeline_stations: (Array.isArray(currentSettings.pipeline_stations) && currentSettings.pipeline_stations.length > 0)
            ? currentSettings.pipeline_stations
            : defaultStations,
          whatsapp_routing: {
            ...(currentSettings.whatsapp_routing || {}),
            order_prefix: orderPrefix,
            operations_jid: operationsGroup ? operationsGroup.id : (body.operations_jid || currentSettings.whatsapp_routing?.operations_jid || null),
            operations_invite: operationsInvite || (currentSettings.whatsapp_routing?.operations_invite || null),
            management_jid: managementGroup ? managementGroup.id : (body.management_jid || currentSettings.whatsapp_routing?.management_jid || null),
            management_invite: managementInvite || (currentSettings.whatsapp_routing?.management_invite || null),
            community_jid: body.community_jid || currentSettings.whatsapp_routing?.community_jid || null
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
              fulfillment_settings: updatedSettings,
              mpesa_till_number: body.mpesa_till_number || shopRecord.mpesa_till_number || "5758419"
            })
          });
        }

        // 4. Write local config/shops/<slug>.json so room_server (:5050) has immediate pipeline parity
        try {
          const fsMod = await import("fs");
          const pathMod = await import("path");
          const configDir = pathMod.resolve(process.cwd(), "..", "config", "shops");
          if (fsMod.existsSync(configDir)) {
            const localShopJson = {
              shop_id: shopRecord.id,
              shop_slug: slug,
              shop_name: name,
              order_prefix: orderPrefix,
              brand: {
                tagline: shopRecord.tagline || `${name} Storefront`,
                currency,
                support_phone: contactPhone,
                mpesa_till: body.mpesa_till_number || shopRecord.mpesa_till_number || "5758419"
              },
              whatsapp_groups: {
                operations_jid: updatedSettings.whatsapp_routing.operations_jid,
                admin_oversight_jid: updatedSettings.whatsapp_routing.management_jid,
                community_jid: updatedSettings.whatsapp_routing.community_jid
              },
              fulfillment: {
                accepts_pickup: updatedSettings.accepts_pickup,
                accepts_delivery: updatedSettings.accepts_delivery,
                accepts_dine_in: updatedSettings.accepts_dine_in,
                accepts_pickup_point: updatedSettings.accepts_pickup_point,
                pickup_points: updatedSettings.pickup_points,
                preorder_cutoff_hour: updatedSettings.is_preorder ? 17 : null
              },
              pipeline: {
                stations: updatedSettings.pipeline_stations
              }
            };
            fsMod.writeFileSync(pathMod.join(configDir, `${slug}.json`), JSON.stringify(localShopJson, null, 2), "utf-8");
          }
        } catch (cfgErr) {
          console.warn("[PROVISION] Local config sync warning:", cfgErr.message);
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

    // POST /api/eod-report (Trigger Live End-of-Day Multi-Tenant Register Reconciliation)
    if ((req.method === "POST" || req.method === "GET") && parsedUrl.pathname === "/api/eod-report") {
      try {
        let body = {};
        if (req.method === "POST") {
          try { body = await parseJsonBody(req); } catch (ignored) {}
        }
        const mode = body.mode || parsedUrl.searchParams.get("mode") || (body.shop || parsedUrl.searchParams.get("shop") ? "shop" : "dual");
        const shopSlug = body.shop || parsedUrl.searchParams.get("shop") || "test-shop";
        const sendToWhatsApp = body.dispatch !== false && parsedUrl.searchParams.get("dispatch") !== "false";

        const {
          generateShopEODReport,
          generatePlatformEODReport,
          runFullDualEODReconciliation
        } = await import("./eod_reconciler.mjs");

        if (mode === "platform") {
          const report = await generatePlatformEODReport();
          let dispatched = false;
          if (sendToWhatsApp) {
            const platformJid = GROUPS.adminOversight?.jid || "120363415291701803@g.us";
            await safeSendMessage(platformJid, { text: report.formattedWhatsAppMessage });
            dispatched = true;
          }
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, mode: "platform", report, dispatched }, null, 2));
        }

        if (mode === "shop") {
          const report = await generateShopEODReport(shopSlug);
          let dispatched = false;
          if (sendToWhatsApp) {
            const targetJid = report.targetJid || GROUPS.adminOversight?.jid;
            if (targetJid) {
              await safeSendMessage(targetJid, { text: report.formattedWhatsAppMessage });
              dispatched = true;
            }
          }
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, mode: "shop", shop: shopSlug, report, dispatched }, null, 2));
        }

        // Default: Full Dual Reconciliation (Each active shop receives their report + platform rollup to community)
        const result = await runFullDualEODReconciliation({
          dispatch: sendToWhatsApp,
          sendFn: safeSendMessage
        });

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          mode: "dual",
          platformReport: result.platformReport,
          activeShopsCount: result.shopReports.length,
          shopReports: result.shopReports,
          dispatchResults: result.dispatchResults
        }, null, 2));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, error: err.message }));
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

    // POST /order (TMS Whitelabel Core Order Ingress Bridge + Instant Pre-Paid Till Pool Lookback)
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
        if (primaryId) {
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
    if ((req.method === "POST" || req.method === "GET") && (parsedUrl.pathname === "/api/till/receipt" || parsedUrl.pathname === "/api/sms-webhook")) {
      const traceSteps = [];
      const traceStart = Date.now();
      const addTrace = (step, detail) => {
        const elapsed = `${Date.now() - traceStart}ms`;
        const entry = `[+${elapsed}] ${step}: ${detail}`;
        traceSteps.push(entry);
        console.log(`[TILL TRACE] ${entry}`);
      };
      const flushTraceLog = async (finalPayload) => {
        try {
          const fsMod = await import("fs");
          const pathMod = await import("path");
          const tracePath = pathMod.resolve(process.cwd(), "till_server_trace.log");
          const block = [
            `====================================================================`,
            `TIMESTAMP: ${new Date().toISOString()} | CLIENT IP: ${req.socket?.remoteAddress || "unknown"}`,
            ...traceSteps,
            `FINAL SERVER JSON RESPONSE:\n${JSON.stringify(finalPayload, null, 2)}`,
            `====================================================================\n`
          ].join("\n");
          fsMod.appendFileSync(tracePath, block, "utf-8");
        } catch (_) {}
      };

      try {
        let rawSms = "";
        let simSlot = "TILL_SIM";
        let senderAddr = "MPESA";

        if (req.method === "GET") {
          rawSms = parsedUrl.searchParams.get("text") || parsedUrl.searchParams.get("msg") || parsedUrl.searchParams.get("sms") || "";
          simSlot = parsedUrl.searchParams.get("sim") || "TILL_SIM";
          senderAddr = parsedUrl.searchParams.get("from") || "MPESA";
        } else {
          const body = await parseJsonBody(req).catch(() => ({}));
          rawSms = body.text || body.msg || body.sms || body.message || body.body || body.content || (typeof body === "string" ? body : "");
          simSlot = body.sim || body.sim_slot || body.sub_id || "TILL_SIM";
          senderAddr = body.from || body.sender || "MPESA";
        }

        const cleanSms = String(rawSms || "").trim();
        addTrace("STEP 1 (HTTP INBOUND)", `Method=${req.method} | Sender=${senderAddr} | SIM=${simSlot} | Raw="${cleanSms}"`);

        if (!cleanSms) {
          const out = { success: false, error: "Empty SMS payload", trace: traceSteps };
          await flushTraceLog(out);
          res.writeHead(400);
          return res.end(JSON.stringify(out));
        }

        // Source-of-Truth Perimeter Guard:
        // If a request to /api/till/receipt is tagged as coming from a CLIENT (not our SIM forwarder),
        // NEVER allow it to update our Personal Finance ledger or our Till Receipt Pool!
        if (/client|customer|storefront/i.test(simSlot) || /client|customer/i.test(senderAddr)) {
          addTrace("STEP 1B (SOURCE OF TRUTH BLOCK)", `Blocked UNTRUSTED_CLIENT_CLAIM on hardware forwarder endpoint (SIM=${simSlot})`);
          const out = {
            success: false,
            source_of_truth: "UNTRUSTED_CLIENT_CLAIM",
            error: "Client-submitted messages cannot be sent to the Hardware Till SIM Forwarder endpoint. Use /api/order/verify-payment instead.",
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(403);
          return res.end(JSON.stringify(out));
        }

        // Check if this is a Personal Expense / Bank / Okoa SMS vs. a Business Till Receipt
        const { parseFinancialSms, savePersonalTransaction, computeFinancialReport } = await import("./finance_engine.mjs");
        const finParsed = parseFinancialSms(cleanSms, senderAddr, Date.now());
        if (finParsed && !finParsed.is_business_till) {
          const saveRes = savePersonalTransaction(finParsed);
          addTrace(
            "STEP 2 (PERSONAL FINANCE ROUTER)",
            `Classified as ${finParsed.tx_type} [${finParsed.category}] -> KES ${finParsed.amount} (${finParsed.counterparty}) | Saved=${saveRes.saved}`
          );
          const out = {
            success: true,
            source_of_truth: "HARDWARE_SIM_FORWARDER",
            routed_to: "PERSONAL_FINANCE_LEDGER",
            duplicate: Boolean(saveRes.duplicate),
            transaction: finParsed,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        // Parse M-Pesa Till Companion SMS (Inflow OR Outflow/Withdrawal)
        // NOTE: Strictly extract ONLY Merchant Till balances (Account/Utility/Working Account), NEVER a personal "M-PESA balance"!
        const codeMatch = cleanSms.match(/\b([A-Z0-9]{10})\b\s*Confirmed/i) || cleanSms.match(/\b([A-Z0-9]{10})\b/);
        const amountMatch = cleanSms.match(/(?:Withdraw\s+)?(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+(?:received|paid|sent|withdrawn|from|transferred)/i) ||
                            cleanSms.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
        const partyMatch = cleanSms.match(/received\s+from\s+(?:(\+?\d{9,13})\s+)?([A-Z\s.'-]+?)(?:\.\s+New|\.\s+Account|$)/i);
        const outPartyMatch = cleanSms.match(/(?:sent\s+to|paid\s+to|from|transferred\s+to)\s+(.+?)(?:\s+on\s+\d|\.\s*on\s+|\.\s*New|\s+New\s+|$)/i);
        const balMatch = cleanSms.match(/New\s+(?:Account|Utility|Working(?:\s+Account)?)\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
        const feeMatch = cleanSms.match(/Transaction\s+cost,?\s*(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);

        if (!codeMatch || !amountMatch) {
          addTrace("STEP 2 (REGEX PARSE)", "Failed to extract M-Pesa 10-char code or KES amount -> Ignored non-receipt SMS");
          const out = {
            success: true,
            ignored: true,
            reason: "Not a valid M-Pesa confirmation receipt",
            raw_received: cleanSms,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        const mpesaCode = codeMatch[1].toUpperCase();
        const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
        const fee = feeMatch ? parseFloat(feeMatch[1].replace(/,/g, "")) : 0;
        const reportedBalance = balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : null;
        const isTillOutflow = finParsed?.direction === "TILL_OUTFLOW" ||
          (!(/received\s+from/i.test(cleanSms)) && /(?:sent\s+to|paid\s+to|withdrawn|Withdraw|transferred)/i.test(cleanSms));
        const direction = isTillOutflow ? "OUTFLOW" : "INFLOW";

        let payerPhone = partyMatch?.[1] ? partyMatch[1].trim() : (finParsed?.phone || null);
        let payerName = partyMatch?.[2]
          ? partyMatch[2].trim()
          : (finParsed?.counterparty || (outPartyMatch?.[1] ? outPartyMatch[1].trim() : "Customer"));

        addTrace(
          "STEP 2 (REGEX PARSE)",
          `Extracted Code=${mpesaCode} | Direction=${direction} | Amount=KES ${amount} | Fee=KES ${fee} | Balance=${reportedBalance !== null ? `KES ${reportedBalance}` : "N/A"} | Counterparty="${payerName}" (${payerPhone || "no-phone"})`
        );

        // Helper to load pool and compute running balance variance against prior Till entry
        const fsMod = await import("fs");
        const pathMod = await import("path");
        const poolPath = pathMod.resolve(process.cwd(), "till_receipt_pool.json");
        let pool = [];
        try {
          if (fsMod.existsSync(poolPath)) {
            pool = JSON.parse(fsMod.readFileSync(poolPath, "utf-8") || "[]");
          }
        } catch (_) {}

        // Find the most recent prior entry with a reported_balance (from the same SIM/Till context)
        const priorWithBal = pool.find(x => x.code !== mpesaCode && typeof x.reported_balance === "number");
        const previousBalance = priorWithBal ? priorWithBal.reported_balance : null;
        let expectedBalance = null;
        let balanceVariance = 0;
        if (previousBalance !== null && reportedBalance !== null) {
          expectedBalance = direction === "INFLOW"
            ? Math.round((previousBalance + amount - fee) * 100) / 100
            : Math.round((previousBalance - amount - fee) * 100) / 100;
          balanceVariance = Math.round((reportedBalance - expectedBalance) * 100) / 100;
          addTrace(
            "STEP 2B (VARIANCE AUDIT)",
            `PrevBal=KES ${previousBalance} | Expected=KES ${expectedBalance} | SafaricomReported=KES ${reportedBalance} | Variance=KES ${balanceVariance}`
          );
        }

        // Handle TILL OUTFLOW (When money is withdrawn/sent out of the Till)
        if (direction === "OUTFLOW") {
          const existingOut = pool.find(x => x.code === mpesaCode);
          if (!existingOut) {
            pool.unshift({
              code: mpesaCode,
              direction: "OUTFLOW",
              amount,
              fee,
              reported_balance: reportedBalance,
              previous_balance: previousBalance,
              expected_balance: expectedBalance,
              balance_variance: balanceVariance,
              payer_phone: payerPhone,
              payer_name: payerName,
              sim_slot: simSlot,
              raw_sms: cleanSms,
              status: "TILL_OUTFLOW",
              order_id: null,
              received_at: new Date().toISOString()
            });
            fsMod.writeFileSync(poolPath, JSON.stringify(pool.slice(0, 500), null, 2), "utf-8");
          }
          addTrace("STEP 3 (TILL OUTFLOW LOGGED)", `Recorded Till Outflow of KES ${amount} (+Fee KES ${fee}) to "${payerName}"`);

          if (safeSendMessage) {
            const mgmtJid = GROUPS?.adminOversight?.jid || GROUPS?.general?.jid;
            if (mgmtJid) {
              const outCard =
                `📤 *[TILL OUTFLOW / WITHDRAWAL LOGGED]*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `• *Ref:* \`${mpesaCode}\`\n` +
                `• *Sent / Withdrawn:* KES ${Number(amount).toLocaleString()}\n` +
                `• *Transaction Fee:* KES ${Number(fee).toLocaleString()}\n` +
                `• *Destination:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
                (reportedBalance !== null ? `• *New Till Balance:* KES ${Number(reportedBalance).toLocaleString()}\n` : "") +
                (balanceVariance !== 0 ? `⚠️ *Balance Variance:* KES ${balanceVariance > 0 ? `+${balanceVariance}` : balanceVariance}\n` : `✅ *Variance Check:* KES 0.00 (Exact)\n`) +
                `━━━━━━━━━━━━━━━━━━━━━━`;
              safeSendMessage(mgmtJid, { text: outCard });
            }
          }

          const out = {
            success: true,
            status: "TILL_OUTFLOW",
            direction: "OUTFLOW",
            mpesa_code: mpesaCode,
            amount,
            fee,
            reported_balance: reportedBalance,
            expected_balance: expectedBalance,
            balance_variance: balanceVariance,
            destination: payerName,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const hdrs = {
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json"
        };

        // 1. Single-Use Deduplication Check
        const dupRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?mpesa_code=eq.${mpesaCode}&status=eq.paid&select=id,client_name`, { headers: hdrs });
        const existingPaid = await dupRes.json();
        if (Array.isArray(existingPaid) && existingPaid.length > 0) {
          addTrace("STEP 3 (DEDUP CHECK)", `Code ${mpesaCode} was ALREADY used to settle Order ${existingPaid[0].id} (${existingPaid[0].client_name})`);
          const out = {
            success: true,
            duplicate: true,
            mpesa_code: mpesaCode,
            settled_order_id: existingPaid[0].id,
            client_name: existingPaid[0].client_name,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }
        addTrace("STEP 3 (DEDUP CHECK)", `Code ${mpesaCode} is fresh (unused in Supabase)`);

        // 2. Find Pending Orders Matching Exact Amount
        const pendRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?status=eq.pending&total_price=eq.${amount}&order=created_at.desc&limit=10`, { headers: hdrs });
        let candidates = await pendRes.json();
        if (!Array.isArray(candidates)) candidates = [];
        addTrace("STEP 4 (ORDER SEARCH)", `Found ${candidates.length} pending order(s) with total_price = KES ${amount}`);

        // Hardened 3-Tier Identity + Time-Window Matching (Prevents matching stale/abandoned orders from wrong customers)
        let matchedOrder = null;
        const windowMinutes = Number(process.env.TILL_MATCH_WINDOW_MINUTES) || 15;
        const windowMs = windowMinutes * 60 * 1000;
        const nowMs = Date.now();
        const payerSuffix = payerPhone ? payerPhone.replace(/\D/g, "").slice(-9) : "";
        const payerTokens = (payerName && payerName !== "Customer")
          ? payerName.toLowerCase().split(/\s+/).filter(t => t.length >= 3)
          : [];

        if (candidates.length > 0) {
          // Tier 1: Exact Amount + Phone Suffix Match (100% Identity Guarantee)
          if (payerSuffix.length === 9) {
            matchedOrder = candidates.find(o => (o.client_phone || "").replace(/\D/g, "").endsWith(payerSuffix)) || null;
            if (matchedOrder) {
              addTrace("STEP 4B (TIER 1: PHONE + AMOUNT MATCH)", `Matched Order #${matchedOrder.id.slice(0, 8).toUpperCase()} via phone suffix *${payerSuffix}`);
            }
          }
          // Tier 2: Exact Amount + Registered Name Token Match (Handles Airtel/secondary checkout phone + Safaricom M-Pesa payment)
          if (!matchedOrder && payerTokens.length > 0) {
            matchedOrder = candidates.find(o => {
              const cName = (o.client_name || "").toLowerCase();
              return payerTokens.some(tok => cName.includes(tok));
            }) || null;
            if (matchedOrder) {
              addTrace("STEP 4B (TIER 2: NAME + AMOUNT MATCH)", `Matched Order #${matchedOrder.id.slice(0, 8).toUpperCase()} via registered name "${payerName}"`);
            }
          }
          // Tier 3: Exact Amount + Single Fresh Checkout Candidate within 15-minute window (Handles spouse/friend paying at checkout)
          if (!matchedOrder && candidates.length === 1) {
            const candidateAgeMs = candidates[0].created_at ? (nowMs - new Date(candidates[0].created_at).getTime()) : 0;
            if (candidateAgeMs <= windowMs) {
              matchedOrder = candidates[0];
              addTrace("STEP 4B (TIER 3: FRESH WINDOW + AMOUNT MATCH)", `Single fresh pending order (<=${windowMinutes}m old) -> Order #${matchedOrder.id.slice(0, 8).toUpperCase()}`);
            } else {
              addTrace("STEP 4B (STALE ORDER GUARD)", `Blocked auto-match to stale Order #${candidates[0].id.slice(0, 8).toUpperCase()} (${Math.round(candidateAgeMs / 60000)}m old, phone/name mismatch) -> Pooled safely`);
            }
          } else if (!matchedOrder && candidates.length > 1) {
            addTrace("STEP 4B (AMBIGUOUS GUARD)", `Could not disambiguate between ${candidates.length} orders with same amount and no phone/name match`);
          }
        }

        // Save to local Till Receipt Pool (for audit, balance variance & unclaimed lookback)
        try {
          const poolStatus = matchedOrder ? "CLAIMED" : (candidates.length > 1 ? "AMBIGUOUS" : "UNCLAIMED_POOL");
          const existingIdx = pool.findIndex(x => x.code === mpesaCode);
          const entryObj = {
            code: mpesaCode,
            direction: "INFLOW",
            amount,
            fee,
            reported_balance: reportedBalance,
            previous_balance: previousBalance,
            expected_balance: expectedBalance,
            balance_variance: balanceVariance,
            payer_phone: payerPhone,
            payer_name: payerName,
            sim_slot: simSlot,
            raw_sms: cleanSms,
            status: poolStatus,
            order_id: matchedOrder ? matchedOrder.id : null,
            received_at: new Date().toISOString()
          };
          if (existingIdx >= 0) {
            pool[existingIdx] = entryObj;
          } else {
            pool.unshift(entryObj);
          }
          fsMod.writeFileSync(poolPath, JSON.stringify(pool.slice(0, 500), null, 2), "utf-8");
          addTrace("STEP 5 (POOL SAVE)", `Saved receipt to till_receipt_pool.json with status=${poolStatus} | TillBalance=${reportedBalance}`);
        } catch (poolErr) {
          console.warn("[TILL POOL WARN]", poolErr.message);
        }

        if (!matchedOrder) {
          // Notify Operations Group of Unclaimed / Ambiguous Till Payment in Pool
          if (safeSendMessage && GROUPS?.general?.jid) {
            const poolMsg = candidates.length > 1
              ? `⚠️ *[TILL SMS — AMBIGUOUS MATCH]*\n` +
                `• *Ref:* \`${mpesaCode}\` | *KES ${amount.toLocaleString()}*\n` +
                `• *Payer:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
                (reportedBalance !== null ? `• *Till Balance:* KES ${reportedBalance.toLocaleString()}\n` : "") +
                `• *Reason:* ${candidates.length} pending orders have KES ${amount.toLocaleString()}.\n` +
                `👉 _Claim with:_ \`!paid <order_id> ${mpesaCode}\``
              : `📥 *[TILL SMS IN POOL — AWAITING ORDER]*\n` +
                `• *Ref:* \`${mpesaCode}\` | *KES ${amount.toLocaleString()}*\n` +
                `• *Payer:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
                (reportedBalance !== null ? `• *Till Balance:* KES ${reportedBalance.toLocaleString()}\n` : "") +
                `👉 _Pair manually anytime with:_ \`!paid <order_id> ${mpesaCode}\``;
            safeSendMessage(GROUPS.general.jid, { text: poolMsg });
            addTrace("STEP 6 (WHATSAPP ALERT)", `Sent ${candidates.length > 1 ? "AMBIGUOUS" : "POOLED"} alert to Operations WhatsApp Group`);
          }
          const out = {
            success: true,
            status: candidates.length > 1 ? "AMBIGUOUS" : "POOLED",
            direction: "INFLOW",
            mpesa_code: mpesaCode,
            amount,
            fee,
            reported_balance: reportedBalance,
            expected_balance: expectedBalance,
            balance_variance: balanceVariance,
            payer_name: payerName,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        // 3. Auto-Settle Matched Order in Supabase (<200ms)
        const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        const updatedNotes = matchedOrder.notes
          ? `${matchedOrder.notes}\n• [${timeStr} TILL-SIM]: Auto-settled (${mpesaCode} - ${payerName})`
          : `• [${timeStr} TILL-SIM]: Auto-settled (${mpesaCode} - ${payerName})`;

        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${matchedOrder.id}`, {
          method: "PATCH",
          headers: { ...hdrs, "Prefer": "return=minimal" },
          body: JSON.stringify({
            status: "paid",
            internal_status: "PAID",
            mpesa_code: mpesaCode,
            notes: updatedNotes
          })
        });
        addTrace("STEP 6 (SUPABASE SETTLE)", `Patched Order ${matchedOrder.id} -> status='paid', mpesa_code='${mpesaCode}'`);

        const allShops = await getAllShops();
        const activeShop = allShops.find(s => s.id === matchedOrder.shop_id) || null;
        const shortOrder = matchedOrder.id.slice(0, 8).toUpperCase();

        if (safeSendMessage) {
          const opsJid = activeShop?.fulfillment_settings?.whatsapp_routing?.operations_jid || GROUPS?.general?.jid;
          const mgmtJid = activeShop?.fulfillment_settings?.whatsapp_routing?.management_jid || GROUPS?.adminOversight?.jid;
          const card =
            `💳 *[TILL SIM AUTO-SETTLED — ${(activeShop?.name || "STORE").toUpperCase()}]*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `• *Order:* #${shortOrder} (${matchedOrder.client_name || payerName})\n` +
            `• *M-Pesa Ref:* \`${mpesaCode}\` ✅\n` +
            `• *Amount:* KES ${Number(amount).toLocaleString()}\n` +
            `• *Till Payer:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
            (reportedBalance !== null ? `• *New Till Balance:* KES ${Number(reportedBalance).toLocaleString()}\n` : "") +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *Next Step:* Reply \`!pack ${shortOrder}\` to box order.`;

          const targets = new Set([opsJid, mgmtJid, GROUPS?.general?.jid].filter(Boolean));
          for (const t of targets) {
            safeSendMessage(t, { text: card });
          }
          addTrace("STEP 7 (WHATSAPP BROADCAST)", `Dispatched AUTO-SETTLED card for #${shortOrder} to ${targets.size} WhatsApp group(s)`);
        }

        const out = {
          success: true,
          status: "PAID",
          direction: "INFLOW",
          order_id: matchedOrder.id,
          mpesa_code: mpesaCode,
          amount,
          fee,
          reported_balance: reportedBalance,
          expected_balance: expectedBalance,
          balance_variance: balanceVariance,
          payer_name: payerName,
          trace: traceSteps
        };
        await flushTraceLog(out);
        res.writeHead(200);
        return res.end(JSON.stringify(out));
      } catch (err) {
        console.error("[TILL WEBHOOK ERROR]", err);
        addTrace("ERROR", err.message);
        const out = { success: false, error: err.message, trace: traceSteps };
        await flushTraceLog(out);
        res.writeHead(500);
        return res.end(JSON.stringify(out));
      }
    }

    // GET /acoustic-modem (Serve 16-Tone MFSK Web Audio Transceiver UI)
    if (req.method === "GET" && parsedUrl.pathname === "/acoustic-modem") {
      try {
        const fsMod = await import("fs");
        const htmlPath = "C:\\Users\\user\\Documents\\Acoustic_Modem\\acoustic_transceiver.html";
        const html = fsMod.readFileSync(htmlPath, "utf-8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200);
        return res.end(html);
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/till/pool or /api/till/ledger (Inspect live Till SMS Pool + Full Variance & Outflow Summary)
    if (req.method === "GET" && (parsedUrl.pathname === "/api/till/pool" || parsedUrl.pathname === "/api/till/ledger")) {
      try {
        const fsMod = await import("fs");
        const pathMod = await import("path");
        const poolPath = pathMod.resolve(process.cwd(), "till_receipt_pool.json");
        const rawPool = fsMod.existsSync(poolPath) ? JSON.parse(fsMod.readFileSync(poolPath, "utf-8") || "[]") : [];

        // Enrich any older pool entries with parsed balance, fee, and direction from raw_sms
        const enriched = rawPool.map((item) => {
          const sms = String(item.raw_sms || "");
          const balMatch = sms.match(/New\s+(?:Account|Utility|Working(?:\s+Account)?|M-PESA)\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
          const feeMatch = sms.match(/Transaction\s+cost,?\s*(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
          const isOut = item.direction === "OUTFLOW" || item.status === "TILL_OUTFLOW" ||
            (!(/received\s+from/i.test(sms)) && /(?:sent\s+to|paid\s+to|withdrawn|Withdraw|transferred)/i.test(sms));
          return {
            ...item,
            direction: isOut ? "OUTFLOW" : "INFLOW",
            fee: typeof item.fee === "number" ? item.fee : (feeMatch ? parseFloat(feeMatch[1].replace(/,/g, "")) : 0),
            reported_balance: typeof item.reported_balance === "number"
              ? item.reported_balance
              : (balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : null)
          };
        });

        // Compute chronological expected balance & variance across real REDMI_TILL_SIM entries
        let runningBal = null;
        let cumulativeBalanceVariance = 0;
        const chronological = [...enriched].reverse();
        for (const tx of chronological) {
          if (tx.sim_slot === "REDMI_TILL_SIM" && typeof tx.reported_balance === "number") {
            if (runningBal !== null) {
              const expected = tx.direction === "INFLOW"
                ? Math.round((runningBal + (tx.amount || 0) - (tx.fee || 0)) * 100) / 100
                : Math.round((runningBal - (tx.amount || 0) - (tx.fee || 0)) * 100) / 100;
              tx.previous_balance = runningBal;
              tx.expected_balance = expected;
              tx.balance_variance = Math.round((tx.reported_balance - expected) * 100) / 100;
              cumulativeBalanceVariance = Math.round((cumulativeBalanceVariance + tx.balance_variance) * 100) / 100;
            } else {
              tx.previous_balance = Math.round(
                (tx.direction === "INFLOW"
                  ? tx.reported_balance - (tx.amount || 0) + (tx.fee || 0)
                  : tx.reported_balance + (tx.amount || 0) + (tx.fee || 0)) * 100
              ) / 100;
              tx.expected_balance = tx.reported_balance;
              tx.balance_variance = 0;
            }
            runningBal = tx.reported_balance;
          }
        }

        // Compute aggregate KPIs
        let inflowCount = 0;
        let outflowCount = 0;
        let totalInflow = 0;
        let totalOutflow = 0;
        let totalFees = 0;
        let claimedAmount = 0;
        let unclaimedAmount = 0;
        let latestTillBalance = null;

        for (const tx of enriched) {
          if (latestTillBalance === null && tx.sim_slot === "REDMI_TILL_SIM" && typeof tx.reported_balance === "number") {
            latestTillBalance = tx.reported_balance;
          }
          totalFees += tx.fee || 0;
          if (tx.direction === "OUTFLOW") {
            outflowCount++;
            totalOutflow += tx.amount || 0;
          } else {
            inflowCount++;
            totalInflow += tx.amount || 0;
            if (tx.status === "CLAIMED" || tx.status === "PAID") {
              claimedAmount += tx.amount || 0;
            } else {
              unclaimedAmount += tx.amount || 0;
            }
          }
        }
        if (latestTillBalance === null) {
          const anyWithBal = enriched.find(x => typeof x.reported_balance === "number");
          if (anyWithBal) latestTillBalance = anyWithBal.reported_balance;
        }

        const summary = {
          total_transactions: enriched.length,
          inflow_count: inflowCount,
          outflow_count: outflowCount,
          total_inflow_amount: Math.round(totalInflow * 100) / 100,
          total_outflow_amount: Math.round(totalOutflow * 100) / 100,
          total_fees_amount: Math.round(totalFees * 100) / 100,
          net_till_flow: Math.round((totalInflow - totalOutflow - totalFees) * 100) / 100,
          claimed_orders_amount: Math.round(claimedAmount * 100) / 100,
          unclaimed_pool_amount: Math.round(unclaimedAmount * 100) / 100,
          order_reconciliation_variance: Math.round((totalInflow - claimedAmount) * 100) / 100,
          latest_till_balance: latestTillBalance,
          cumulative_balance_variance: cumulativeBalanceVariance
        };

        res.writeHead(200);
        return res.end(JSON.stringify({ count: enriched.length, summary, receipts: enriched }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /till-app (Mobile PWA & Auto-Forwarder Setup Console for the New Phone)
    if (req.method === "GET" && parsedUrl.pathname === "/till-app") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Savannah Till SMS Relay</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    h1 { font-size: 20px; color: #38bdf8; margin: 0 0 6px 0; }
    p { font-size: 13px; color: #94a3b8; margin: 4px 0 12px 0; line-height: 1.4; }
    .url-box { background: #090d16; padding: 10px 12px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #4ade80; word-break: break-all; margin-bottom: 10px; border: 1px solid #1e293b; }
    button { width: 100%; background: #0284c7; color: #fff; border: none; padding: 13px; border-radius: 10px; font-weight: 700; font-size: 14px; cursor: pointer; margin-top: 8px; }
    button.secondary { background: #334155; }
    textarea { width: 100%; box-sizing: border-box; background: #090d16; color: #fff; border: 1px solid #334155; border-radius: 8px; padding: 10px; font-size: 13px; min-height: 80px; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; background: #065f46; color: #6ee7b7; }
    #log, #serverTrace { font-family: monospace; font-size: 12px; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">LIVE TILL 5758419 BRIDGE</span>
    <h1 style="margin-top:8px;">Savannah M-Pesa Till Relay</h1>
    <p>Forward incoming M-Pesa Till messages from your phone straight into the server in &lt;0.2s.</p>
    <div class="url-box" id="cloudUrl">https://wa.missperpetual.cloud/api/till/receipt</div>
    <div class="url-box" id="lanUrl">http://192.168.100.32:5174/api/till/receipt</div>
    <div class="url-box" id="tsUrl">http://100.73.175.118:5174/api/till/receipt</div>
    <button class="secondary" onclick="navigator.clipboard.writeText(window.location.origin + '/api/till/receipt'); alert('Copied Webhook URL!');">📋 Copy Active Webhook URL</button>
    <button style="background:#059669;" onclick="window.location.href='/finance-app'">📊 Open Personal Financial Reporter (/finance-app)</button>
  </div>

  <div class="card">
    <h1>⚡ Instant Test / Manual SMS Paste</h1>
    <p>Paste any M-Pesa confirmation SMS or tap below to test:</p>
    <textarea id="smsInput">UK6DC1DCIM Confirmed.on 6/11/26 at 4:35 PMKSH1.00 received from 254710720949 MERCY TRYPHEN EMURUGAT. New Account balance is KSH26.56. Transaction cost, KSH0.00.  Receiving payments of Ksh 500 &amp; below in your Lipa na M-PESA till is now FREE!</textarea>
    <button onclick="sendSms()">🚀 Send Receipt to Server Now</button>
    <button class="secondary" onclick="newRandomSms()">🎲 Generate Fresh Test M-Pesa SMS</button>
  </div>

  <div class="card">
    <h1>🔍 Full Server Response & Step-by-Step Trace</h1>
    <div id="serverTrace">Tap "Send Receipt to Server Now" above to record and view the full server response process here!</div>
  </div>

  <div class="card">
    <h1>📥 Live Till Receipt Pool</h1>
    <div id="log">Loading pool...</div>
  </div>

  <script>
    function newRandomSms() {
      const code = 'SK' + Math.floor(10000000 + Math.random() * 90000000);
      document.getElementById('smsInput').value = code + ' Confirmed. on 6/11/26 at 4:30 PM Ksh450.00 received from 254710720949 TEST CUSTOMER. New Utility balance is Ksh19,300.00';
    }
    async function loadPool() {
      try {
        const r = await fetch('/api/till/pool');
        const d = await r.json();
        document.getElementById('log').textContent = d.receipts && d.receipts.length
          ? d.receipts.slice(0, 8).map(x => \`[\${x.status}] \${x.code} - KES \${x.amount} (\${x.payer_name})\`).join('\\n')
          : 'No receipts in pool yet. Tap Send Receipt above to test!';
      } catch (e) {
        document.getElementById('log').textContent = 'Error loading pool: ' + e.message;
      }
    }
    async function sendSms() {
      const text = document.getElementById('smsInput').value;
      document.getElementById('serverTrace').textContent = '⏳ Sending to server and recording response trace...';
      const r = await fetch('/api/till/receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'MPESA', sim: 'NEW_PHONE', text })
      });
      const res = await r.json();
      const traceText = (res.trace || []).join('\\n');
      document.getElementById('serverTrace').textContent =
        '=== STEP-BY-STEP SERVER PROCESS ===\\n' + traceText +
        '\\n\\n=== FULL SERVER JSON RESPONSE ===\\n' + JSON.stringify(res, null, 2);
      loadPool();
    }
    loadPool();
  </script>
</body>
</html>`);
    }

    // GET /api/finance/report (Return full Personal Financial Reporter analytics)
    if (req.method === "GET" && parsedUrl.pathname === "/api/finance/report") {
      try {
        const { computeFinancialReport } = await import("./finance_engine.mjs");
        res.writeHead(200);
        return res.end(JSON.stringify(computeFinancialReport()));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/finance/ingest (Ingest single or batch SMS into Personal Financial Reporter)
    if (req.method === "POST" && parsedUrl.pathname === "/api/finance/ingest") {
      try {
        const { parseFinancialSms, savePersonalTransaction, computeFinancialReport } = await import("./finance_engine.mjs");
        const body = await parseJsonBody(req).catch(() => ({}));
        const items = Array.isArray(body.messages) ? body.messages : [body];
        let added = 0;
        const parsedResults = [];
        for (const item of items) {
          const text = item.text || item.body || item.sms || "";
          const sender = item.from || item.sender || item.address || "MPESA";
          const ts = item.timestamp || item.date || Date.now();
          const smsId = item.id || item.sms_id || null;
          const p = parseFinancialSms(text, sender, ts, smsId);
          if (p && !p.is_business_till) {
            const r = savePersonalTransaction(p);
            if (r.saved) added++;
            parsedResults.push({ ...p, saved: r.saved, duplicate: Boolean(r.duplicate) });
          }
        }
        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          added_count: added,
          parsed: parsedResults,
          report: computeFinancialReport()
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /finance-app (Personal Financial Reporter & Expense Analyzer Dashboard)
    if (req.method === "GET" && parsedUrl.pathname === "/finance-app") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Personal Financial Reporter — M-Pesa, DTB & Okoa Analytics</title>
  <style>
    body { background: #090d16; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 18px; max-width: 960px; margin-inline: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #065f46; color: #6ee7b7; }
    h1 { font-size: 22px; color: #38bdf8; margin: 4px 0; }
    h2 { font-size: 16px; color: #e2e8f0; margin: 0 0 12px 0; }
    p { font-size: 13px; color: #94a3b8; margin: 0; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .kpi { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 16px; }
    .kpi-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .kpi-val { font-size: 24px; font-weight: 800; margin-top: 6px; color: #f8fafc; }
    .kpi-sub { font-size: 11px; color: #64748b; margin-top: 4px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 18px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    .bar-row { margin-bottom: 12px; }
    .bar-label { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; color: #e2e8f0; }
    .bar-track { width: 100%; height: 8px; background: #0f172a; border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; background: linear-gradient(90deg, #0284c7, #38bdf8); border-radius: 999px; }
    .payee-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #334155; font-size: 13px; }
    .payee-row:last-child { border-bottom: none; }
    .tx-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 12px; background: #0f172a; border: 1px solid #1e293b; border-radius: 10px; margin-bottom: 8px; }
    .tx-title { font-weight: 700; font-size: 14px; color: #f8fafc; }
    .tx-meta { font-size: 12px; color: #94a3b8; margin-top: 3px; }
    .tx-amt { font-weight: 800; font-size: 15px; white-space: nowrap; }
    .outflow { color: #f87171; }
    .inflow { color: #4ade80; }
    .loan { color: #fbbf24; }
    textarea { width: 100%; box-sizing: border-box; background: #090d16; color: #fff; border: 1px solid #334155; border-radius: 8px; padding: 10px; font-size: 13px; min-height: 68px; margin-top: 8px; }
    button { background: #0284c7; color: #fff; border: none; padding: 11px 16px; border-radius: 10px; font-weight: 700; font-size: 13px; cursor: pointer; margin-top: 8px; }
    button.sec { background: #334155; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <span class="badge">PRIVATE PERSONAL FINANCIAL REPORTER</span>
      <h1>Mercy's M-Pesa, Bank & Okoa Analyzer</h1>
      <p>Automatically separates personal spending, DTB transfers, data bundles & Okoa fees from Till 5758419.</p>
    </div>
    <div>
      <button class="sec" onclick="window.location.href='/till-app'">🏪 Switch to Till 5758419 Relay</button>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Total Tracked Spending</div>
      <div class="kpi-val outflow" id="kpiSpent">KES 0</div>
      <div class="kpi-sub" id="kpiCount">0 transactions analyzed</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Latest M-Pesa Balance</div>
      <div class="kpi-val inflow" id="kpiBal">--</div>
      <div class="kpi-sub">From most recent M-Pesa SMS</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Unpaid Okoa Jahazi Debt</div>
      <div class="kpi-val loan" id="kpiOkoa">KES 0</div>
      <div class="kpi-sub">Live Safaricom Okoa balance</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Fees & Okoa Interest</div>
      <div class="kpi-val" style="color:#fb923c;" id="kpiFees">KES 0</div>
      <div class="kpi-sub">Transaction fees + Okoa charges</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>📊 How Your Money Was Spent (By Category)</h2>
      <div id="catList">Loading categories...</div>
    </div>
    <div class="card">
      <h2>🏆 Where Your Money Went (Top Payees)</h2>
      <div id="payeeList">Loading payees...</div>
    </div>
  </div>

  <div class="card">
    <h2>➕ Log or Test Any M-Pesa / Bank / Okoa SMS</h2>
    <p>Your Redmi Note 12 forwards personal SMS automatically. You can also paste any SMS below to analyze it:</p>
    <textarea id="manualSms" placeholder="Paste any M-Pesa, DTB, or Okoa Jahazi SMS here..."></textarea>
    <button onclick="ingestSms()">🔍 Analyze & Add to Financial Report</button>
  </div>

  <div class="card">
    <h2>📜 Categorized Personal Transaction Ledger</h2>
    <div id="txList">Loading ledger...</div>
  </div>

  <script>
    async function loadReport() {
      const r = await fetch('/api/finance/report');
      const d = await r.json();
      document.getElementById('kpiSpent').textContent = 'KES ' + (d.total_spent || 0).toLocaleString();
      document.getElementById('kpiCount').textContent = (d.total_transactions || 0) + ' messages analyzed';
      document.getElementById('kpiBal').textContent = d.latest_mpesa_balance !== null ? 'KES ' + d.latest_mpesa_balance.toLocaleString() : 'N/A';
      document.getElementById('kpiOkoa').textContent = d.latest_okoa_debt !== null ? 'KES ' + d.latest_okoa_debt.toLocaleString() : 'KES 0';
      document.getElementById('kpiFees').textContent = 'KES ' + (d.total_fees_and_okoa_interest || 0).toLocaleString();

      const cats = d.category_breakdown || [];
      document.getElementById('catList').innerHTML = cats.length
        ? cats.map(c => \`
          <div class="bar-row">
            <div class="bar-label"><span>\${c.category}</span><strong>KES \${c.amount.toLocaleString()} (\${c.share_pct}%)</strong></div>
            <div class="bar-track"><div class="bar-fill" style="width:\${Math.max(4, c.share_pct)}%"></div></div>
          </div>\`).join('')
        : '<p>No spending categories yet.</p>';

      const payees = d.top_payees || [];
      document.getElementById('payeeList').innerHTML = payees.length
        ? payees.map((p, i) => \`
          <div class="payee-row">
            <span><strong>#\${i+1}</strong> \${p.counterparty}</span>
            <strong>KES \${p.amount.toLocaleString()}</strong>
          </div>\`).join('')
        : '<p>No payees recorded yet.</p>';

      const txs = d.transactions || [];
      document.getElementById('txList').innerHTML = txs.length
        ? txs.map(t => {
            const cls = t.direction === 'INFLOW' ? 'inflow' : (t.direction === 'LOAN_ADVANCE' ? 'loan' : 'outflow');
            const sign = t.direction === 'INFLOW' ? '+' : (t.direction === 'LOAN_ADVANCE' ? 'ADVANCE ' : '-');
            const dt = new Date(t.timestamp).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
            return \`
              <div class="tx-row">
                <div>
                  <div class="tx-title">\${t.counterparty} <span style="font-weight:400;font-size:12px;color:#38bdf8;">[\${t.category}]</span></div>
                  <div class="tx-meta">Ref: <code>\${t.ref_code}</code> • \${dt}\${t.fee ? ' • Fee: KES ' + t.fee : ''}\${t.mpesa_balance !== null && t.mpesa_balance !== undefined ? ' • Bal: KES ' + t.mpesa_balance : ''}</div>
                </div>
                <div class="tx-amt \${cls}">\${sign}KES \${(t.amount || 0).toLocaleString()}</div>
              </div>\`;
          }).join('')
        : '<p>No transactions yet.</p>';
    }

    async function ingestSms() {
      const text = document.getElementById('manualSms').value.trim();
      if (!text) return;
      await fetch('/api/finance/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      document.getElementById('manualSms').value = '';
      loadReport();
    }

    loadReport();
  </script>
</body>
</html>`);
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

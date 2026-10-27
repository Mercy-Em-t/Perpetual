/**
 * HTTP IPC Routes for WhatsApp Gateway
 * Handles targeted dispatches to the 3 Departmental Groups from room_server.
 */
import { parseJsonBody } from "./http_helpers.mjs";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";

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

    // POST /api/notify-group (Direct card message to specific group)
    if (req.method === "POST" && parsedUrl.pathname === "/api/notify-group") {
      try {
        const body = await parseJsonBody(req);
        const groupKey = body.group || "general";
        const targetGroup = GROUPS[groupKey] || GROUPS.general;

        if (!targetGroup.jid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: `Group '${groupKey}' JID not resolved` }));
        }

        const msgText = body.message || body.text;
        if (!msgText) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing message text" }));
        }

        await safeSendMessage(targetGroup.jid, { text: msgText });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", group: groupKey, jid: targetGroup.jid }));
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

        // 1. Post to room_server orders pipeline
        try {
          await import("./http_helpers.mjs").then(async ({ httpRequest }) => {
            await httpRequest("http://127.0.0.1:5050/api/orders/webhook", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                order_id: orderId,
                customer_name: custName,
                customer_phone: custPhone,
                items: items.map(i => ({ name: i.name, qty: i.quantity || i.qty || 1, price: i.price || 0 })),
                total_amount: total,
                currency: "KES",
                notes: `[${shopTitle}] Pickup: ${pickup}`
              })
            });
          });
        } catch (postErr) {
          console.warn("[HTTP IPC] Forward to room_server /api/orders/webhook:", postErr.message);
        }

        // 2. Dispatch Order Alert to Perpetua Floor Operations AND Shop Operations Group
        const targetJid = GROUPS.general.jid;
        const shopGroupJid = body.target?.groupJid || body.targetGroupJid || meta.targetGroupJid;
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
        const { orderId, code, amount, customer, items, targetGroupJid } = body;
        console.log(`[PAYMENT VERIFICATION] Order ${orderId} | Code ${code} | KES ${amount}`);

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
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
        const dupRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?mpesa_code=eq.${cleanCode}&status=eq.paid&select=id,notes`, {
          headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` }
        });
        const existingPaid = await dupRes.json();
        const conflict = (existingPaid || []).filter(o => isUUID ? o.id !== orderId : o.notes !== orderId);
        if (conflict.length > 0) {
          res.writeHead(409);
          return res.end(JSON.stringify({
            code: "CODE_ALREADY_REDEEMED",
            error: `M-Pesa transaction code ${cleanCode} has already been redeemed on another settled order.`
          }));
        }

        // 3. Authoritative Backend Settlement: Mark order as PAID in Supabase
        if (orderId) {
          try {
            const filter = isUUID ? `id=eq.${orderId}` : `notes=eq.${orderId}`;
            await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}`, {
              method: "PATCH",
              headers: {
                "apikey": SERVICE_KEY,
                "Authorization": `Bearer ${SERVICE_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ status: "paid", mpesa_code: cleanCode })
            });
            console.log(`[BACKEND SETTLEMENT] Order ${orderId} successfully promoted to PAID in Supabase via filter ${filter}.`);
          } catch (dbErr) {
            console.error("[BACKEND DB ERROR]", dbErr.message);
          }
        }

        // Broadcast verification notice to BOTH Floor Ops and Shop-Specific WhatsApp Group
        if (safeSendMessage) {
          const itemSummary = Array.isArray(items) ? items.map(i => `${i.quantity}x ${i.name}`).join(", ") : "Items";
          const custName = customer?.name || "Customer";
          const verifyCard =
            `💰 *M-PESA PAYMENT VERIFIED*\n\n` +
            `• *Order:* #${(orderId || "").slice(0, 8)}\n` +
            `• *Customer:* ${custName}\n` +
            `• *Amount:* KES ${amount}\n` +
            `• *M-Pesa Ref:* ${code || "PENDING"}\n` +
            `• *Items:* ${itemSummary}\n\n` +
            `_Auto-paired via Edge Reconciliation Engine._`;

          if (GROUPS?.general?.jid) {
            safeSendMessage(GROUPS.general.jid, { text: verifyCard });
          }
          if (targetGroupJid && targetGroupJid !== GROUPS?.general?.jid) {
            safeSendMessage(targetGroupJid, { text: verifyCard });
          }
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          status: "PAID",
          paired: true,
          orderId,
          code,
          pickupPin: String(Math.floor(1000 + Math.random() * 9000)),
          message: `Payment code ${code} registered and verified.`
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
        const isPaid = order?.status === "paid";
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
        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orders[0].id}`, {
          method: "PATCH",
          headers: {
            "apikey": SERVICE_KEY,
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ status: normalizedTarget })
        });

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

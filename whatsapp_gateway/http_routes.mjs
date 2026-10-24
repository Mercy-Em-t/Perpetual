/**
 * HTTP IPC Routes for WhatsApp Gateway
 * Handles targeted dispatches to the 3 Departmental Groups from room_server.
 */
import { parseJsonBody } from "./http_helpers.mjs";

export function createHttpRouter({ GROUPS, getConnectionState, getBotJid, safeSendMessage }) {
  return async function handleHttpRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader("Content-Type", "application/json");

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
    if (req.method === "POST" && (parsedUrl.pathname === "/order" || parsedUrl.pathname === "/api/order")) {
      try {
        const body = await parseJsonBody(req);
        const meta = body.metadata || {};
        const items = meta.items || [];
        const customer = meta.customer || {};
        const custName = customer.name || meta.clientName || body.customer_name || "Store Customer";
        const custPhone = customer.phone || meta.clientPhone || body.customer_phone || "+254710720949";
        const total = meta.totalAmount || body.total_amount || 0;
        const shopTitle = body.tenantName || body.tenantId || "Leah's Kitchen";
        const orderId = meta.orderId || body.order_id || `LK-${Date.now().toString().slice(-6)}`;
        const pickup = meta.deliveryAddress || meta.fulfillmentType || "Gate A (Security Desk)";

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

        // 2. Dispatch Order Alert directly into Perpetua Floor Operations
        const targetJid = GROUPS.general.jid;
        if (targetJid) {
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

          await safeSendMessage(targetJid, { text: card });
        }

        res.writeHead(200);
        return res.end(JSON.stringify({ status: "ingested", order_id: orderId }));
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

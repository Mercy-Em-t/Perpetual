/**
 * Interactive Inbound WhatsApp Command Handler
 * Supports spatial controls, system & ticket governance, and 5-station order operations.
 */
import { GROUPS, ROOM_SERVER_HOST, ROOM_SERVER_PORT } from "./config.mjs";
import { httpRequest } from "./http_helpers.mjs";

export const KNOWN_COMMANDS = [
  "add", "remove", "turn", "light",
  "paid", "pack", "verify", "dispatch", "orders", "summary", "pulse",
  "details", "task", "order",
  "status", "health", "pool", "ticket", "assign", "resolve", "help"
];

export async function handleInboundCommand(commandText, replyJid, senderId, safeSendMessage) {
  const parts = commandText.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = commandText.substring(command.length).trim();
  const callerName = senderId ? senderId.replace(/@.*$/, "") : "User";

  try {
    // 0. Organization RBAC Policy Check
    if (command !== "!help") {
      try {
        const cleanSenderPhone = senderId ? senderId.replace(/@.*$/, "") : "";
        const { statusCode, data } = await httpRequest({
          host: ROOM_SERVER_HOST,
          port: ROOM_SERVER_PORT,
          path: `/api/organization/rbac/check?phone=${encodeURIComponent(cleanSenderPhone)}&command=${encodeURIComponent(command)}`,
          method: "GET"
        });
        if (statusCode === 200 && data && data.allowed === false) {
          await safeSendMessage(replyJid, {
            text: `🚫 *Permission Denied*\n` +
                  `• Command: \`${command}\`\n` +
                  `• Your Role: *${data.role}* (${data.member_name || "Guest"})\n` +
                  `• Reason: ${data.reason}\n\n` +
                  `_Authorized roles are managed in config/organization.json._`
          });
          return;
        }
      } catch (rbacErr) {
        // Fallback open if room_server temporarily offline
      }
    }

    // 1. Help
    if (command === "!help") {
      const helpMsg =
        `🤖 *Perpetua Community Command Center*\n\n` +
        `*🏬 Floor Operations (5-Station Flow):*\n` +
        `• *!paid <order_id> <ref>*\n  e.g. \`!paid ORD-1042 MPESA-QA8921\`\n` +
        `• *!pack <order_id>*\n  Mark packaged & alert dispatch\n` +
        `• *!verify <order_id>*\n  Mark QA verified\n` +
        `• *!dispatch <order_id> [rider]*\n  Hand off to courier & fulfill\n` +
        `• *!orders*\n  List active in-flight shop orders\n\n` +
        `*🎨 Spatial & Scene Controls:*\n` +
        `• *!add <item> to <target>*\n  e.g. \`!add books to shelf\`, \`!add sconce to wall\`\n` +
        `• *!remove <item> from <target>*\n  e.g. \`!remove vase from shelf\`\n` +
        `• *!turn on light* / *!turn off light*\n  Toggle photometric illumination\n\n` +
        `*💼 Executive & Oversight:*\n` +
        `• *!summary* or *!pulse*\n  P&L revenue rollup and KPI card\n` +
        `• *!pool*\n  Inspect 5-stage ASADF task pipeline\n` +
        `• *!status* or *!health*\n  Query room health and vitals\n\n` +
        `*🛡️ IT Helpdesk & Support:*\n` +
        `• *!ticket <issue>*\n  File incident ticket to Helpdesk\n` +
        `• *!resolve <ticket_id> [notes] / !assign <task_id> to <agent>*\n\n` +
        `_Channels: perpetua (Ops) | Helpdesk (Desk) | Oversight (Exec)_`;
      await safeSendMessage(replyJid, { text: helpMsg });
      return;
    }

    // 2. Status / Health
    if (command === "!status" || command === "!health") {
      const { data: health } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/health",
        method: "GET"
      });
      const { data: state } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/room/state",
        method: "GET"
      });

      const pipeline = state?.task_pipeline || {};
      const pendingCount = (pipeline.PENDING || []).length;
      const claimedCount = (pipeline.CLAIMED || []).length;
      const inProgCount = (pipeline.IN_PROGRESS || []).length;
      const verifiedCount = (pipeline.VERIFIED || []).length;
      const doneCount = (pipeline.DONE || []).length;
      const onlineAgents = (state?.agents || []).filter(a => a.is_online).length;
      const totalTickets = health?.stats?.tickets_open ?? 0;

      const reply =
        `🏥 *Shared Agent Room Vitals*\n` +
        `╭────────────────────────────────╮\n` +
        `  • Status: *${(health?.status || "ONLINE").toUpperCase()}*\n` +
        `  • Online Agents: ${onlineAgents}\n` +
        `  • Open Tickets: ${totalTickets}\n` +
        `  • Task Pipeline:\n` +
        `    ├─ 🟡 Pending:     ${pendingCount}\n` +
        `    ├─ 🔵 Claimed:     ${claimedCount}\n` +
        `    ├─ 🟣 In Progress: ${inProgCount}\n` +
        `    ├─ 🟢 Verified:    ${verifiedCount}\n` +
        `    └─ ✅ Done:        ${doneCount}\n` +
        `╰────────────────────────────────╯\n` +
        `_Dashboard:_ http://localhost:5050/room`;
      await safeSendMessage(replyJid, { text: reply });
      return;
    }

    // 3. Pool
    if (command === "!pool") {
      const { data: tasks } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/api/tasks",
        method: "GET"
      });

      const list = tasks?.tasks || [];
      if (list.length === 0) {
        await safeSendMessage(replyJid, { text: `📋 *Task Pool:* Currently empty. All tasks completed!` });
        return;
      }

      let reply = `📋 *Active Task Pool (${list.length} tasks)*\n\n`;
      list.slice(0, 8).forEach((t) => {
        const stageIcon = t.state === "DONE" ? "✅" : t.state === "IN_PROGRESS" ? "🟣" : t.state === "CLAIMED" ? "🔵" : "🟡";
        reply += `${stageIcon} *\`${t.task_id}\`* [${t.state}]\n   ${t.title}\n`;
      });
      if (list.length > 8) {
        reply += `\n_...and ${list.length - 8} more in queue._`;
      }
      await safeSendMessage(replyJid, { text: reply });
      return;
    }

    // 4. Ticket
    if (command === "!ticket") {
      if (!args) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!ticket <description of issue>\`\nExample: \`!ticket Camera perspective drift on north wall\`` });
        return;
      }
      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/api/tickets",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        title: args,
        description: `Logged via WhatsApp by ${callerName}`,
        reported_by: callerName,
        severity: "MEDIUM"
      });

      if (statusCode >= 200 && statusCode < 300) {
        const ticketId = data.ticket?.ticket_id || "TICK-NEW";
        const reply =
          `🎫 *Incident Ticket Created*\n` +
          `• *Ticket ID:* \`${ticketId}\`\n` +
          `• *Issue:* ${args}\n` +
          `• *Reported By:* ${callerName}\n` +
          `• *Status:* OPEN\n` +
          `_Routed to Perpetua - IT Helpdesk._`;
        await safeSendMessage(replyJid, { text: reply });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Failed to create ticket:* ${data.error || 'Server error'}` });
      }
      return;
    }

    // 5. Assign
    if (command === "!assign") {
      const match = args.match(/^(\S+)\s+(?:to\s+)?(\S+)$/i);
      if (!match) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!assign <task_id> to <agent_id>\`\nExample: \`!assign task_94c628d7 to Agent_Alpha\`` });
        return;
      }
      const taskId = match[1];
      const agentId = match[2];
      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: `/api/tasks/${taskId}/claim`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, { agent_id: agentId });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `👤 *Task Assigned:* \`${taskId}\` -> *${agentId}* (Claim lease: 60s)` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Assignment failed:* ${data.error || 'Check task state'}` });
      }
      return;
    }

    // 6. Resolve
    if (command === "!resolve") {
      const match = args.match(/^(\S+)(?:\s+(.+))?$/i);
      if (!match) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!resolve <ticket_id> [resolution notes]\`` });
        return;
      }
      const ticketId = match[1];
      const notes = match[2] ? match[2].trim() : "Resolved via WhatsApp command";

      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: `/api/tickets/${ticketId}/resolve`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        resolved_by: callerName,
        resolution_notes: notes
      });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `✅ *Ticket Resolved:* \`${ticketId}\`\n• Notes: ${notes}\n• By: @${callerName}` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Resolve failed:* ${data.error || 'Ticket not found'}` });
      }
      return;
    }

    // 7. Order Operations: !paid
    if (command === "!paid") {
      const match = args.match(/^(\S+)(?:\s+(.+))?$/i);
      if (!match) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!paid <order_id> <payment_reference>\`\nExample: \`!paid ORD-8D4F33 MPESA-QA8921\`` });
        return;
      }
      const orderId = match[1];
      const ref = match[2] ? match[2].trim() : "MANUAL-VERIFIED";

      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: `/api/orders/${orderId}/station`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        station: "PAID",
        actor: callerName,
        payment_ref: ref,
        notes: `Payment verified by Cashier @${callerName}`
      });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `💳 *Payment Verified:* \`${orderId}\`\n• Ref: \`${ref}\`\n• Advanced to: *PAID / INTAKE*\n• Next: \`!pack ${orderId}\`` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Payment update failed:* ${data?.error || 'Order not found'}` });
      }
      return;
    }

    // 8. Order Operations: !pack
    if (command === "!pack") {
      const orderId = args.trim();
      if (!orderId) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!pack <order_id>\`` });
        return;
      }
      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: `/api/orders/${orderId}/station`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        station: "PACKAGING",
        actor: callerName,
        notes: `Items boxed by @${callerName}`
      });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `📦 *Order Boxed:* \`${orderId}\`\n• Advanced to: *PACKAGING*\n• Next: QA verify with \`!verify ${orderId}\`` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Pack update failed:* ${data?.error || 'Order not found'}` });
      }
      return;
    }

    // 9. Order Operations: !verify
    if (command === "!verify") {
      const orderId = args.trim();
      if (!orderId) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!verify <order_id>\`` });
        return;
      }
      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: `/api/orders/${orderId}/station`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        station: "VERIFIED",
        actor: callerName,
        notes: `QA checklist verified by @${callerName}`
      });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `🔍 *QA Verified:* \`${orderId}\`\n• Advanced to: *VERIFIED*\n• Ready for rider handoff: \`!dispatch ${orderId} <rider_name>\`` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Verification failed:* ${data?.error || 'Order not found'}` });
      }
      return;
    }

    // 10. Order Operations: !dispatch
    if (command === "!dispatch") {
      const match = args.match(/^(\S+)(?:\s+(.+))?$/i);
      if (!match) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!dispatch <order_id> [courier/rider]\`\nExample: \`!dispatch ORD-8D4F33 Dennis Rider\`` });
        return;
      }
      const orderId = match[1];
      const courier = match[2] ? match[2].trim() : "Standard Courier";

      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: `/api/orders/${orderId}/station`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        station: "DISPATCHED",
        actor: callerName,
        courier_name: courier,
        notes: `Handed to courier ${courier} by @${callerName}`
      });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `🚚 *Order Dispatched:* \`${orderId}\`\n• Courier: *${courier}*\n• Status: *DISPATCHED & FULFILLED* ✅\n• Rollup metrics updated.` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Dispatch failed:* ${data?.error || 'Order not found'}` });
      }
      return;
    }

    // 11. Order In-Flight List: !orders
    if (command === "!orders") {
      const { data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/api/orders?limit=10",
        method: "GET"
      });

      const list = data?.orders || [];
      if (list.length === 0) {
        await safeSendMessage(replyJid, { text: `🛒 *Active Orders:* No open orders in queue.` });
        return;
      }

      let reply = `🛒 *Store Orders Pipeline (${list.length} orders)*\n\n`;
      list.slice(0, 8).forEach(o => {
        const icon = o.station === "DISPATCHED" ? "🚚" : o.station === "PAID" ? "💳" : o.station === "PACKAGING" ? "📦" : "🟡";
        reply += `${icon} *\`${o.order_id}\`* [${o.station}] — $${o.total_amount.toFixed(2)}\n   Customer: ${o.customer_name}\n`;
      });
      await safeSendMessage(replyJid, { text: reply });
      return;
    }

    // 12. Executive Summary & Pulse: !summary / !pulse
    if (command === "!summary" || command === "!pulse") {
      const { data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/api/orders/summary",
        method: "GET"
      });
      const summary = data?.summary || {};
      const st = summary.station_counts || {};

      const reply =
        `📊 *Executive Shop Pulse — Instant Rollup*\n` +
        `╭────────────────────────────────────────╮\n` +
        `  • Total Revenue: $${(summary.total_revenue || 0).toFixed(2)}\n` +
        `  • Total Orders Today: ${summary.total_orders || 0}\n` +
        `  • Active In-Flight: ${summary.in_flight || 0}\n` +
        `    ├─ 🟡 Pending Pay: ${st.PENDING || 0}\n` +
        `    ├─ 💳 Paid/Intake: ${st.PAID || 0}\n` +
        `    ├─ 📦 Packaging:   ${st.PACKAGING || 0}\n` +
        `    └─ 🔍 Quality QA:  ${st.VERIFIED || 0}\n` +
        `  • Dispatched/Done: ${summary.completed || 0}\n` +
        `╰────────────────────────────────────────╯\n` +
        `_Triggered by @${callerName}_`;
      await safeSendMessage(replyJid, { text: reply });
      return;
    }

    // 12b. On-Demand In-Depth Inquiries: !details <id> or !task <id> or !order <id>
    if (command === "!details" || command === "!task" || command === "!order") {
      const targetId = args.trim();
      if (!targetId) {
        await safeSendMessage(replyJid, {
          text: `⚠️ *Usage:* \`!details <task_id | order_id>\`\nExamples:\n• \`!details task_94c628d7\`\n• \`!details ORD-8D4F33\``
        });
        return;
      }

      // Check if it's an order
      if (targetId.toUpperCase().startsWith("ORD-")) {
        const { statusCode, data } = await httpRequest({
          host: ROOM_SERVER_HOST,
          port: ROOM_SERVER_PORT,
          path: `/api/orders/${targetId}`,
          method: "GET"
        });
        if (statusCode >= 200 && statusCode < 300 && data?.order) {
          const o = data.order;
          const itemsList = (o.items || []).map(i => `    • ${i.name} (x${i.qty || 1}) - $${(i.price || 0).toFixed(2)}`).join("\n") || "    • None";
          const reply =
            `🔍 *[ORDER DEEP-DIVE: AUDIT TELEMETRY]*\n` +
            `╭────────────────────────────────────────╮\n` +
            `  • Order ID: \`${o.order_id}\`\n` +
            `  • Customer: *${o.customer_name}* (${o.customer_phone || "No phone"})\n` +
            `  • Total Amount: $${(o.total_amount || 0).toFixed(2)} ${o.currency || "USD"}\n` +
            `  • Current Station: *${o.station}*\n` +
            `  • Payment Ref: \`${o.payment_ref || "None"}\`\n` +
            `  • Courier/Rider: *${o.courier_name || "Unassigned"}*\n` +
            `  • Items:\n${itemsList}\n` +
            `  • Created At: ${new Date((o.created_at || 0) * 1000).toLocaleString()}\n` +
            `  • Notes: ${o.notes || "None"}\n` +
            `╰────────────────────────────────────────╯\n` +
            `_Requested by @${callerName}_`;
          await safeSendMessage(replyJid, { text: reply });
          return;
        }
      }

      // Query as Task
      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: `/api/tasks/${targetId}`,
        method: "GET"
      });

      if (statusCode >= 200 && statusCode < 300 && data?.task) {
        const t = data.task;
        const payloadStr = typeof t.payload === "object" ? JSON.stringify(t.payload) : String(t.payload || "{}");
        const reply =
          `🔍 *[TASK DEEP-DIVE: AUDIT TELEMETRY]*\n` +
          `╭────────────────────────────────────────╮\n` +
          `  • Task ID: \`${t.task_id}\`\n` +
          `  • Title: *${t.title}*\n` +
          `  • State: *${t.state}*\n` +
          `  • Claimed By: *${t.claimed_by || "Unassigned"}*\n` +
          `  • Priority: ${t.priority} | Type: ${t.task_type}\n` +
          `  • Claim Lease: ${t.claim_timeout_seconds}s\n` +
          `  • Created: ${new Date((t.created_at || 0) * 1000).toLocaleString()}\n` +
          `  • Updated: ${new Date((t.updated_at || 0) * 1000).toLocaleString()}\n` +
          `  • Payload: \`${payloadStr.substring(0, 150)}\`\n` +
          `╰────────────────────────────────────────╯\n` +
          `_Requested by @${callerName}_`;
        await safeSendMessage(replyJid, { text: reply });
        return;
      }

      await safeSendMessage(replyJid, {
        text: `❌ Could not find task or order with ID \`${targetId}\`.`
      });
      return;
    }

    // 13. Spatial Controls: !add
    if (command === "!add") {
      if (!args) {
        await safeSendMessage(replyJid, {
          text: `⚠️ *Usage:* \`!add <item> [to <target>]\`\nExamples:\n• \`!add books to shelf\`\n• \`!add sconce to wall\`\n• \`!add vase to shelf\``
        });
        return;
      }
      const addMatch = args.match(/^(.+?)(?:\s+(?:to|on|onto)\s+(.+))?$/i);
      const rawItem = addMatch ? addMatch[1].trim() : args.trim();
      const rawTarget = addMatch && addMatch[2] ? addMatch[2].trim() : "left_matte_white_wall";

      const itemKey = rawItem.toLowerCase().replace(/[^a-z0-9_]/g, "");
      const classMap = {
        book: "Books", books: "Books", sconce: "Sconce", light: "Sconce", lamp: "Sconce",
        shelf: "Shelf", vase: "Vase", candle: "Candle", flowers: "Flowers", flower: "Flowers",
        plant: "TrailingPlants", plants: "TrailingPlants", sofa: "BlueVelvetSofa", couch: "BlueVelvetSofa",
        tv: "SwivelBracketTVMount", perfume: "PerfumeBottle", tin: "Tin", wallhanging: "WallHanging",
        macrame: "Macrame", runner: "JuteRunner"
      };

      const className = classMap[itemKey] || (rawItem.charAt(0).toUpperCase() + rawItem.slice(1));
      const isShelfTarget = /shelf/i.test(rawTarget);
      const surfaceId = "left_matte_white_wall";
      const parentShelfId = isShelfTarget ? "floating_shelf_1" : null;
      const coords = className === "Sconce" ? [0.5, 0.8, 0.0] : (isShelfTarget ? [0.4, 0.5, 0.0] : [0.5, 0.5, 0.0]);

      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/api/messages",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        sender: "WHATSAPP_BOT",
        target: "ASSET_LISTENER",
        topic: "INSTANTIATE_ASSET",
        payload: {
          class_name: className,
          surface_id: surfaceId,
          parent_shelf_id: parentShelfId,
          coordinates: coords,
          locking: true,
          requested_by: callerName
        }
      });

      if (statusCode >= 200 && statusCode < 300) {
        const reply =
          `🎨 *Spatial Object Added & Locked*\n` +
          `╭────────────────────────────────╮\n` +
          `  • Object: \`${className}\`\n` +
          `  • Target: \`${rawTarget}\`\n` +
          `  • Matrix Locking: Active (Δ = 0.00000000)\n` +
          `  • Coordinates: \`[${coords.join(", ")}]\`\n` +
          `  • Caller: @${callerName}\n` +
          `╰────────────────────────────────╯\n` +
          `_Topology updated in real-time._`;
        await safeSendMessage(replyJid, { text: reply });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Add failed:* ${data?.error || 'Room service error'}` });
      }
      return;
    }

    // 14. Spatial Controls: !remove
    if (command === "!remove") {
      if (!args) {
        await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!remove <item> [from <target>]\`` });
        return;
      }
      const removeMatch = args.match(/^(.+?)(?:\s+(?:from|off)\s+(.+))?$/i);
      const rawItem = removeMatch ? removeMatch[1].trim() : args.trim();
      const rawTarget = removeMatch && removeMatch[2] ? removeMatch[2].trim() : "scene";

      const itemKey = rawItem.toLowerCase().replace(/[^a-z0-9_]/g, "");
      const classMap = {
        book: "Books", books: "Books", sconce: "Sconce", light: "Sconce", shelf: "Shelf",
        vase: "Vase", candle: "Candle", flowers: "Flowers", plant: "TrailingPlants",
        sofa: "BlueVelvetSofa", tv: "SwivelBracketTVMount", perfume: "PerfumeBottle",
        tin: "Tin", wallhanging: "WallHanging", macrame: "Macrame", runner: "JuteRunner"
      };
      const className = classMap[itemKey] || rawItem;

      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/api/messages",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        sender: "WHATSAPP_BOT",
        target: "ASSET_LISTENER",
        topic: "REMOVE_ASSET",
        payload: {
          class_name: className,
          target: rawTarget,
          requested_by: callerName
        }
      });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `🗑️ *Spatial Object Removed:* \`${className}\` from \`${rawTarget}\`\n• Status: Purged from scene\n• Caller: @${callerName}` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Remove failed:* ${data?.error || 'Room service error'}` });
      }
      return;
    }

    // 15. Spatial Controls: !turn / !light
    if (command === "!turn" || command === "!light") {
      let state = /off/i.test(args) ? "off" : "on";
      const ambient = state === "on" ? 0.8 : 0.05;

      const { statusCode, data } = await httpRequest({
        host: ROOM_SERVER_HOST,
        port: ROOM_SERVER_PORT,
        path: "/api/messages",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, {
        sender: "WHATSAPP_BOT",
        target: "ASSET_LISTENER",
        topic: "MODIFY_SCENE",
        payload: {
          action: "update_lighting",
          ambient_intensity: ambient,
          light_state: state,
          requested_by: callerName
        }
      });

      if (statusCode >= 200 && statusCode < 300) {
        await safeSendMessage(replyJid, { text: `💡 *Lighting Fixture Toggled:*\n• State: *${state.toUpperCase()}*\n• Ambient Level: \`${ambient.toFixed(2)}\`\n• Caller: @${callerName}` });
      } else {
        await safeSendMessage(replyJid, { text: `❌ *Lighting toggle failed:* ${data?.error || 'Room service error'}` });
      }
      return;
    }

    // Unrecognized command
    await safeSendMessage(replyJid, {
      text: `❓ *Unknown command:* \`${command}\`\nType *!help* to view available commands.`
    });

  } catch (cmdErr) {
    console.error(`[WHATSAPP INBOUND ERROR]`, cmdErr);
  }
}

/**
 * Enterprise WhatsApp Command Handler
 * Enforces Role-Based Access Control (RBAC), multi-tenant isolation,
 * temporal order/sales scoping, copy-paste product templates, ambiguity protection,
 * and double-confirmation safety guards.
 */
import { GROUPS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";
import {
  resolveGroupContext,
  resolveShopOrder,
  queryShopOrders,
  calculateShopSummary,
  resolveShopProduct,
  addShopProduct,
  updateShopProductFields,
  getShopInventoryOverview,
  listShopProducts,
  getAllShops
} from "./tenant_resolver.mjs";

export const KNOWN_COMMANDS = [
  "help", "status", "health", "orders", "order", "details",
  "paid", "pack", "verify", "dispatch", "delivered", "confirm",
  "summary", "sales", "pulse",
  "product", "item", "items", "catalog",
  "approve", "hide", "drafts", "policy",
  "resurrect", "revive", "reorder", "repeat", "buyagain",
  "shop", "shops", "stores", "bind",
  "ticket", "resolve"
];

const dbHdrs = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

/**
 * Universal Order Filter Builder
 * Resolves orders by:
 * 1. Full UUID: 832f1b75-f351-4984-97f1-7869214bc26f
 * 2. Short UUID Hex: 832f1b75 or #832F1B75
 * 3. Enterprise Order Number: ORD-DNH-261027-9K4E
 */
export function buildOrderFilter(orderQuery) {
  const clean = (orderQuery || "").trim();
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);
  if (isUUID) {
    return `id=eq.${clean}`;
  }
  if (clean.toUpperCase().startsWith("ORD-")) {
    return `notes=ilike.*${clean}*`;
  }
  const hex = clean.replace(/^#/, "");
  return `id=ilike.${hex}*`;
}

export function formatDisplayOrderId(order) {
  if (order?.notes && order.notes.includes("ORD-")) {
    const match = order.notes.match(/ORD-[A-Z0-9]+-[0-9]+-[A-Z0-9]+/i);
    if (match) return match[0];
  }
  return `#${(order?.id || "").slice(0, 8).toUpperCase()}`;
}

export async function handleInboundCommand(commandText, replyJid, senderId, safeSendMessage) {
  // Normalize "! command" -> "!command" and "/command" -> "!command"
  const normalized = (commandText || "").trim().replace(/^([!/])\s+/, "$1").replace(/^\//, "!");
  const parts = normalized.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = normalized.substring(parts[0].length).trim();
  const callerName = senderId ? senderId.replace(/@.*$/, "") : "User";

  try {
    // 1. Resolve Multi-Tenant Context
    const context = await resolveGroupContext(replyJid);

    // 2. Query Shop Directory (!shops [query], !stores [query])
    if (command === "!shops" || command === "!stores") {
      return await handleShopListCommand(replyJid, context, safeSendMessage, args);
    }

    // 3. On-The-Fly Group Onboarding & Linking (!shop bind <slug> [ops|mgmt]) or !shop list
    if (command === "!shop" || command === "!bind") {
      const firstArg = args.split(/\s+/)[0]?.toLowerCase();
      if (firstArg === "list" || firstArg === "ls" || firstArg === "all") {
        const subQuery = args.substring(firstArg.length).trim();
        return await handleShopListCommand(replyJid, context, safeSendMessage, subQuery);
      }
      return await handleShopBindCommand(args, replyJid, senderId, callerName, safeSendMessage);
    }

    // 4. Route by Tier
    if (context.tier === "SHOP") {
      return await handleShopCommand(command, args, replyJid, senderId, callerName, context, safeSendMessage);
    }

    if (context.tier === "SYSTEM") {
      return await handleSystemCommand(command, args, replyJid, senderId, callerName, context, safeSendMessage);
    }

    if (context.tier === "DIRECT_MESSAGE") {
      return await handleDirectMessageCommand(command, args, replyJid, senderId, callerName, safeSendMessage);
    }

    // Unregistered Group
    await safeSendMessage(replyJid, {
      text: `🔒 *Channel Unregistered*\nThis WhatsApp group is not linked to any active store.\n\n👉 _To bind this group to a shop, type:_\n\`!shop bind <shop_slug> [ops | mgmt]\`\n_e.g. !shop bind savannah-atelier ops_`
    });

  } catch (cmdErr) {
    console.error(`[WHATSAPP INBOUND ERROR]`, cmdErr);
    await safeSendMessage(replyJid, {
      text: `⚠️ *Command Error:* ${cmdErr.message}`
    });
  }
}

// =============================================================================
// PLATFORM SHOP DIRECTORY HANDLER (!shops [query] | !stores [query] | !shop list)
// =============================================================================
async function handleShopListCommand(replyJid, context, safeSendMessage, query = "") {
  // Privacy Guard: If executed inside a single shop's group, do not leak competitors' names/slugs
  if (context?.tier === "SHOP") {
    await safeSendMessage(replyJid, {
      text: `🏪 *Current Store:* ${context.shop.name}\n` +
            `• Slug: \`${context.shop.slug}\`\n` +
            `• Group Role: ${context.role}\n\n` +
            `🔒 _Platform-wide directory of all 17 stores is restricted to Platform Admin Oversight._`
    });
    return;
  }

  const allShops = await getAllShops(true);
  if (!allShops || allShops.length === 0) {
    await safeSendMessage(replyJid, { text: `🏬 *Platform Shops:* No active stores registered in database.` });
    return;
  }

  const cleanQuery = (query || "").trim().toLowerCase();
  const filtered = cleanQuery
    ? allShops.filter(s => s.name.toLowerCase().includes(cleanQuery) || s.slug.toLowerCase().includes(cleanQuery))
    : allShops;

  if (filtered.length === 0) {
    await safeSendMessage(replyJid, {
      text: `❌ *No Shops Found matching "${query}".*\nType \`!shops\` to list all ${allShops.length} registered stores.`
    });
    return;
  }

  const titleHeader = cleanQuery 
    ? `🏬 *Platform Stores matching "${cleanQuery}" (${filtered.length} found)*\n\n`
    : `🏬 *Registered Platform Tenants (${filtered.length} Total)*\n\n`;

  let reply = titleHeader;
  filtered.forEach(s => {
    const routing = s.fulfillment_settings?.whatsapp_routing || {};
    const opsBound = !!routing.operations_jid;
    const mgmtBound = !!routing.management_jid;

    let linkBadge = "⚪ Unlinked";
    if (opsBound && mgmtBound) {
      linkBadge = "🟢 Ops & Mgmt Active";
    } else if (opsBound) {
      linkBadge = "🟡 Ops Linked";
    } else if (mgmtBound) {
      linkBadge = "🟡 Mgmt Linked";
    }

    reply += `• *${s.name}*\n`;
    reply += `  └ Slug: \`${s.slug}\` | ${linkBadge}\n`;
    reply += `  └ Drilldown: \`!summary ${s.slug}\`\n\n`;
  });

  reply += `👉 *Admin Actions:*\n`;
  reply += `• Financial drilldown: \`!summary <slug>\`\n`;
  reply += `• Bind group to a shop: \`!shop bind <slug> [ops | mgmt]\`\n`;
  reply += `• Platform master rollup: \`!summary\``;

  await safeSendMessage(replyJid, { text: reply });
}

// =============================================================================
// ON-THE-FLY SHOP BINDING HANDLER
// =============================================================================
async function handleShopBindCommand(args, replyJid, senderId, callerName, safeSendMessage) {
  const parts = args.split(/\s+/);
  const action = parts[0]?.toLowerCase();
  const slug = (action === "bind" ? parts[1] : parts[0])?.toLowerCase();
  const role = (action === "bind" ? parts[2] : parts[1])?.toLowerCase() || "ops";

  if (!slug) {
    const shops = await getAllShops();
    const slugList = shops.slice(0, 8).map(s => `\`${s.slug}\``).join(", ");
    await safeSendMessage(replyJid, {
      text: `⚠️ *Usage:* \`!shop bind <shop_slug> [ops | mgmt | comm | channel]\`\n\n` +
            `*Available shop slugs:*\n${slugList}...\n\n` +
            `*Examples:*\n• \`!shop bind haberdashery ops\`\n• \`!shop bind creative-galore mgmt\`\n• \`!shop bind haberdashery channel\`\n\n` +
            `👉 _Type *!shops* to view the full directory of all ${shops.length} registered shops and their live WhatsApp links._`
    });
    return;
  }

  const shops = await getAllShops(true);
  const matched = shops.find(s => s.slug.toLowerCase() === slug || s.name.toLowerCase().includes(slug));
  if (!matched) {
    await safeSendMessage(replyJid, {
      text: `❌ *Shop Not Found:* Could not locate active store matching slug \`${slug}\`.\nAvailable: ${shops.slice(0, 6).map(s => `\`${s.slug}\``).join(", ")}...`
    });
    return;
  }

  const isChannel = role.includes("chan") || role.includes("news") || replyJid.endsWith("@newsletter");
  const targetField = role.startsWith("m") ? "management_jid" : isChannel ? "channel_jid" : role.startsWith("c") ? "community_jid" : "operations_jid";
  const roleLabel = targetField === "management_jid" ? "Management Oversight" : targetField === "channel_jid" ? "Public Broadcast Channel" : targetField === "community_jid" ? "Community Channel" : "Floor Operations";

  const settings = matched.fulfillment_settings || {};
  settings.whatsapp_routing = settings.whatsapp_routing || {};
  settings.whatsapp_routing[targetField] = replyJid;

  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${matched.id}`, {
    method: "PATCH",
    headers: dbHdrs,
    body: JSON.stringify({ fulfillment_settings: settings })
  });

  if (patchRes.ok) {
    await getAllShops(true);
    await safeSendMessage(replyJid, {
      text: `🎉 *WhatsApp Channel Successfully Linked!*\n\n` +
            `• *Shop:* ${matched.name} (\`${matched.slug}\`)\n` +
            `• *Department:* ${roleLabel}\n` +
            `• *Group JID:* \`${replyJid}\`\n` +
            `• *Bound By:* @${callerName}\n` +
            `• *Status:* LIVE & ACTIVE ✅\n\n` +
            `_Type *!help* to inspect all scoped commands for ${matched.name}._`
    });
  } else {
    await safeSendMessage(replyJid, {
      text: `❌ Database update failed: HTTP ${patchRes.status}`
    });
  }
}

// =============================================================================
// TIER 1: SHOP / TENANT COMMAND HANDLER (Strictly Isolated to Shop ID)
// =============================================================================
async function handleShopCommand(command, args, replyJid, senderId, callerName, context, safeSendMessage) {
  const shop = context.shop;
  const isMgmt = context.role === "MANAGEMENT";

  // Platform-only commands not applicable to shop groups
  const platformOnlyCommands = ["shops", "stores", "bind", "ticket", "resolve"];
  const bareCommand = command.replace(/^!/, "");
  if (platformOnlyCommands.includes(bareCommand)) {
    await safeSendMessage(replyJid, {
      text: `⚠️ *Command Not Applicable*\n\`${command}\` is reserved for platform administration channels.\nReply with *!help* to view shop commands.`
    });
    return;
  }

  // 1. Shop Help
  if (command === "!help") {
    if (context.role === "COMMUNITY") {
      const helpMsg =
        `🛍️ *Welcome to the ${shop.name} Community!* 🛍️\n\n` +
        `*Customer Commands:*\n` +
        `• *!catalog* or *!items* — Browse active showcase products & prices\n` +
        `• *!order <order_id>* — Check live delivery status & packaging notes\n` +
        `• *!status* — View showroom pickup points & store opening status\n` +
        `• *!help* — Show this customer guide\n\n` +
        `_Visit our online storefront to place orders with direct M-Pesa checkout!_`;
      await safeSendMessage(replyJid, { text: helpMsg });
      return;
    }

    if (isMgmt) {
      const helpMsg =
        `💼 *${shop.name} — Management Command Center*\n\n` +
        `*📊 Sales & Performance:*\n` +
        `• *!summary [today | week | month]* — Gross revenue, ticket size & order volume\n` +
        `• *!orders [today | month | paid | pending]* — Scoped shop orders audit\n` +
        `• *!status* — Live shop vitals, open orders & till status\n\n` +
        `*🏷️ Product Catalog Management:*\n` +
        `• *!product add* — Generate copy-paste product template\n` +
        `• *!product edit <name or ID>* — Get pre-filled editable card\n` +
        `• *!product price <name or ID> <price>* — Safely update price with ambiguity check\n` +
        `• *!product stock* — View inventory overview (in-stock vs out)\n` +
        `• *!product stock <name or ID> <in | out>* — Toggle item availability\n` +
        `• *!product list [category]* — View active items\n\n` +
        `_All modifications publish live to your online storefront immediately._`;
      await safeSendMessage(replyJid, { text: helpMsg });
      return;
    } else {
      const helpMsg =
        `🏬 *${shop.name} — Floor Operations*\n\n` +
        `*📦 5-Station Order Operations:*\n` +
        `• *!orders [today | pending | paid | pack]* — View active order pipeline\n` +
        `• *!order <id>* — Deep dive into customer items & pickup notes\n` +
        `• *!paid <id> <mpesa_code>* — Confirm cashier payment\n` +
        `• *!pack <id>* — Mark boxed & packaged\n` +
        `• *!verify <id>* — QA packing slip checklist check\n` +
        `• *!dispatch <id> [courier]* — Courier handoff & fulfill\n` +
        `• *!status* — View pending orders count & till status\n\n` +
        `_Note: Financial summaries & product catalog editing are restricted to Management._`;
      await safeSendMessage(replyJid, { text: helpMsg });
      return;
    }
  }

  // 2. Shop Status & Vitals
  if (command === "!status" || command === "!health") {
    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

      const [inFlightRes, todayRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/orders?shop_id=eq.${shop.id}&status=neq.dispatched&status=neq.cancelled&status=neq.archived&select=id,status`, { headers: dbHdrs }),
        fetch(`${SUPABASE_URL}/rest/v1/orders?shop_id=eq.${shop.id}&created_at=gte.${startOfDay}&select=id,total_price,status`, { headers: dbHdrs })
      ]);

      const inFlight = await inFlightRes.json();
      const todayOrders = await todayRes.json();

      let todayRevenue = 0;
      let todayPaidCount = 0;
      for (const o of (todayOrders || [])) {
        if (o.status === "paid" || o.status === "dispatched") {
          todayRevenue += Number(o.total_price) || 0;
          todayPaidCount++;
        }
      }

      const reply =
        `🏪 *${shop.name} — Shop Vitals*\n` +
        `╭────────────────────────────────╮\n` +
        `  • Status: *ACTIVE / OPEN*\n` +
        `  • Master Till: *${shop.mpesa_till_number || "Not Configured"}*\n` +
        `  • Open Orders in Queue: *${(inFlight || []).length}*\n` +
        `  • Settled Today: *KES ${todayRevenue.toLocaleString()}* (${todayPaidCount} orders)\n` +
        `  • Support Phone: ${shop.phone || "None"}\n` +
        `╰────────────────────────────────╯\n` +
        `_Channel: ${context.role === "MANAGEMENT" ? "Management Oversight" : "Floor Operations"}_`;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Failed to fetch shop status: ${err.message}` });
      return;
    }
  }

  // 3. Shop Orders Query: !orders [filter]
  if (command === "!orders") {
    const filter = args.trim().toLowerCase();
    try {
      const orders = await queryShopOrders(shop.id, filter);
      if (!orders || orders.length === 0) {
        await safeSendMessage(replyJid, {
          text: `🛒 *${shop.name} Orders:*\nNo orders found matching filter: \`${filter || "active in-flight"}\`.`
        });
        return;
      }

      let reply = `🛒 *${shop.name} Orders (${filter || "Active Queue"} - ${orders.length} found)*\n\n`;
      orders.slice(0, 10).forEach(o => {
        const icon = o.status === "paid" ? "💳" : o.status === "dispatched" ? "🚚" : o.status === "pending" ? "🟡" : "📦";
        const displayId = formatDisplayOrderId(o);
        const customer = o.client_name ? ` — ${o.client_name}` : "";
        const mpesa = o.mpesa_code ? ` (Ref: \`${o.mpesa_code}\`)` : "";
        reply += `${icon} *${displayId}* [${(o.status || "PENDING").toUpperCase()}] KES ${Number(o.total_price || 0).toLocaleString()}${customer}${mpesa}\n`;
      });
      if (orders.length > 10) {
        reply += `\n_...and ${orders.length - 10} more orders._`;
      }
      reply += `\n\n👉 _Inspect order with:_ \`!order <order_id>\``;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Failed to query orders: ${err.message}` });
      return;
    }
  }

  // 4. Shop Order Deep-Dive: !order <id> or !details <id>
  if (command === "!order" || command === "!details") {
    const orderId = args.trim();
    if (!orderId) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!order <order_id>\`` });
      return;
    }

    try {
      const o = await resolveShopOrder(shop.id, orderId);
      if (!o) {
        await safeSendMessage(replyJid, { text: `❌ Order \`${orderId}\` not found for ${shop.name}.` });
        return;
      }

      const displayId = formatDisplayOrderId(o);
      const reply =
        `🔍 *[ORDER DETAILS - ${shop.name.toUpperCase()}]*\n` +
        `╭────────────────────────────────────────╮\n` +
        `  • Order: *${displayId}* (\`${o.id.slice(0, 8)}\`)\n` +
        `  • Status: *${(o.status || "PENDING").toUpperCase()}*\n` +
        `  • Customer: *${o.client_name || "Guest Customer"}* (${o.client_phone || "No phone"})\n` +
        `  • Total: *KES ${Number(o.total_price || 0).toLocaleString()}*\n` +
        `  • M-Pesa Code: \`${o.mpesa_code || "PENDING"}\`\n` +
        `  • Fulfillment: ${o.fulfillment_type || "Pickup"}\n` +
        `  • Address: ${o.delivery_address || (o.fulfillment_type === "pickup" ? "In-Store Pickup" : "Direct Customer Handover")}\n` +
        `  • Created: ${new Date(o.created_at).toLocaleString()}\n` +
        `  • Notes: ${o.notes || "None"}\n` +
        `╰────────────────────────────────────────╯\n` +
        `_Action:_ \`!paid ${o.id.slice(0, 8)} <ref>\` | \`!pack ${o.id.slice(0, 8)}\` | \`!dispatch ${o.id.slice(0, 8)} [rider]\``;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Order lookup error: ${err.message}` });
      return;
    }
  }

  // 5. Payment Verification: !paid <id> <ref>
  if (command === "!paid") {
    const match = args.match(/^(\S+)\s+(\S+)$/i);
    if (!match) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!paid <order_id> <mpesa_code>\`\nExample: \`!paid 832f1b75 SHK89271KJ\`` });
      return;
    }
    const orderId = match[1];
    const code = match[2].toUpperCase();

    try {
      const o = await resolveShopOrder(shop.id, orderId);
      if (!o) {
        await safeSendMessage(replyJid, { text: `❌ Order \`${orderId}\` not found for ${shop.name}.` });
        return;
      }

      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
        method: "PATCH",
        headers: { ...dbHdrs, "Prefer": "return=representation" },
        body: JSON.stringify({ status: "paid", mpesa_code: code })
      });
      const updated = await patchRes.json();
      const updatedOrder = updated?.[0] || o;
      const displayId = formatDisplayOrderId(updatedOrder);

      const paidMsg = `💳 *Payment Verified — ${shop.name}*\n• Order: *${displayId}* (\`${updatedOrder.id.slice(0, 8)}\`)\n• Customer: ${updatedOrder.client_name || "Guest"}\n• Ref: \`${code}\`\n• Amount: *KES ${Number(updatedOrder.total_price).toLocaleString()}*\n• Status: *PAID & SETTLED* ✅\n• Verified By: @${callerName}\n• Next: \`!pack ${updatedOrder.id.slice(0, 8)}\``;
      await safeSendMessage(replyJid, { text: paidMsg });

      // Mirror payment update to Shop Management Group, Perpetua Main Floor Ops, and Admin Oversight
      const routing = shop.fulfillment_settings?.whatsapp_routing || {};
      const mirrorTargets = new Set([
        routing.management_jid,
        GROUPS?.general?.jid || "120363429929736148@g.us",
        GROUPS?.adminOversight?.jid || "120363415291701803@g.us"
      ].filter(jid => jid && jid !== replyJid));
      for (const targetJid of mirrorTargets) {
        await safeSendMessage(targetJid, { text: paidMsg });
      }
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Payment update failed: ${err.message}` });
      return;
    }
  }

  // 6. Station Handoffs: !pack, !verify, !dispatch, !delivered, !confirm
  if (command === "!pack" || command === "!verify" || command === "!dispatch" || command === "!delivered" || command === "!confirm") {
    let orderId = args.trim();
    let courier = "Assigned Rider";
    if (command === "!dispatch" || command === "!delivered") {
      const dMatch = args.match(/^(\S+)(?:\s+(.+))?$/i);
      if (dMatch) {
        orderId = dMatch[1];
        if (dMatch[2]) courier = dMatch[2].trim();
      }
    }

    if (!orderId) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`${command} <order_id>\`` });
      return;
    }

    const stationMap = {
      "!pack":      { internal: "PACKAGING",  dbStatus: null,         label: "PACKAGING (Crafting & Boxed)" },
      "!verify":    { internal: "VERIFIED",   dbStatus: null,         label: "QA & PAYMENT VERIFIED" },
      "!dispatch":  { internal: "IN_TRANSIT", dbStatus: "dispatched", label: "DISPATCHED (In Transit with Rider)" },
      "!delivered": { internal: "DELIVERED",  dbStatus: "dispatched", label: "DELIVERED BY RIDER (Awaiting Customer Confirmation)" },
      "!confirm":   { internal: "COMPLETED",  dbStatus: "completed",  label: "COMPLETED (Dual Rider + Customer Confirmed)" }
    };
    const st = stationMap[command];

    try {
      const o = await resolveShopOrder(shop.id, orderId);
      if (!o) {
        await safeSendMessage(replyJid, { text: `❌ Order \`${orderId}\` not found for ${shop.name}.` });
        return;
      }

      const patchPayload = { internal_status: st.internal };
      if (st.dbStatus) patchPayload.status = st.dbStatus;

      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
        method: "PATCH",
        headers: { ...dbHdrs, "Prefer": "return=representation" },
        body: JSON.stringify(patchPayload)
      });
      const updated = await patchRes.json();
      const updatedOrder = updated?.[0] || o;
      const displayId = formatDisplayOrderId(updatedOrder);
      const courierLine = (command === "!dispatch" || command === "!delivered") ? `\n• Rider: *${courier}*` : "";

      const progressMsg =
        `📦 *Order Station Update — ${shop.name}*\n` +
        `• Order: *${displayId}* (\`${updatedOrder.id.slice(0, 8)}\`)\n` +
        `• Customer: ${updatedOrder.client_name || "Guest"} (${updatedOrder.client_phone || "N/A"})\n` +
        `• Station: *${st.label}* ✅${courierLine}\n` +
        `• Total: KES ${Number(updatedOrder.total_price || 0).toLocaleString()}\n` +
        `• Actor: @${callerName}`;

      await safeSendMessage(replyJid, { text: progressMsg });

      // Mirror station progression to Perpetua Main Group (perpetua) & Shop Management
      const routing = shop.fulfillment_settings?.whatsapp_routing || {};
      const mirrorJids = new Set([
        GROUPS?.general?.jid || "120363429929736148@g.us",
        routing.operations_jid,
        (command === "!dispatch" || command === "!delivered" || command === "!confirm") ? routing.management_jid : null,
        (command === "!delivered" || command === "!confirm") ? (GROUPS?.adminOversight?.jid || "120363415291701803@g.us") : null
      ].filter(jid => jid && jid !== replyJid));

      for (const mJid of mirrorJids) {
        await safeSendMessage(mJid, { text: progressMsg });
      }
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Station update failed: ${err.message}` });
      return;
    }
  }

  // 7. Scoped Financial Summary: !summary or !sales
  if (command === "!summary" || command === "!sales" || command === "!pulse") {
    if (!isMgmt) {
      await safeSendMessage(replyJid, {
        text: `🔒 *Access Restricted*\nFinancial summaries for ${shop.name} can only be viewed in the *Management* channel.`
      });
      return;
    }

    const timeframe = args.toLowerCase().trim() || "today";
    try {
      const s = await calculateShopSummary(shop.id, timeframe);
      const reply =
        `📊 *${shop.name} — Sales & Revenue Snapshot*\n` +
        `╭────────────────────────────────────────╮\n` +
        `  • Window: *${timeframe.toUpperCase()}*\n` +
        `  • Gross Settled: *KES ${s.grossRevenue.toLocaleString()}*\n` +
        `  • Settled Orders: *${s.paidOrders}*\n` +
        `  • Pending Payment: *${s.pendingOrders}*\n` +
        `  • Avg Ticket Size: *KES ${s.avgTicket.toFixed(0)}*\n` +
        `╰────────────────────────────────────────╯\n` +
        `_Triggered by @${callerName}_`;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Failed to calculate summary: ${err.message}` });
      return;
    }
  }

  // 8. In-Chat Product & Catalog Management: !product, !approve, !hide, !drafts, !policy
  if (command === "!product" || command === "!item" || command === "!items" || command === "!catalog" ||
      command === "!approve" || command === "!hide" || command === "!drafts" || command === "!policy") {
    
    // Public catalog view is permitted for everyone (customers, community members, staff)
    const isPublicCatalogView = (command === "!catalog" || command === "!items" || (command === "!product" && (!args || args.startsWith("list"))));
    if (!isMgmt && !isPublicCatalogView) {
      await safeSendMessage(replyJid, {
        text: `🔒 *Access Restricted*\nProduct catalog editing is restricted to *${shop.name} Management*.`
      });
      return;
    }

    // Direct command shortcuts: !approve <id> -> subAction approve
    let effectiveArgs = args;
    if (command === "!catalog" || command === "!items") {
      effectiveArgs = `list ${args}`.trim();
    } else if (command === "!approve" || command === "!hide" || command === "!drafts" || command === "!policy") {
      effectiveArgs = `${command.slice(1)} ${args}`.trim();
    }

    return await handleProductManagementCommand(effectiveArgs, replyJid, shop, safeSendMessage, isMgmt);
  }

  // 9. Order Resurrection: !resurrect <order_id> or !revive <order_id>
  if (command === "!resurrect" || command === "!revive") {
    return await handleResurrectCommand(args, replyJid, senderId, callerName, safeSendMessage, shop);
  }

  // 10. 1-Tap Re-order: !reorder <order_id> or !repeat or !buyagain
  if (command === "!reorder" || command === "!repeat" || command === "!buyagain") {
    return await handleReorderCommand(args, replyJid, senderId, callerName, safeSendMessage, shop);
  }

  // Fallback
  await safeSendMessage(replyJid, {
    text: `❓ *Unknown command for ${shop.name}:* \`${command}\`\nType *!help* to view available commands.`
  });
}

// =============================================================================
// SUB-ROUTINE: PRODUCT MANAGEMENT WITH AMBIGUITY GUARDS & TEMPLATES
// =============================================================================
async function handleProductManagementCommand(rawArgs, replyJid, shop, safeSendMessage, isMgmt = true) {
  const parts = rawArgs.split(/\s+/);
  const subAction = parts[0] ? parts[0].toLowerCase() : "list";
  const subArgs = rawArgs.substring(subAction.length).trim();

  // 8a. List Products: !product list [category]
  if (subAction === "list" || (!subAction && !rawArgs)) {
    try {
      const items = await listShopProducts(shop.id, subArgs);
      if (!items || items.length === 0) {
        await safeSendMessage(replyJid, {
          text: `🏷️ *${shop.name} Catalog:*\nNo active items found matching category: \`${subArgs || "all"}\`.\n\n${isMgmt ? "👉 Type *!product add* to create your first item!" : "Please check back later for new arrivals!"}`
        });
        return;
      }
      let reply = `🏷️ *${shop.name} Showcase (${items.length} items)*\n\n`;
      items.slice(0, 15).forEach(it => {
        const shortId = it.id.slice(0, 8);
        reply += `• *\`${shortId}\`* ${it.name} — *KES ${Number(it.price).toLocaleString()}* [_${it.category || "General"}_]\n`;
      });
      if (items.length > 15) {
        reply += `\n_...and ${items.length - 15} more items._`;
      }
      if (isMgmt) {
        reply += `\n\n👉 *Quick Actions:*\n• Edit item: \`!product edit <ID or Name>\`\n• Change price: \`!product price <ID or Name> <NewPrice>\`\n• Add new: \`!product add\``;
      } else {
        reply += `\n\n🛍️ _Visit our storefront link to order with instant M-Pesa payment._`;
      }
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Product list failed: ${err.message}` });
      return;
    }
  }

  // 8b. Add Product Template: !product add (No parameters -> returns copy-paste template)
  if (subAction === "add" || subAction === "new") {
    // If user provided pipe arguments directly: !product add Name | Price | Category | Description
    if (subArgs.includes("|")) {
      const segments = subArgs.split("|").map(s => s.trim());
      const [name, priceStr, category, description] = segments;
      const priceNum = Number(priceStr);
      if (!name || isNaN(priceNum) || priceNum <= 0) {
        await safeSendMessage(replyJid, {
          text: `❌ *Invalid Input:* Name and positive numeric price are required.\nExample: \`!product add Silk Scarf | 1500 | Accessories | Pure silk\``
        });
        return;
      }
      try {
        const product = await addShopProduct(shop.id, {
          name,
          price: priceNum,
          category: category || "General",
          description: description || ""
        });
        await safeSendMessage(replyJid, {
          text: `✅ *Product Successfully Created — ${shop.name}*\n\n` +
                `• *Item:* ${product.name}\n` +
                `• *Price:* KES ${Number(product.price).toLocaleString()}\n` +
                `• *Category:* ${product.category}\n` +
                `• *ID:* \`${product.id.slice(0, 8)}\`\n` +
                `• *Status:* LIVE on storefront immediately! 🛍️`
        });
        return;
      } catch (err) {
        await safeSendMessage(replyJid, { text: `❌ Creation error: ${err.message}` });
        return;
      }
    }

    // Return the clean, friction-free copy-paste template tailored to store category
    const isFood = /kitchen|bistro|cafe|food|restaurant|grocery|bakery/i.test(shop.name);
    const sampleName = isFood ? "Signature Chicken Combo" : "Classic Cotton Apparel";
    const samplePrice = isFood ? "850" : "1500";
    const sampleCat = isFood ? "Mains" : "Catalog";
    const sampleDesc = isFood ? "Served fresh with side salad" : "Premium quality combed material";

    const templateMsg =
      `📝 *Add Product Template — ${shop.name}*\n` +
      `Copy the box below, fill in your actual product details, and send it back:\n\n` +
      `\`\`\`\n` +
      `!product create\n` +
      `Name: ${sampleName}\n` +
      `Price: ${samplePrice}\n` +
      `Category: ${sampleCat}\n` +
      `Description: ${sampleDesc}\n` +
      `\`\`\`\n\n` +
      `_Tip: You can also attach a photo of the item when sending this command!_`;
    await safeSendMessage(replyJid, { text: templateMsg });
    return;
  }

  // 8c. Create from Key-Value Template Submission: !product create
  if (subAction === "create") {
    const lines = subArgs.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const parsed = {};
    for (const line of lines) {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim().toLowerCase();
        parsed[key] = match[2].trim();
      }
    }

    const name = parsed.name || parsed["product name"] || parsed.title;
    const priceStr = parsed.price || parsed.amount;
    const category = parsed.category || "General";
    const description = parsed.description || parsed.desc || "";

    const priceNum = Number(priceStr);
    if (!name || isNaN(priceNum) || priceNum <= 0) {
      await safeSendMessage(replyJid, {
        text: `❌ *Validation Error:*\nBoth *Name* and a positive *Price* are required.\n\nMake sure your submission follows the format:\n\`Name: ...\`\n\`Price: ...\``
      });
      return;
    }

    try {
      const product = await addShopProduct(shop.id, {
        name,
        price: priceNum,
        category,
        description
      });
      await safeSendMessage(replyJid, {
        text: `✅ *Product Successfully Created — ${shop.name}*\n\n` +
              `• *Item:* ${product.name}\n` +
              `• *Price:* KES ${Number(product.price).toLocaleString()}\n` +
              `• *Category:* ${product.category}\n` +
              `• *ID:* \`${product.id.slice(0, 8)}\`\n` +
              `• *Live on Storefront:* Yes ✅`
      });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Creation error: ${err.message}` });
      return;
    }
  }

  // 8d. Edit Product: !product edit <name or ID>
  if (subAction === "edit") {
    const query = subArgs.trim();
    if (!query) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!product edit <Item Name or ID>\`` });
      return;
    }

    const res = await resolveShopProduct(shop.id, query);
    if (res.status === "NONE") {
      await safeSendMessage(replyJid, { text: `❌ No product matching \`${query}\` found in ${shop.name}.` });
      return;
    }
    if (res.status === "AMBIGUOUS") {
      let list = `⚠️ *Multiple Products Found matching "${query}":*\n\n`;
      res.matches.slice(0, 5).forEach((m, idx) => {
        list += `${idx + 1}. *${m.name}* (ID: \`${m.id.slice(0, 8)}\`) — KES ${Number(m.price).toLocaleString()}\n`;
      });
      list += `\n👉 _Please specify exact ID:_ \`!product edit <ID>\``;
      await safeSendMessage(replyJid, { text: list });
      return;
    }

    const p = res.product;
    const shortId = p.id.slice(0, 8);
    const editTemplate =
      `📋 *Editable Product Card — ${shop.name}*\n` +
      `Copy the box below, edit any values, and send it back:\n\n` +
      `\`\`\`\n` +
      `!product save ${shortId}\n` +
      `Name: ${p.name}\n` +
      `Price: ${p.price}\n` +
      `Category: ${p.category || "General"}\n` +
      `In Stock: ${p.is_active ? "yes" : "no"}\n` +
      `Description: ${p.description || "None"}\n` +
      `\`\`\`\n`;
    await safeSendMessage(replyJid, { text: editTemplate });
    return;
  }

  // 8e. Save Edited Product: !product save <ID>
  if (subAction === "save") {
    const lines = subArgs.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    const shortId = firstLine.split(/\s+/)[0];

    if (!shortId) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!product save <ID>\` followed by key-value lines.` });
      return;
    }

    const res = await resolveShopProduct(shop.id, shortId);
    if (res.status !== "EXACT") {
      await safeSendMessage(replyJid, { text: `❌ Product ID \`${shortId}\` not found for ${shop.name}.` });
      return;
    }

    const p = res.product;
    const parsed = {};
    for (let i = 1; i < lines.length; i++) {
      const match = lines[i].match(/^([^:]+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim().toLowerCase();
        parsed[key] = match[2].trim();
      }
    }

    const updates = {};
    if (parsed.name) updates.name = parsed.name;
    if (parsed.price && !isNaN(Number(parsed.price)) && Number(parsed.price) > 0) {
      updates.price = Number(parsed.price);
    }
    if (parsed.category) updates.category = parsed.category;
    if (parsed["in stock"]) {
      updates.is_active = /^(yes|true|in)$/i.test(parsed["in stock"]);
    }
    if (parsed.description) updates.description = parsed.description;

    try {
      const updated = await updateShopProductFields(shop.id, p.id, updates);
      await safeSendMessage(replyJid, {
        text: `✅ *Product Updated Successfully — ${shop.name}*\n\n` +
              `• *Item:* ${updated.name}\n` +
              `• *Price:* KES ${Number(updated.price).toLocaleString()}\n` +
              `• *Category:* ${updated.category}\n` +
              `• *Availability:* ${updated.is_active ? "IN STOCK ✅" : "OUT OF STOCK ❌"}\n` +
              `• *Status:* Synchronized with online catalog.`
      });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Update error: ${err.message}` });
      return;
    }
  }

  // 8f. Safe Price Update: !product price <Query> <NewPrice> [confirm]
  if (subAction === "price") {
    const pMatch = subArgs.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)(?:\s+(confirm))?$/i);
    if (!pMatch) {
      await safeSendMessage(replyJid, {
        text: `⚠️ *Usage:* \`!product price <Name or ID> <NewPrice>\`\nExample: \`!product price Beginner Kit 2600\``
      });
      return;
    }

    const [, query, priceStr, confirmFlag] = pMatch;
    const newPrice = Number(priceStr);

    if (newPrice <= 0) {
      await safeSendMessage(replyJid, { text: `❌ Price must be a positive number greater than 0.` });
      return;
    }

    const res = await resolveShopProduct(shop.id, query);
    if (res.status === "NONE") {
      await safeSendMessage(replyJid, { text: `❌ No product matching \`${query}\` found in ${shop.name}.` });
      return;
    }

    if (res.status === "AMBIGUOUS") {
      let list = `⚠️ *Multiple Products Found matching "${query}":*\nWhich one do you want to re-price?\n\n`;
      res.matches.slice(0, 5).forEach((m, idx) => {
        list += `${idx + 1}. *${m.name}* (ID: \`${m.id.slice(0, 8)}\`) — Current: KES ${Number(m.price).toLocaleString()}\n`;
      });
      list += `\n👉 _Please use the exact ID:_ \`!product price <ID> ${newPrice}\``;
      await safeSendMessage(replyJid, { text: list });
      return;
    }

    const p = res.product;
    const currentPrice = Number(p.price) || 0;

    // Drastic Price Change Guard (More than 3x increase or more than 75% drop)
    const isDrasticDrop = currentPrice > 0 && newPrice < (currentPrice * 0.25);
    const isDrasticSpike = currentPrice > 0 && newPrice > (currentPrice * 3.5);

    if ((isDrasticDrop || isDrasticSpike) && !confirmFlag) {
      const dropSpikeText = isDrasticDrop ? "drastic drop (-75%+)" : "drastic increase (+300%+)";
      await safeSendMessage(replyJid, {
        text: `⚠️ *Price Safety Alert — Potential Typo Detected*\n\n` +
              `• *Product:* ${p.name} (\`${p.id.slice(0, 8)}\`)\n` +
              `• *Current Price:* KES ${currentPrice.toLocaleString()}\n` +
              `• *Proposed Price:* *KES ${newPrice.toLocaleString()}* (${dropSpikeText})\n\n` +
              `_If this was intentional, re-send with 'confirm':_\n` +
              `\`!product price ${p.id.slice(0, 8)} ${newPrice} confirm\``
      });
      return;
    }

    try {
      const updated = await updateShopProductFields(shop.id, p.id, { price: newPrice });
      const diff = newPrice - currentPrice;
      const diffStr = diff >= 0 ? `+KES ${diff.toLocaleString()}` : `-KES ${Math.abs(diff).toLocaleString()}`;
      await safeSendMessage(replyJid, {
        text: `🏷️ *Price Updated Successfully — ${shop.name}*\n\n` +
              `• *Item:* ${updated.name}\n` +
              `• *Old Price:* KES ${currentPrice.toLocaleString()}\n` +
              `• *New Price:* *KES ${newPrice.toLocaleString()}* (${diffStr})\n` +
              `• *Status:* Live on storefront immediately ✅`
      });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Price update error: ${err.message}` });
      return;
    }
  }

  // 8g. Inventory & Stock: !product stock [Query] [in|out]
  if (subAction === "stock") {
    // If no query provided: return overall inventory status
    if (!subArgs) {
      try {
        const inv = await getShopInventoryOverview(shop.id);
        let reply =
          `📦 *${shop.name} — Inventory Health*\n` +
          `╭────────────────────────────────╮\n` +
          `  • Total Products: ${inv.total}\n` +
          `  • Active In Stock: *${inv.inStockCount}* ✅\n` +
          `  • Out of Stock: *${inv.outOfStockCount}* ❌\n` +
          `╰────────────────────────────────╯\n`;

        if (inv.outOfStockCount > 0) {
          reply += `\n❌ *Currently Out of Stock Items:*\n`;
          inv.outOfStock.slice(0, 8).forEach(it => {
            reply += `  • *\`${it.id.slice(0, 8)}\`* ${it.name} (KES ${Number(it.price).toLocaleString()})\n`;
          });
          reply += `\n👉 _To restore an item to stock:_ \`!product stock <ID> in\``;
        } else {
          reply += `\n✨ _All catalog products are active and in stock!_`;
        }

        await safeSendMessage(replyJid, { text: reply });
        return;
      } catch (err) {
        await safeSendMessage(replyJid, { text: `❌ Inventory check error: ${err.message}` });
        return;
      }
    }

    // Toggle specific item: !product stock <query> <in|out>
    const sMatch = subArgs.match(/^(.+?)\s+(in|out|true|false)$/i);
    if (!sMatch) {
      await safeSendMessage(replyJid, {
        text: `⚠️ *Usage:* \`!product stock <Name or ID> <in | out>\`\nExample: \`!product stock Beginner Kit out\``
      });
      return;
    }

    const [, query, stateStr] = sMatch;
    const inStock = /^(in|true)$/i.test(stateStr);

    const res = await resolveShopProduct(shop.id, query);
    if (res.status === "NONE") {
      await safeSendMessage(replyJid, { text: `❌ Product matching \`${query}\` not found in ${shop.name}.` });
      return;
    }

    if (res.status === "AMBIGUOUS") {
      let list = `⚠️ *Multiple Products Found matching "${query}":*\nWhich item do you want to toggle?\n\n`;
      res.matches.slice(0, 5).forEach((m, idx) => {
        list += `${idx + 1}. *${m.name}* (ID: \`${m.id.slice(0, 8)}\`) — Current: ${m.is_active ? 'In Stock ✅' : 'Out ❌'}\n`;
      });
      list += `\n👉 _Please use the exact ID:_ \`!product stock <ID> ${inStock ? 'in' : 'out'}\``;
      await safeSendMessage(replyJid, { text: list });
      return;
    }

    const p = res.product;
    try {
      const updated = await updateShopProductFields(shop.id, p.id, { is_active: inStock });
      await safeSendMessage(replyJid, {
        text: `📦 *Inventory Status Updated — ${shop.name}*\n\n` +
              `• *Item:* ${updated.name}\n` +
              `• *New Status:* ${inStock ? "IN STOCK ✅ (Visible in storefront)" : "OUT OF STOCK ❌ (Hidden from customers)"}\n` +
              `• *ID:* \`${updated.id.slice(0, 8)}\``
      });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Stock update error: ${err.message}` });
      return;
    }
  }

  // 8f. Approve Draft: !product approve <id | all>
  if (subAction === "approve") {
    if (!subArgs) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!product approve <ID or all>\`\nExample: \`!product approve 5b0cd3f1\` or \`!product approve all\`` });
      return;
    }

    try {
      if (subArgs.toLowerCase() === "all") {
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shop.id}&is_active=eq.false`, {
          method: "PATCH",
          headers: { ...dbHdrs, "Prefer": "return=representation" },
          body: JSON.stringify({ is_active: true })
        });
        const approved = await patchRes.json();
        const count = Array.isArray(approved) ? approved.length : 0;
        await safeSendMessage(replyJid, {
          text: `✅ *Batch Approved — ${shop.name}*\n` +
                `Published *${count}* draft item(s) live to your storefront! 🌐`
        });
        return;
      }

      const res = await resolveShopProduct(shop.id, subArgs);
      if (res.status === "NONE") {
        await safeSendMessage(replyJid, { text: `❌ Could not find product matching: \`${subArgs}\`` });
        return;
      }
      if (res.status === "AMBIGUOUS") {
        const list = res.matches.map(m => `• *${m.name}* (\`${m.id.slice(0, 8)}\`)`).join("\n");
        await safeSendMessage(replyJid, { text: `⚠️ Multiple matches found. Please specify by short ID:\n${list}` });
        return;
      }

      const p = res.product;
      const updated = await updateShopProductFields(shop.id, p.id, { is_active: true });
      await safeSendMessage(replyJid, {
        text: `✅ *Product Approved & Published — ${shop.name}*\n\n` +
              `• *Item:* ${updated.name}\n` +
              `• *Price:* KES ${Number(updated.price).toLocaleString()}\n` +
              `• *Status:* LIVE on Storefront 🟢\n` +
              `• *ID:* \`${updated.id.slice(0, 8)}\`\n\n` +
              `_Customers can now order this item._`
      });

      // Auto-broadcast new drop to WhatsApp Channel if configured
      await broadcastProductToChannel(shop, updated, safeSendMessage);
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Approval error: ${err.message}` });
      return;
    }
  }

  // 8g. Hide / Unpublish Product: !product hide <id>
  if (subAction === "hide" || subAction === "unpublish") {
    if (!subArgs) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!product hide <ID or Name>\`` });
      return;
    }

    try {
      const res = await resolveShopProduct(shop.id, subArgs);
      if (res.status === "NONE") {
        await safeSendMessage(replyJid, { text: `❌ Could not find product matching: \`${subArgs}\`` });
        return;
      }
      if (res.status === "AMBIGUOUS") {
        const list = res.matches.map(m => `• *${m.name}* (\`${m.id.slice(0, 8)}\`)`).join("\n");
        await safeSendMessage(replyJid, { text: `⚠️ Multiple matches found. Please specify by short ID:\n${list}` });
        return;
      }

      const p = res.product;
      const updated = await updateShopProductFields(shop.id, p.id, { is_active: false });
      await safeSendMessage(replyJid, {
        text: `🚫 *Product Unpublished (Hidden) — ${shop.name}*\n\n` +
              `• *Item:* ${updated.name}\n` +
              `• *Status:* Hidden from Storefront 🟡\n` +
              `• *ID:* \`${updated.id.slice(0, 8)}\`\n\n` +
              `👉 _To re-publish at any time:_ \`!product approve ${updated.id.slice(0, 8)}\``
      });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Hide error: ${err.message}` });
      return;
    }
  }

  // 8h. View Drafts: !product drafts
  if (subAction === "drafts" || subAction === "draft") {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shop.id}&is_active=eq.false&select=id,name,price,category,created_at&order=created_at.desc`, { headers: dbHdrs });
      const drafts = await res.json();

      if (!drafts || drafts.length === 0) {
        await safeSendMessage(replyJid, {
          text: `✨ *${shop.name} Draft Vault*\n` +
                `No pending drafts! All catalog products are published and live on your storefront.`
        });
        return;
      }

      let reply = `📋 *${shop.name} Pending Drafts (${drafts.length} awaiting approval)*\n\n`;
      drafts.slice(0, 10).forEach((d, idx) => {
        reply += `${idx + 1}. *${d.name}* — KES ${Number(d.price).toLocaleString()} (\`${d.id.slice(0, 8)}\`)\n`;
      });
      if (drafts.length > 10) {
        reply += `\n_...and ${drafts.length - 10} more drafts._\n`;
      }
      reply += `\n👉 *Actions:*\n` +
               `• Approve all: \`!product approve all\`\n` +
               `• Approve one: \`!product approve <ID>\``;

      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Drafts error: ${err.message}` });
      return;
    }
  }

  // 8i. View / Set Store Approval Policy: !product policy [optimistic | strict]
  if (subAction === "policy") {
    const currentPolicy = shop.fulfillment_settings?.product_approval_policy || "optimistic";
    if (!subArgs) {
      await safeSendMessage(replyJid, {
        text: `⚙️ *Product Approval Policy — ${shop.name}*\n\n` +
              `• Current Policy: *${currentPolicy.toUpperCase()}*\n` +
              `  - *OPTIMISTIC*: Ingested photos go live immediately (reject by \`!hide\`).\n` +
              `  - *STRICT*: Ingested photos stay in Draft mode until approved (\`!approve\`).\n\n` +
              `👉 _To change policy:_ \`!product policy strict\` or \`!product policy optimistic\``
      });
      return;
    }

    const newPolicy = subArgs.toLowerCase().trim();
    if (newPolicy !== "optimistic" && newPolicy !== "strict") {
      await safeSendMessage(replyJid, { text: `⚠️ Invalid policy: choose either \`optimistic\` or \`strict\`.` });
      return;
    }

    try {
      const updatedFulfillment = {
        ...(shop.fulfillment_settings || {}),
        product_approval_policy: newPolicy
      };
      await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${shop.id}`, {
        method: "PATCH",
        headers: { ...dbHdrs, "Prefer": "return=minimal" },
        body: JSON.stringify({ fulfillment_settings: updatedFulfillment })
      });
      shop.fulfillment_settings = updatedFulfillment;

      await safeSendMessage(replyJid, {
        text: `✅ *Approval Policy Updated — ${shop.name}*\n\n` +
              `New Policy: *${newPolicy.toUpperCase()}*\n` +
              (newPolicy === "strict" 
                ? `🟡 New photos will now be saved as *Drafts* awaiting \`!product approve\`.\nView pending drafts with \`!product drafts\`.`
                : `🟢 New photos will now publish *Live immediately* on your storefront.`)
      });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Policy update error: ${err.message}` });
      return;
    }
  }

  // Fallback for product subactions
  await safeSendMessage(replyJid, {
    text: `❓ *Unknown product action:* \`${subAction}\`\n\n*Available Actions:*\n• \`!product list [category]\`\n• \`!product drafts\` (Pending approval)\n• \`!product approve <ID or all>\`\n• \`!product hide <ID>\`\n• \`!product policy [optimistic|strict]\`\n• \`!product add\` (Get template)\n• \`!product edit <ID or Name>\`\n• \`!product price <ID or Name> <price>\`\n• \`!product stock [ID or Name] [in|out]\``
  });
}

// =============================================================================
// TIER 2: SYSTEM / PLATFORM COMMAND HANDLER (Cross-Tenant Admin & Infrastructure)
// =============================================================================
async function handleSystemCommand(command, args, replyJid, senderId, callerName, context, safeSendMessage) {

  // 1. System Help
  if (command === "!help") {
    const helpMsg =
      `🤖 *Perpetua Platform Executive Command Center*\n\n` +
      `*🛡️ Multi-Tenant Commerce Governance:*\n` +
      `• *!shops [query]* — Real-time directory of all 17 stores, slugs & WhatsApp links\n` +
      `• *!summary* — Platform-wide gross merchandise value & order volume\n` +
      `• *!summary <shop_slug>* — Drill down into a specific store's financial pulse\n` +
      `• *!shop bind <shop_slug> [ops|mgmt]* — Link a WhatsApp group to any shop\n` +
      `• *!status* / *!health* — Live platform vitals, gateway uptime & in-flight queues\n` +
      `• *!ticket <desc>* — Log an incident alert to Perpetua IT Helpdesk\n` +
      `• *!resolve <id> [notes]* — Close an incident ticket\n\n` +
      `_Channels: perpetua (Platform Ops) | IT Helpdesk | Admin Oversight_`;
    await safeSendMessage(replyJid, { text: helpMsg });
    return;
  }

  // 2. System Status & Vitals (Real Live Platform Telemetry from Supabase & Gateway)
  if (command === "!status" || command === "!health") {
    try {
      const shops = await getAllShops();
      const boundOps = shops.filter(s => s.fulfillment_settings?.whatsapp_routing?.operations_jid).length;
      const boundMgmt = shops.filter(s => s.fulfillment_settings?.whatsapp_routing?.management_jid).length;

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?created_at=gte.${startOfDay}&select=id,total_price,status`, { headers: dbHdrs });
      const todayOrders = (await res.json()) || [];

      let todayGMV = 0;
      let todaySettled = 0;
      let todayPending = 0;
      for (const o of todayOrders) {
        if (o.status === "paid" || o.status === "dispatched") {
          todayGMV += Number(o.total_price) || 0;
          todaySettled++;
        } else if (o.status === "pending") {
          todayPending++;
        }
      }

      const reply =
        `🏥 *Perpetua Commerce Platform Vitals*\n` +
        `╭────────────────────────────────────────╮\n` +
        `  • System Status: *LIVE / PRODUCTION* ✅\n` +
        `  • Gateway Port: *5174 (Baileys Web Client)*\n` +
        `  • Database: *Supabase Connected* ✅\n` +
        `  • Registered Stores: *${shops.length} Active Tenants*\n` +
        `  • WhatsApp Linked: *${boundOps} Ops / ${boundMgmt} Mgmt*\n` +
        `  • Today's Platform GMV: *KES ${todayGMV.toLocaleString()}*\n` +
        `  • Settled Orders Today: *${todaySettled}*\n` +
        `  • In-Flight Pending: *${todayPending}*\n` +
        `╰────────────────────────────────────────╯\n` +
        `_Type *!shops* to view store list or *!summary* for GMV rollup._`;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, {
        text: `🏥 *Platform Vitals (Edge Gateway)*\n• Gateway Port 5174: ONLINE\n• Supabase Direct Link: CONNECTED\n• Error: ${err.message}`
      });
      return;
    }
  }

  // 3. Platform Cross-Tenant Summary: !summary [shop_slug]
  if (command === "!summary" || command === "!pulse") {
    if (context.role !== "EXECUTIVE") {
      await safeSendMessage(replyJid, {
        text: `🔒 For security, platform financial summaries can only be viewed in Executive Oversight.`
      });
      return;
    }

    const targetSlug = args.trim().toLowerCase();
    const shops = await getAllShops();

    if (targetSlug && targetSlug !== "all") {
      const matched = shops.find(s => s.slug.toLowerCase() === targetSlug || s.name.toLowerCase().includes(targetSlug));
      if (!matched) {
        await safeSendMessage(replyJid, {
          text: `❌ Shop \`${targetSlug}\` not found.\n👉 Type *!shops* to view all registered shop slugs.`
        });
        return;
      }
      const s = await calculateShopSummary(matched.id, "today");
      await safeSendMessage(replyJid, {
        text: `📊 *[TENANT DRILLDOWN: ${matched.name.toUpperCase()}]*\n• Gross Revenue Today: KES ${s.grossRevenue.toLocaleString()}\n• Settled Orders: ${s.paidOrders}\n• Pending: ${s.pendingOrders}\n• Avg Ticket: KES ${s.avgTicket.toFixed(0)}`
      });
      return;
    }

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?created_at=gte.${startOfDay}&select=id,total_price,status,shop_id`, { headers: dbHdrs });
      const orders = await res.json();

      let totalGross = 0;
      let totalPaid = 0;
      let totalPending = 0;
      for (const o of (orders || [])) {
        if (o.status === "paid" || o.status === "dispatched") {
          totalGross += Number(o.total_price) || 0;
          totalPaid++;
        } else if (o.status === "pending") {
          totalPending++;
        }
      }

      const reply =
        `📊 *Executive Master Rollup (Platform-Wide)*\n` +
        `╭────────────────────────────────────────╮\n` +
        `  • Active Tenants: ${shops.length}\n` +
        `  • Platform GMV Today: *KES ${totalGross.toLocaleString()}*\n` +
        `  • Settled Orders Today: *${totalPaid}*\n` +
        `  • In-Flight Pending: *${totalPending}*\n` +
        `╰────────────────────────────────────────╯\n` +
        `👉 _Drill down into a tenant:_ \`!summary <shop_slug>\``;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Failed to aggregate platform rollup: ${err.message}` });
      return;
    }
  }

  // 4. Incident Tickets: !ticket, !resolve
  if (command === "!ticket") {
    if (!args) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!ticket <description of issue>\`` });
      return;
    }
    const ticketId = `TICK-${Date.now().toString().slice(-6)}`;
    const ticketCard =
      `🚨 *NEW INCIDENT TICKET LOGGED*\n\n` +
      `• *Ticket ID:* \`${ticketId}\`\n` +
      `• *Description:* ${args}\n` +
      `• *Reported By:* @${callerName}\n` +
      `• *Timestamp:* ${new Date().toLocaleString()}\n` +
      `• *Status:* OPEN ⚠️\n\n` +
      `_Routed to Perpetua IT Helpdesk._\n` +
      `_To resolve: \`!resolve ${ticketId} [notes]\`_`;

    const itJid = GROUPS?.itHelpdesk?.jid || "120363432040872305@g.us";
    if (replyJid !== itJid) {
      await safeSendMessage(itJid, { text: ticketCard });
    }
    await safeSendMessage(replyJid, { text: ticketCard });
    return;
  }

  if (command === "!resolve") {
    const match = args.match(/^(\S+)(?:\s+(.+))?$/i);
    if (!match) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!resolve <ticket_id> [notes]\`` });
      return;
    }
    const ticketId = match[1];
    const notes = match[2] || "Resolved by operator";
    const resolveCard =
      `✅ *INCIDENT TICKET RESOLVED*\n\n` +
      `• *Ticket ID:* \`${ticketId}\`\n` +
      `• *Resolved By:* @${callerName}\n` +
      `• *Notes:* ${notes}\n` +
      `• *Status:* CLOSED ✅`;

    const itJid = GROUPS?.itHelpdesk?.jid || "120363432040872305@g.us";
    if (replyJid !== itJid) {
      await safeSendMessage(itJid, { text: resolveCard });
    }
    await safeSendMessage(replyJid, { text: resolveCard });
    return;
  }

  // 5. Platform-Wide Order Queue & Inspection in Perpetual Main Group (!orders, !order, !details)
  if (command === "!orders") {
    try {
      const shops = await getAllShops();
      const shopMap = new Map(shops.map(s => [s.id, s]));
      const cleanArg = (args || "").trim().toLowerCase();

      let filterParam = "order=created_at.desc&limit=15";
      const now = new Date();
      const matchedShop = shops.find(s => s.slug?.toLowerCase() === cleanArg || s.name?.toLowerCase().includes(cleanArg));

      if (cleanArg === "today") {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        filterParam = `created_at=gte.${startOfDay}&${filterParam}`;
      } else if (cleanArg === "pending") {
        filterParam = `status=eq.pending&${filterParam}`;
      } else if (cleanArg === "paid") {
        filterParam = `status=eq.paid&${filterParam}`;
      } else if (cleanArg === "dispatched" || cleanArg === "done") {
        filterParam = `status=eq.dispatched&${filterParam}`;
      } else if (matchedShop && cleanArg) {
        filterParam = `shop_id=eq.${matchedShop.id}&${filterParam}`;
      } else {
        filterParam = `status=neq.cancelled&${filterParam}`;
      }

      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filterParam}&select=id,shop_id,total_price,status,internal_status,created_at,client_name,client_phone,mpesa_code,notes`, { headers: dbHdrs });
      const orders = await res.json();

      if (!orders || orders.length === 0) {
        await safeSendMessage(replyJid, {
          text: `📭 *Perpetua Platform Orders (${cleanArg || "active"}):*\nNo matching orders found.`
        });
        return;
      }

      let reply = `🏬 *Perpetua Platform Orders (${cleanArg.toUpperCase() || "RECENT"} — ${orders.length} shown)*\n\n`;
      for (const o of orders) {
        const sName = shopMap.get(o.shop_id)?.name || "Store";
        const displayId = formatDisplayOrderId(o);
        const st = (o.internal_status || o.status || "PENDING").toUpperCase();
        reply += `• *${displayId}* (\`${o.id.slice(0, 8)}\`) — *${sName}*\n`;
        reply += `  └ ${o.client_name || "Guest"} | *KES ${Number(o.total_price || 0).toLocaleString()}* | [${st}]\n`;
      }
      reply += `\n👉 _Inspect order:_ \`!order <id>\` | _Advance:_ \`!paid <id> <ref>\` | \`!dispatch <id> [rider]\``;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Platform orders query failed: ${err.message}` });
      return;
    }
  }

  if (command === "!order" || command === "!details") {
    const q = args.trim();
    if (!q) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`!order <order_id>\`` });
      return;
    }
    try {
      const o = await resolveShopOrder(null, q);
      if (!o) {
        await safeSendMessage(replyJid, { text: `❌ Order \`${q}\` not found across platform stores.` });
        return;
      }
      const shops = await getAllShops();
      const shop = shops.find(s => s.id === o.shop_id) || { name: "Platform Store", id: o.shop_id };
      const displayId = formatDisplayOrderId(o);
      const reply =
        `🔍 *[PLATFORM ORDER AUDIT — ${shop.name.toUpperCase()}]*\n` +
        `╭────────────────────────────────────────╮\n` +
        `  • Order: *${displayId}* (\`${o.id.slice(0, 8)}\`)\n` +
        `  • Store: *${shop.name}*\n` +
        `  • Status: *${(o.status || "PENDING").toUpperCase()}* (${o.internal_status || "STANDARD"})\n` +
        `  • Customer: *${o.client_name || "Guest"}* (${o.client_phone || "No phone"})\n` +
        `  • Total: *KES ${Number(o.total_price || 0).toLocaleString()}*\n` +
        `  • M-Pesa Ref: \`${o.mpesa_code || "PENDING"}\`\n` +
        `  • Created: ${new Date(o.created_at).toLocaleString()}\n` +
        `╰────────────────────────────────────────╯\n` +
        `_Actions:_ \`!paid ${o.id.slice(0, 8)} <ref>\` | \`!pack ${o.id.slice(0, 8)}\` | \`!dispatch ${o.id.slice(0, 8)} [rider]\``;
      await safeSendMessage(replyJid, { text: reply });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Order lookup error: ${err.message}` });
      return;
    }
  }

  // 6. Allow Platform Floor Ops / Admin Oversight to execute !paid, !pack, !verify, !dispatch, !delivered, !confirm and mirror to the Shop's groups
  if (command === "!paid" || command === "!pack" || command === "!verify" || command === "!dispatch" || command === "!delivered" || command === "!confirm") {
    const firstToken = args.trim().split(/\s+/)[0];
    if (!firstToken) {
      await safeSendMessage(replyJid, { text: `⚠️ *Usage:* \`${command} <order_id>\`` });
      return;
    }
    const o = await resolveShopOrder(null, firstToken);
    if (!o) {
      await safeSendMessage(replyJid, { text: `❌ Order \`${firstToken}\` not found across platform stores.` });
      return;
    }
    const shops = await getAllShops();
    const shop = shops.find(s => s.id === o.shop_id) || { id: o.shop_id, name: "Platform Store", fulfillment_settings: {} };
    return await handleShopCommand(command, args, replyJid, senderId, callerName, { tier: "SHOP", role: "MANAGEMENT", shop }, safeSendMessage);
  }

  // Unknown
  await safeSendMessage(replyJid, {
    text: `❓ *Unknown system command:* \`${command}\`\nReply with *!help* to view available platform commands.`
  });
}

// =============================================================================
// TIER 3: DIRECT MESSAGE (1-ON-1 CUSTOMER / STAFF ASSISTANT)
// =============================================================================
async function handleDirectMessageCommand(command, args, replyJid, senderId, callerName, safeSendMessage) {
  if (command === "!help") {
    await safeSendMessage(replyJid, {
      text: `👋 Hello! I am your Savannah shopping & delivery assistant.\n\n` +
            `• *!order <order_id>*: Check your delivery status and live package tracking.\n` +
            `• *!order*: Automatically view all your recent active orders.\n` +
            `• *!resurrect <order_id>*: Revive an expired or unpaid order with fresh M-Pesa window.\n` +
            `• *!reorder <order_id>*: 1-tap re-order from your previous purchases.\n` +
            `• *!shops*: View active partner boutique storefronts.\n` +
            `• *!help*: Show this guide.\n\n` +
            `_To shop, visit any of our boutique storefronts with instant M-Pesa checkout!_`
    });
    return;
  }

  // 1. Order Resurrection: !resurrect <order_id> or !revive <order_id>
  if (command === "!resurrect" || command === "!revive") {
    return await handleResurrectCommand(args, replyJid, senderId, callerName, safeSendMessage);
  }

  // 2. 1-Tap Re-order: !reorder <order_id> or !repeat or !buyagain
  if (command === "!reorder" || command === "!repeat" || command === "!buyagain") {
    return await handleReorderCommand(args, replyJid, senderId, callerName, safeSendMessage);
  }

  if (command === "!order" || command === "!status" || command === "!track") {
    const orderId = args.trim();
    if (!orderId) {
      // Auto-lookup by customer phone number
      const digits = (senderId || "").replace(/[^0-9]/g, "");
      const searchSuffix = digits.slice(-9); // last 9 digits (e.g. 710720949)
      if (searchSuffix.length >= 7) {
        try {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?client_phone=ilike.*${searchSuffix}*&order=created_at.desc&limit=3&select=id,status,internal_status,total_price,notes,created_at,shop_id`, { headers: dbHdrs });
          const userOrders = await res.json();
          if (Array.isArray(userOrders) && userOrders.length > 0) {
            let msg = `📦 *Your Recent Orders:*\n\n`;
            userOrders.forEach(o => {
              const displayId = formatDisplayOrderId(o);
              const status = (o.status || "PENDING").toUpperCase();
              msg += `• *${displayId}* — KES ${Number(o.total_price).toLocaleString()} | Status: *${status}*\n`;
              if (o.notes) {
                const lastLine = o.notes.split('\n').filter(Boolean).pop();
                if (lastLine) msg += `  _${lastLine}_\n`;
              }
            });
            msg += `\n_Reply with \`!order <order_id>\` for detailed station tracking._`;
            await safeSendMessage(replyJid, { text: msg });
            return;
          }
        } catch (phoneErr) {
          console.error("Phone order lookup error:", phoneErr);
        }
      }
      await safeSendMessage(replyJid, { text: `⚠️ Please provide your order number: \`!order <order_id>\`` });
      return;
    }

    try {
      const o = await resolveShopOrder(null, orderId);
      if (!o) {
        await safeSendMessage(replyJid, { text: `❌ Could not find order \`${orderId}\`. Please check your receipt.` });
        return;
      }
      const displayId = formatDisplayOrderId(o);
      let replyText = `📦 *Order Tracking: ${displayId}*\n` +
                      `• Status: *${(o.status || "PENDING").toUpperCase()}*\n` +
                      `• Total: *KES ${Number(o.total_price).toLocaleString()}*\n` +
                      `• Customer: ${o.client_name || "Guest"}\n` +
                      `• Date Placed: ${new Date(o.created_at).toLocaleDateString()}\n`;
      if (o.notes) {
        const lastLine = o.notes.split('\n').filter(Boolean).pop();
        if (lastLine) replyText += `• Station Note: _${lastLine}_\n`;
      }
      await safeSendMessage(replyJid, { text: replyText });
      return;
    } catch (err) {
      await safeSendMessage(replyJid, { text: `❌ Tracking lookup error: ${err.message}` });
      return;
    }
  }

  await safeSendMessage(replyJid, {
    text: `👋 Hi there! Reply with *!help* to view your available customer options or *!order* to check your tracking.`
  });
}

// =============================================================================
// SUB-ROUTINE: ORDER RESURRECTION (Payment Recovery & Cart Revival)
// =============================================================================
export async function handleResurrectCommand(orderQuery, replyJid, senderId, callerName, safeSendMessage, shopContext = null) {
  let targetQuery = (orderQuery || "").trim();

  if (!targetQuery) {
    // If no order ID was given, check if customer has recent expired/pending orders
    const digits = (senderId || "").replace(/[^0-9]/g, "");
    const searchSuffix = digits.slice(-9);
    if (searchSuffix.length >= 7) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?client_phone=ilike.*${searchSuffix}*&status=neq.paid&status=neq.dispatched&order=created_at.desc&limit=1`, { headers: dbHdrs });
        const recent = await res.json();
        if (Array.isArray(recent) && recent.length > 0) {
          targetQuery = recent[0].id;
        }
      } catch (err) {
        console.error("Auto order detect error:", err.message);
      }
    }
  }

  if (!targetQuery) {
    await safeSendMessage(replyJid, {
      text: `⚠️ *Please provide an order number:* \`!resurrect <order_id>\`\n_Example:_ \`!resurrect 832f1b75\``
    });
    return;
  }

  try {
    const order = await resolveShopOrder(shopContext?.id || null, targetQuery);
    if (!order) {
      await safeSendMessage(replyJid, {
        text: `❌ *Order Not Found:* Could not locate order matching \`${targetQuery}\`.\nPlease check your order receipt number.`
      });
      return;
    }

    // Check if already paid/completed
    if (order.status === "paid" || order.status === "dispatched" || order.status === "completed") {
      const displayId = formatDisplayOrderId(order);
      await safeSendMessage(replyJid, {
        text: `ℹ️ *Order ${displayId} is already paid & active!* (Status: *${order.status.toUpperCase()}*)\n\n` +
              `👉 _To re-order these exact items again, reply with:_ \`!reorder ${order.id.slice(0, 8)}\``
      });
      return;
    }

    // Fetch shop details for Till number & routing
    let shop = shopContext;
    if (!shop) {
      const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${order.shop_id}&select=id,name,slug,mpesa_till_number,phone,fulfillment_settings`, { headers: dbHdrs });
      shop = (await shopRes.json())?.[0];
    }

    // Fetch order items
    const itemsRes = await fetch(`${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${order.id}&select=*,menu_items(id,name,price,is_active)`, { headers: dbHdrs });
    const orderItems = await itemsRes.json();

    let itemsSummary = "";
    if (Array.isArray(orderItems) && orderItems.length > 0) {
      itemsSummary = orderItems.map(it => `• ${it.quantity}x *${it.menu_items?.name || "Boutique Item"}* — KES ${(Number(it.price) * it.quantity).toLocaleString()}`).join("\n");
    } else {
      itemsSummary = `• Custom Order Items — KES ${Number(order.total_price).toLocaleString()}`;
    }

    // Extend expiry by 2 hours from now
    const now = new Date();
    const newExpiresAt = new Date(Date.now() + 2 * 3600 * 1000);
    const expiryTimeStr = `${String(newExpiresAt.getHours()).padStart(2, '0')}:${String(newExpiresAt.getMinutes()).padStart(2, '0')}`;
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const existingNotes = order.notes || "";
    const updatedNotes = existingNotes
      ? `${existingNotes}\n• [${timeStr} @${callerName}]: Resurrected order via WhatsApp (Extended to ${expiryTimeStr})`
      : `• [${timeStr} @${callerName}]: Resurrected order via WhatsApp (Extended to ${expiryTimeStr})`;

    // Update Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
      method: "PATCH",
      headers: { ...dbHdrs, "Prefer": "return=minimal" },
      body: JSON.stringify({
        status: "pending",
        internal_status: "PENDING_PAYMENT",
        expires_at: newExpiresAt.toISOString(),
        notes: updatedNotes
      })
    });

    const displayId = formatDisplayOrderId(order);
    const tillNumber = shop?.mpesa_till_number || "4082211";

    // Send customer the Resurrection Card
    await safeSendMessage(replyJid, {
      text: `⚡ *Order ${displayId} Resurrected!* ⚡\n` +
            `╭────────────────────────────────────────╮\n` +
            `  • Shop: *${shop?.name || "Savannah Atelier"}*\n` +
            `  • Customer: *${order.client_name || "Valued Customer"}*\n` +
            `  • Total Due: *KES ${Number(order.total_price).toLocaleString()}*\n` +
            `  • Payment Window: *Extended to ${expiryTimeStr}* ⏰\n` +
            `╰────────────────────────────────────────╯\n\n` +
            `📦 *Reserved Items:*\n${itemsSummary}\n\n` +
            `💳 *How to Complete Payment:*\n` +
            `1. Go to M-Pesa ➔ Buy Goods and Services\n` +
            `2. Enter Till Number: *${tillNumber}*\n` +
            `3. Enter Amount: *KES ${Number(order.total_price).toLocaleString()}*\n\n` +
            `👉 _Once paid, simply forward or paste your Safaricom M-Pesa SMS here to instantly verify & trigger dispatch!_`
    });

    // Alert Floor Operations in the shop's Operations Group
    const opsJid = shop?.fulfillment_settings?.whatsapp_routing?.operations_jid;
    if (opsJid && safeSendMessage) {
      await safeSendMessage(opsJid, {
        text: `🔥 *Customer Resurrected Order ${displayId}!* (${shop?.name || "Store"})\n` +
              `• Customer: *${order.client_name || "Guest"}* (${order.client_phone || callerName})\n` +
              `• Amount: *KES ${Number(order.total_price).toLocaleString()}* (Awaiting M-Pesa)\n` +
              `• Payment Window: Active until ${expiryTimeStr} ⏰\n` +
              `_Floor staff: Keep items staged on reserve shelf._`
      });
    }

  } catch (err) {
    console.error("[RESURRECT ERROR]:", err);
    await safeSendMessage(replyJid, { text: `❌ Resurrection failed: ${err.message}` });
  }
}

// =============================================================================
// SUB-ROUTINE: 1-TAP RE-ORDER / BUY AGAIN
// =============================================================================
export async function handleReorderCommand(orderQuery, replyJid, senderId, callerName, safeSendMessage, shopContext = null) {
  let targetQuery = (orderQuery || "").trim();

  if (!targetQuery) {
    // If no order ID was given, check for customer's most recent order by phone
    const digits = (senderId || "").replace(/[^0-9]/g, "");
    const searchSuffix = digits.slice(-9);
    if (searchSuffix.length >= 7) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?client_phone=ilike.*${searchSuffix}*&order=created_at.desc&limit=1`, { headers: dbHdrs });
        const recent = await res.json();
        if (Array.isArray(recent) && recent.length > 0) {
          targetQuery = recent[0].id;
        }
      } catch (err) {
        console.error("Auto reorder detect error:", err.message);
      }
    }
  }

  if (!targetQuery) {
    await safeSendMessage(replyJid, {
      text: `⚠️ *Please provide an order number to re-order:* \`!reorder <order_id>\`\n_Example:_ \`!reorder 5b0cd3f1\``
    });
    return;
  }

  try {
    const origOrder = await resolveShopOrder(shopContext?.id || null, targetQuery);
    if (!origOrder) {
      await safeSendMessage(replyJid, {
        text: `❌ *Order Not Found:* Could not locate past order matching \`${targetQuery}\`.`
      });
      return;
    }

    // Fetch shop details
    let shop = shopContext;
    if (!shop) {
      const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${origOrder.shop_id}&select=id,name,slug,mpesa_till_number,phone,fulfillment_settings`, { headers: dbHdrs });
      shop = (await shopRes.json())?.[0];
    }

    // Fetch items from previous order
    const itemsRes = await fetch(`${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${origOrder.id}&select=*,menu_items(id,name,price,is_active)`, { headers: dbHdrs });
    const origItems = await itemsRes.json();

    if (!Array.isArray(origItems) || origItems.length === 0) {
      await safeSendMessage(replyJid, {
        text: `❌ *Cannot Re-order:* Order #${origOrder.id.slice(0, 8).toUpperCase()} has no catalog item records.`
      });
      return;
    }

    let calculatedTotal = 0;
    const clonedItemPayloads = [];
    const itemLines = [];

    for (const it of origItems) {
      const unitPrice = it.menu_items?.price ?? it.price;
      const lineTotal = Number(unitPrice) * it.quantity;
      calculatedTotal += lineTotal;
      clonedItemPayloads.push({
        menu_item_id: it.menu_item_id,
        quantity: it.quantity,
        price: unitPrice
      });
      itemLines.push(`• ${it.quantity}x *${it.menu_items?.name || "Boutique Item"}* — KES ${lineTotal.toLocaleString()}`);
    }

    const now = new Date();
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const newExpiresAt = new Date(Date.now() + 2 * 3600 * 1000);

    // Create fresh order in Supabase
    const newOrderPayload = {
      shop_id: origOrder.shop_id,
      table_id: origOrder.table_id || "WhatsApp",
      total_price: calculatedTotal,
      status: "pending",
      internal_status: "CREATED",
      fulfillment_type: origOrder.fulfillment_type || "delivery",
      client_name: origOrder.client_name || "Valued Customer",
      client_phone: origOrder.client_phone || senderId.replace(/@.*$/, ""),
      delivery_address: origOrder.delivery_address || "",
      parent_order_id: origOrder.id,
      order_type: "direct",
      expires_at: newExpiresAt.toISOString(),
      notes: `• [${timeStr} @${callerName}]: 1-Tap Re-order cloned from #${origOrder.id.slice(0, 8).toUpperCase()}`
    };

    const createRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: { ...dbHdrs, "Prefer": "return=representation" },
      body: JSON.stringify(newOrderPayload)
    });

    const [createdOrder] = await createRes.json();
    if (!createdOrder) {
      throw new Error("Failed to insert new order record in Supabase.");
    }

    // Insert cloned order items
    const itemsToInsert = clonedItemPayloads.map(it => ({
      order_id: createdOrder.id,
      menu_item_id: it.menu_item_id,
      quantity: it.quantity,
      price: it.price
    }));

    await fetch(`${SUPABASE_URL}/rest/v1/order_items`, {
      method: "POST",
      headers: dbHdrs,
      body: JSON.stringify(itemsToInsert)
    });

    const displayId = formatDisplayOrderId(createdOrder);
    const tillNumber = shop?.mpesa_till_number || "4082211";

    // Reply to customer with newly created order
    await safeSendMessage(replyJid, {
      text: `🛍️ *New Order Created from Your Favorites!* 🛍️\n` +
            `╭────────────────────────────────────────╮\n` +
            `  • New Order: *${displayId}*\n` +
            `  • Shop: *${shop?.name || "Savannah Store"}*\n` +
            `  • Total Due: *KES ${Number(createdOrder.total_price).toLocaleString()}*\n` +
            `  • Cloned From: *#${origOrder.id.slice(0, 8).toUpperCase()}*\n` +
            `╰────────────────────────────────────────╯\n\n` +
            `📦 *Items In Order:*\n${itemLines.join("\n")}\n\n` +
            `💳 *Payment Instructions:*\n` +
            `• Buy Goods Till Number: *${tillNumber}*\n` +
            `• Amount: *KES ${Number(createdOrder.total_price).toLocaleString()}*\n` +
            `• Reference: \`${createdOrder.id.slice(0, 8).toUpperCase()}\`\n\n` +
            `👉 _Once paid, reply with your M-Pesa SMS confirmation to auto-dispatch!_`
    });

    // Alert Floor Operations
    const opsJid = shop?.fulfillment_settings?.whatsapp_routing?.operations_jid;
    if (opsJid && safeSendMessage) {
      await safeSendMessage(opsJid, {
        text: `🛍️ *New Customer 1-Tap Re-Order!* (${shop?.name || "Store"})\n` +
              `• New Order: *${displayId}* (${createdOrder.client_name})\n` +
              `• Total: *KES ${Number(createdOrder.total_price).toLocaleString()}* (Awaiting payment)\n` +
              `• Cloned From: #${origOrder.id.slice(0, 8).toUpperCase()}\n` +
              `_Station: Pending payment verification._`
      });
    }

  } catch (err) {
    console.error("[REORDER ERROR]:", err);
    await safeSendMessage(replyJid, { text: `❌ Re-order failed: ${err.message}` });
  }
}

// =============================================================================
// SUB-ROUTINE: WHATSAPP CHANNEL BROADCASTING (@newsletter)
// =============================================================================
export async function broadcastProductToChannel(shop, product, safeSendMessage) {
  const channelJid = shop?.fulfillment_settings?.whatsapp_routing?.channel_jid;
  if (!channelJid || !safeSendMessage) return;

  const shopPhone = (shop.whatsapp_number || "254710720949").replace(/[^0-9]/g, "");
  const priceStr = Number(product.price).toLocaleString();
  const textMsg =
    `✨ *NEW ARRIVAL AT ${shop.name.toUpperCase()}* ✨\n\n` +
    `👗 *${product.name}*\n` +
    `• Price: *KES ${priceStr}*\n` +
    `• Category: *${product.category || "General"}*\n` +
    `• In Stock: *Available Now* ✅\n\n` +
    `💬 *To order via WhatsApp:* wa.me/${shopPhone}?text=!order%20${product.id.slice(0, 8)}\n` +
    `🌐 *Storefront:* https://${shop.slug}.savannahatelier.com`;

  try {
    if (product.image_url) {
      await safeSendMessage(channelJid, {
        image: { url: product.image_url },
        caption: textMsg
      });
    } else {
      await safeSendMessage(channelJid, { text: textMsg });
    }
    console.log(`[CHANNEL BROADCAST] Published "${product.name}" to channel ${channelJid}`);
  } catch (err) {
    console.error(`[CHANNEL BROADCAST ERROR]:`, err.message);
  }
}

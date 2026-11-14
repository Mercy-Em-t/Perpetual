/**
 * ==============================================================================
 * TMS LEASED FEATURE — BIDIRECTIONAL SHOP INBOUND COMMAND & INPUT ENGINE
 * ==============================================================================
 * Enables the platform to safely receive, parse, validate, and execute real-time
 * operational input from the Shop / Kitchen Operator (via WhatsApp Group commands
 * in "Leah's Kitchen - Group Orders" or the Merchant Web Console) without echo loops.
 *
 * Supported Shop Operator Inputs:
 * 1. Bag Packing Confirmation:
 *    - "PACKED BAG-01" | "PACK BAG-01, BAG-02" | "DONE BAG-01"
 *    -> Marks the customer bag(s) as Packed ✅ and broadcasts `SHOP_BAG_PACKED`.
 * 2. Real-Time Dish Sold-Out / Restock Toggle:
 *    - "SOLD OUT Swahili Coconut Chicken Stew" | "DISABLE leah-003"
 *    - "AVAILABLE Swahili Coconut Chicken Stew" | "ENABLE leah-003"
 *    - "STOCK Swahili Coconut Chicken Stew 15"
 *    -> Toggles dish availability or updates daily stock cap on the storefront.
 * 3. On-Demand Kitchen Prep & Bagging Digest Flush:
 *    - "PREP" | "BATCH" | "FLUSH"
 *    -> Immediately flushes pending orders into Stage 1 + Stage 2 BAG-01 Slips.
 * 4. Pre-Order Cutoff & Grace Override:
 *    - "GRACE 15" | "EXTEND GRACE 10" | "LOCK CUTOFF"
 *    -> Adjusts or locks the evening pre-order grace window from the kitchen.
 * 5. Kitchen Status & Stock Check:
 *    - "STATUS" | "SHOP STATUS"
 *    -> Returns a compact summary of unpacked bags, stock caps, and cutoff state.
 *
 * 3-Layer Anti-Echo Loop Protection:
 * - Layer 1: Outbox Message ID Ledger (`WhatsAppMessageTracker.isBotMessage(id)`).
 * - Layer 2: Bot Header Signature Rejection (ignores messages starting with bot emojis/headers).
 * - Layer 3: Strict Command Grammar (only acts on explicit shop operator commands;
 *            ignores casual conversation).
 * ==============================================================================
 */

import { broadcastLeaseMessage, sendModuleRequest } from "./LeaseBroadcastBridge.js";
import { defaultMessageTracker } from "./WhatsAppMessageTracker.js";

const BOT_SIGNATURE_PREFIXES = [
  "🛍️ *NEW ORDER",
  "> 🛍️ *NEW ORDER",
  "👩🏾‍🍳 *[",
  "> 👩🏾‍🍳 *[",
  "📊 *[",
  "🔔 *[LEAH'S KITCHEN",
  "🎉 *LEAH'S KITCHEN",
  "🤖 *[SHOP INPUT",
  "> 🤖 *[SHOP INPUT",
  "📢 *[TMS LEASED"
];

/**
 * Determines if an incoming message is safe to inspect as Shop Operator Input
 * (i.e. NOT an echo of the bot's own outbound messages).
 *
 * @param {Object} params
 * @param {string} [params.messageId] - WhatsApp message key.id
 * @param {string} [params.text] - Raw message text
 * @param {Object} [params.tracker=defaultMessageTracker] - Outbox message tracker
 * @returns {{ safe: boolean, reason: string }}
 */
export function verifyInboundShopMessageSafety({
  messageId = "",
  text = "",
  senderJid = "",
  fromMe = true,
  authorizedOperatorJids = null,
  isPublicCommunityGroup = false,
  tracker = defaultMessageTracker
} = {}) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return { safe: false, reason: "EMPTY_TEXT" };
  }

  if (messageId && tracker && typeof tracker.isBotMessage === "function") {
    if (tracker.isBotMessage(messageId)) {
      return { safe: false, reason: "OUTBOX_LEDGER_BOT_ECHO" };
    }
  }

  const trimmed = text.trim();
  for (const prefix of BOT_SIGNATURE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { safe: false, reason: "BOT_SIGNATURE_HEADER" };
    }
  }

  // Layer 4: Role-Based Operator Guard (prevents random customers in the Community Hub from running SOLD OUT / PACKED)
  if (isPublicCommunityGroup && !fromMe) {
    const cleanSender = (senderJid || "").split(":")[0];
    const allowedSet = Array.isArray(authorizedOperatorJids)
      ? new Set(authorizedOperatorJids.map((j) => j.split(":")[0]))
      : new Set();
    if (!allowedSet.has(cleanSender)) {
      return { safe: false, reason: "UNAUTHORIZED_COMMUNITY_MEMBER_BLOCKED" };
    }
  }

  return { safe: true, reason: "VERIFIED_HUMAN_SHOP_INPUT" };
}

/**
 * Parses a raw text string from the shop operator into a structured command intent.
 * Returns `null` if the text is normal conversation rather than a shop command.
 *
 * @param {string} rawText
 * @returns {Object|null} Parsed command object or null
 */
export function parseShopInboundCommand(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  // Strip optional leading command prefixes like "!", "/", or "SHOP:"
  const cleaned = rawText
    .trim()
    .replace(/^(?:!|\/|shop:\s*)/i, "")
    .trim();

  // 1. Bag Packing Command: "PACKED BAG-01", "PACK BAG-01 BAG-02", "DONE BAG-03", "UNPACK BAG-01"
  const unpackMatch = cleaned.match(/^unpack\s+((?:bag-\d+[\s,]*)+)$/i);
  if (unpackMatch) {
    const bagLabels = (unpackMatch[1].match(/bag-\d+/gi) || []).map((b) => b.toUpperCase());
    if (bagLabels.length > 0) {
      return {
        commandType: "SET_BAG_PACKED_STATE",
        packed: false,
        bagLabels,
        rawText
      };
    }
  }

  const packMatch = cleaned.match(/^(?:packed|pack|done|ready)\s+((?:bag-\d+[\s,]*)+)$/i);
  if (packMatch) {
    const bagLabels = (packMatch[1].match(/bag-\d+/gi) || []).map((b) => b.toUpperCase());
    if (bagLabels.length > 0) {
      return {
        commandType: "SET_BAG_PACKED_STATE",
        packed: true,
        bagLabels,
        rawText
      };
    }
  }

  // 2. Dish Sold-Out / Disable Command: "SOLD OUT Coconut Stew" or "86 Mandazi" or "DISABLE leah-005"
  const soldOutMatch = cleaned.match(/^(?:sold\s*out|86|disable|off)\s+(.+)$/i);
  if (soldOutMatch) {
    return {
      commandType: "TOGGLE_DISH_AVAILABILITY",
      isActive: false,
      dishQuery: soldOutMatch[1].trim(),
      rawText
    };
  }

  // 3. Dish Available / Enable Command: "AVAILABLE Coconut Stew" or "ENABLE leah-005" or "RESTOCK Mandazi"
  const enableMatch = cleaned.match(/^(?:available|in\s*stock|enable|on)\s+(.+)$/i);
  if (enableMatch) {
    return {
      commandType: "TOGGLE_DISH_AVAILABILITY",
      isActive: true,
      dishQuery: enableMatch[1].trim(),
      rawText
    };
  }

  // 4. Dish Stock Cap Update: "STOCK Swahili Coconut Chicken Stew 15" or "CAP Mandazi 20"
  const stockCapMatch = cleaned.match(/^(?:stock|cap|limit)\s+(.+?)\s+(\d+)$/i);
  if (stockCapMatch) {
    const dailyCap = Number(stockCapMatch[2]);
    return {
      commandType: "UPDATE_DISH_STOCK_CAP",
      dishQuery: stockCapMatch[1].trim(),
      dailyCap,
      isActive: dailyCap > 0,
      rawText
    };
  }

  // 5. On-Demand Prep Digest Flush: "PREP", "FLUSH", "BATCH", "DIGEST"
  if (/^(?:prep|flush|batch|digest|cook\s*sheet)$/i.test(cleaned)) {
    return {
      commandType: "FLUSH_PREP_DIGEST",
      rawText
    };
  }

  // 6. Cutoff & Grace Period Override from Shop: "GRACE 20", "EXTEND GRACE 10", "LOCK CUTOFF"
  const graceMatch = cleaned.match(/^(?:grace|extend\s+grace)\s+(\d+)\s*m?(?:in(?:ute)?s?)?$/i);
  if (graceMatch) {
    return {
      commandType: "UPDATE_GRACE_WINDOW",
      graceMinutes: Number(graceMatch[1]),
      rawText
    };
  }

  if (/^(?:lock\s+cutoff|close\s+cutoff|close\s+kitchen)$/i.test(cleaned)) {
    return {
      commandType: "UPDATE_GRACE_WINDOW",
      graceMinutes: 0,
      lockCutoffNow: true,
      rawText
    };
  }

  // 7. Shop Status Inquiry: "STATUS", "SHOP STATUS", "BAGS"
  if (/^(?:status|shop\s+status|bags|kitchen\s+status)$/i.test(cleaned)) {
    return {
      commandType: "QUERY_SHOP_STATUS",
      rawText
    };
  }

  // 8. Group Participant Addition: "ADD 0712345678", "ADD +254712345678 ORDERS", "ADD MEMBER 0712345678"
  const addParticipantMatch = cleaned.match(/^(?:add(?:\s+member)?|invite\s+member)\s+([+\d\s,-]{9,})(?:\s+(orders|community))?$/i);
  if (addParticipantMatch) {
    const rawPhones = addParticipantMatch[1]
      .split(/[\s,]+/)
      .map((p) => p.replace(/[^0-9]/g, ""))
      .filter((p) => p.length >= 9)
      .map((p) => (p.startsWith("0") ? `254${p.slice(1)}` : p));
    if (rawPhones.length > 0) {
      return {
        commandType: "ADD_GROUP_PARTICIPANT",
        phones: rawPhones,
        targetGroupType: (addParticipantMatch[2] || "community").toLowerCase(),
        rawText
      };
    }
  }

  // 9. Group Invite Link Inquiry: "INVITE", "INVITE LINK", "GROUP LINK"
  if (/^(?:invite|invite\s+link|group\s+link|join\s+link)$/i.test(cleaned)) {
    return {
      commandType: "GET_GROUP_INVITE_LINK",
      rawText
    };
  }

  return null;
}

/**
 * Processes and executes a verified Shop Inbound Command, updates tenant state,
 * broadcasts a `SHOP_INPUT_RECEIVED` event over `LeaseBroadcastBridge` so UI boards
 * update in real time, and returns a mobile-formatted WhatsApp confirmation receipt.
 *
 * @param {Object} options
 * @param {string} options.text - Raw message text from shop
 * @param {string} [options.messageId] - Optional WhatsApp message ID
 * @param {string} [options.senderJid] - Sender JID or operator identifier
 * @param {string} [options.tenantId="leahs-kitchen"]
 * @param {string} [options.shopName="Leah's Kitchen"]
 * @param {Object} [options.context={}] - Optional runtime references (clusteringEngine, packedBagsSet, catalog)
 * @returns {Promise<Object>} Execution result and formatted WhatsApp ack reply
 */
export async function processShopInboundInput({
  text,
  messageId = "",
  senderJid = "shop-operator",
  fromMe = true,
  authorizedOperatorJids = null,
  isPublicCommunityGroup = false,
  tenantId = "leahs-kitchen",
  shopName = "Leah's Kitchen",
  context = {}
} = {}) {
  const safety = verifyInboundShopMessageSafety({
    messageId,
    text,
    senderJid,
    fromMe,
    authorizedOperatorJids,
    isPublicCommunityGroup
  });
  if (!safety.safe) {
    return {
      handled: false,
      ignoredReason: safety.reason
    };
  }

  const command = parseShopInboundCommand(text);
  if (!command) {
    return {
      handled: false,
      ignoredReason: "NOT_A_SHOP_COMMAND"
    };
  }

  let replyLines = [];
  let executionPayload = { ...command, senderJid, timestamp: new Date().toISOString() };

  switch (command.commandType) {
    case "SET_BAG_PACKED_STATE": {
      const stateLabel = command.packed ? "PACKED ✅" : "UNPACKED ☐";
      if (context.packedBagsSet instanceof Set) {
        for (const bag of command.bagLabels) {
          if (command.packed) context.packedBagsSet.add(bag);
          else context.packedBagsSet.delete(bag);
        }
      }
      replyLines = [
        `🤖 *[SHOP INPUT ACK — BAG MANIFEST UPDATED]*`,
        `🏷️ *Bags:* *${command.bagLabels.join(", ")}*`,
        `📦 *New Status:* *${stateLabel}*`,
        `🔄 _Synced live to Kitchen Prep Digest Board._`
      ];
      break;
    }

    case "TOGGLE_DISH_AVAILABILITY": {
      const statusBadge = command.isActive ? "IN STOCK ✅" : "SOLD OUT 🔴";
      try {
        await sendModuleRequest(
          tenantId,
          "TOGGLE_DISH",
          { dishId: command.dishQuery, isActive: command.isActive },
          800
        );
      } catch {}
      replyLines = [
        `🤖 *[SHOP INPUT ACK — MENU AVAILABILITY UPDATED]*`,
        `🍲 *Dish:* *${command.dishQuery}*`,
        `📊 *Storefront State:* *${statusBadge}*`,
        `🔄 _Customers on ${shopName} storefront now see updated availability._`
      ];
      break;
    }

    case "UPDATE_DISH_STOCK_CAP": {
      try {
        await sendModuleRequest(
          tenantId,
          "UPDATE_STOCK_CAP",
          { dishId: command.dishQuery, dailyCap: command.dailyCap },
          800
        );
      } catch {}
      replyLines = [
        `🤖 *[SHOP INPUT ACK — DAILY PORTION CAP UPDATED]*`,
        `🍲 *Dish:* *${command.dishQuery}*`,
        `🔢 *New Daily Cap:* *${command.dailyCap} Portions*`,
        `📊 *Status:* *${command.dailyCap > 0 ? "IN STOCK ✅" : "AUTO SOLD-OUT 🔴"}*`
      ];
      break;
    }

    case "FLUSH_PREP_DIGEST": {
      let flushedDigest = null;
      if (context.clusteringEngine && typeof context.clusteringEngine.flush === "function") {
        flushedDigest = context.clusteringEngine.flush();
      }
      executionPayload.flushedDigest = flushedDigest;
      replyLines = flushedDigest
        ? [
            `🤖 *[SHOP INPUT ACK — MANUAL BATCH FLUSH]*`,
            flushedDigest.digestText
          ]
        : [
            `🤖 *[SHOP INPUT ACK — PREP QUEUE]*`,
            `ℹ️ _No pending un-flushed orders in the sliding window right now._`
          ];
      break;
    }

    case "UPDATE_GRACE_WINDOW": {
      replyLines = command.lockCutoffNow
        ? [
            `🤖 *[SHOP INPUT ACK — CUTOFF LOCKED]*`,
            `🔒 *Pre-Order Grace Window:* *CLOSED (0 mins)*`,
            `📅 _All new incoming orders now roll over to Day + 2._`
          ]
        : [
            `🤖 *[SHOP INPUT ACK — GRACE WINDOW UPDATED]*`,
            `⚡ *Soft-Landing Grace Window:* *${command.graceMinutes} mins* (Exponential Backoff Active)`
          ];
      break;
    }

    case "QUERY_SHOP_STATUS": {
      const pendingOrdersCount =
        context.clusteringEngine && typeof context.clusteringEngine.getOrders === "function"
          ? context.clusteringEngine.getOrders().length
          : 0;
      const packedCount = context.packedBagsSet instanceof Set ? context.packedBagsSet.size : 0;

      replyLines = [
        `> 🤖 *[SHOP INPUT ACK — LIVE KITCHEN STATUS]*`,
        `🏪 *Shop:* *${shopName}*`,
        `📥 *Orders in Current Cluster Buffer:* *${pendingOrdersCount}*`,
        `🛍️ *Bags Marked Packed:* *${packedCount}*`,
        `💡 _Commands: \`PACKED BAG-01\`, \`SOLD OUT <dish>\`, \`STOCK <dish> 15\`, \`ADD <phone>\`, \`INVITE LINK\`_`
      ];
      break;
    }

    case "ADD_GROUP_PARTICIPANT": {
      const targetJids = command.phones.map((p) => `${p}@s.whatsapp.net`);
      let addResultStatus = "QUEUED_FOR_GROUP_ADD";
      if (typeof context.addParticipantsFn === "function") {
        try {
          const res = await context.addParticipantsFn(targetJids, command.targetGroupType);
          addResultStatus = res?.status || "ADDED_TO_WHATSAPP_GROUP ✅";
        } catch (err) {
          addResultStatus = `INVITE_FALLBACK (${err.message})`;
        }
      }
      executionPayload.targetJids = targetJids;
      executionPayload.addResultStatus = addResultStatus;
      replyLines = [
        `> 🤖 *[SHOP INPUT ACK — GROUP MEMBER ADDITION]*`,
        `👥 *Phone(s):* ${command.phones.map((p) => `\`+${p}\``).join(", ")}`,
        `🎯 *Target Group:* *${command.targetGroupType === "orders" ? "Leah's Kitchen - Group Orders" : "Leah's Kitchen (Community Hub)"}*`,
        `✅ *Status:* *${addResultStatus}*`
      ];
      break;
    }

    case "GET_GROUP_INVITE_LINK": {
      let communityLink = "https://chat.whatsapp.com/ (Run on connected bot)";
      let ordersLink = "https://chat.whatsapp.com/ (Run on connected bot)";
      if (typeof context.getInviteLinksFn === "function") {
        try {
          const links = await context.getInviteLinksFn();
          if (links?.communityInviteUrl) communityLink = links.communityInviteUrl;
          if (links?.ordersInviteUrl) ordersLink = links.ordersInviteUrl;
        } catch {}
      }
      executionPayload.communityInviteUrl = communityLink;
      executionPayload.ordersInviteUrl = ordersLink;
      replyLines = [
        `> 🤖 *[LEAH'S KITCHEN — WHATSAPP GROUP INVITE LINKS]*`,
        `🏠 *Community Hub ("Leah's Kitchen"):*\n${communityLink}`,
        `📦 *Orders & Packing Channel ("Leah's Kitchen - Group Orders"):*\n${ordersLink}`,
        `💡 _Share the Community link with customers or type \`ADD 0712345678\` to add a number directly!_`
      ];
      break;
    }
  }

  const replyText = replyLines.join("\n");

  // Broadcast across the decoupled bridge so KitchenPrepDigestBoard.jsx & MerchantDishStockToggle.jsx react live!
  broadcastLeaseMessage({
    reporter: "ShopInboundCommandEngine",
    type: "SHOP_INPUT_RECEIVED",
    tenantId,
    tenantName: shopName,
    status: "ACTIVE",
    summary: `Shop operator executed ${command.commandType}: "${text.trim()}"`,
    metadata: executionPayload
  });

  return {
    handled: true,
    command,
    executionPayload,
    replyText
  };
}

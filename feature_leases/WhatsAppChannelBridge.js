/**
 * ==============================================================================
 * TMS LEASED FEATURE - WHATSAPP CHANNEL BRIDGE & DISPATCHER
 * ==============================================================================
 * Enables broadcasting lease events, diagnostic time cards, handshake alerts,
 * and technical documentation chronicles directly to WhatsApp Channels,
 * WhatsApp Groups, or Admin numbers.
 * 
 * Capabilities:
 * 1. Rich WhatsApp Markdown Formatter (*bold*, _italic_, ```code```).
 * 2. 1-Click Universal Deep-Link Generator (wa.me & api.whatsapp.com).
 * 3. Programmatic Outbound Dispatcher (Meta WhatsApp Cloud API / Webhook).
 * 4. Channel Broadcast Bridge integration.
 * ==============================================================================
 */

/**
 * Transforms an ILeaseMessage or diagnostic report into WhatsApp-flavored Markdown
 * @param {Object} message - The lease message payload
 * @returns {string} WhatsApp formatted text
 */
export function formatMessageForWhatsApp(message) {
  const reporter = message.reporter || "TMS Diagnostic Worker";
  const actionType = message.type || "SYSTEM_EVENT";
  const summary = message.summary || message.details || "Diagnostic broadcast dispatched.";
  const status = message.status || "ACTIVE";
  const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : new Date().toLocaleString();

  if (actionType === "ORDER_PLACED") {
    const meta = message.metadata || {};
    const items = meta.items || [];
    const customer = meta.customer || {};
    const shopTitle = message.tenantName || message.tenantId || "Whitelabel Store";
    const orderId = meta.orderId || "LK-ORD";
    const customerName = customer.name || meta.clientName || "Walk-in Guest";
    const customerPhone = customer.phone || meta.clientPhone || "N/A";
    const totalPortions = items.reduce((sum, i) => sum + Number(i.quantity || i.qty || 1), 0);
    const totalAmountStr = Number(meta.totalAmount || meta.totalPrice || 0).toLocaleString();

    const itemLines =
      items.length > 0
        ? items.flatMap((i) => {
            const qty = Number(i.quantity || i.qty || 1);
            const lineTotal = (Number(i.price || 0) * qty).toLocaleString();
            const mainLine = `• \`${qty}x\` ${qty}x ${i.name} — KES ${lineTotal}`;
            const noteText = i.notes || i.specialInstructions;
            return noteText ? [mainLine, `  > 📝 _Note: ${noteText}_`] : [mainLine];
          })
        : [`• ${summary}`];

    const formattedLines = [
      `> 🛍️ *NEW ORDER RECEIVED!*`,
      `> 🏪 *${shopTitle}*  •  🧾 \`#${orderId}\``,
      meta.gracePeriodApproved
        ? `> ⚡ *GRACE WINDOW:* ${meta.graceBackoff ? `_${meta.graceBackoff.decayFormula}_` : "_17:00–17:15 Soft-Landing_"}`
        : "",
      "",
      `👤 *Customer:* *${customerName}* (\`${customerPhone}\`)`,
      meta.deliveryAddress ? `📍 *Pickup / Gate:* *${meta.deliveryAddress}*` : "",
      meta.tableNumber ? `🪑 *Table: ${meta.tableNumber}*` : "",
      meta.fulfillmentType ? `🚚 *Fulfillment:* \`${meta.fulfillmentType.toUpperCase()}\`` : "",
      meta.targetDay ? `📅 *Dispatch Window:* *${meta.targetDay}*` : "",
      `🕒 _Placed: ${timestamp}_  •  \`${status || "PENDING"}\``,
      "",
      meta.isPreorder || ['food', 'restaurant'].includes(meta.industryType) ? `🍲 *ORDER ITEMS (${totalPortions || 1} ${totalPortions === 1 ? "Portion" : "Portions"}):*` : `📦 *ORDER ITEMS (${totalPortions || 1} ${totalPortions === 1 ? "Item" : "Items"}):*`,
      ...itemLines,
      "",
      `> 💰 *TOTAL: KES ${totalAmountStr}*  •  ✅ _Queued for Bagging_`,
      meta.isPreorder ? `> 💬 _Reply_ \`PREP\` _for batch sheet or_ \`SOLD OUT <Dish>\` _to update menu_` : `> 💬 _Reply_ \`STATUS <Order#>\` _to update status_`
    ].filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""));
    return formattedLines.join("\n");
  }

  let statusEmoji = "📢";
  if (actionType.includes("TIMEOUT")) statusEmoji = "🚨";
  else if (actionType.includes("HEALTHY") || actionType.includes("SYNC")) statusEmoji = "✅";
  else if (actionType.includes("DOCUMENTATION") || actionType.includes("CHRONICLE")) statusEmoji = "📜";
  else if (actionType.includes("SWEEP")) statusEmoji = "🕛";

  const lines = [
    `${statusEmoji} *[TMS LEASED FEATURE BROADCAST]*`,
    "",
    `👤 *Reporter:* ${reporter}`,
    `⚡ *Action:* \`${actionType}\``,
    `📊 *Status:* *${status}*`,
    `🕒 *Time:* ${timestamp}`,
    "",
    `📝 *Summary:*`,
    `${summary}`,
  ];

  if (message.metadata) {
    if (message.metadata.handshake) {
      lines.push("");
      lines.push(`🤝 *Handshake:* ${message.metadata.handshake.verdict} (${message.metadata.handshake.waitedMs}ms waited)`);
    }
    if (message.metadata.timeSync) {
      lines.push(`⏱️ *Clock Sync:* ${message.metadata.timeSync.verdict} (drift: ${message.metadata.timeSync.driftMs}ms)`);
    }
    if (message.metadata.packets) {
      lines.push(`📦 *Packets:* ${message.metadata.packets.integrityRatio} (${message.metadata.packets.movingPackets} moving)`);
    }
    if (message.metadata.driveRoom) {
      lines.push(`📂 *Live Room:* ${message.metadata.driveRoom.roomName}`);
    }
  }

  lines.push("");
  lines.push(`— _TMS Whitelabel Core Broadcast Matrix_`);

  return lines.join("\n");
}

/**
 * Generates a universal WhatsApp direct deep-link (wa.me)
 * @param {Object|string} messageOrText - Raw text or message payload
 * @param {string} [recipientPhone=""] - Optional target phone number (international format e.g. "254700000000")
 * @returns {string}
 */
export function generateWhatsAppShareUrl(messageOrText, recipientPhone = "") {
  const text = typeof messageOrText === "string" ? messageOrText : formatMessageForWhatsApp(messageOrText);
  const cleanPhone = recipientPhone ? recipientPhone.replace(/[^0-9]/g, "") : "";
  const encodedText = encodeURIComponent(text);

  if (cleanPhone) {
    return `https://wa.me/${cleanPhone}?text=${encodedText}`;
  }

  // Universal share link (allows user to select any WhatsApp contact, group, or channel)
  return `https://api.whatsapp.com/send?text=${encodedText}`;
}

/**
 * Generates an official WhatsApp Channel invite / follow URL
 * @param {string} channelId - The public WhatsApp Channel alphanumeric ID
 * @returns {string}
 */
export function generateWhatsAppChannelUrl(channelId) {
  const cleanId = channelId ? channelId.trim().replace(/^https:\/\/whatsapp\.com\/channel\//, "") : "";
  return cleanId ? `https://whatsapp.com/channel/${cleanId}` : "https://www.whatsapp.com/channel";
}

/**
 * Dispatches a message to a WhatsApp Channel or Gateway endpoint
 * Supports Meta Cloud API, custom webhooks, or falls back to URL payload
 * @param {Object} message - Payload
 * @param {Object} [config={}] - Gateway configuration
 * @returns {Promise<Object>} Dispatch result
 */
export async function dispatchToWhatsAppChannel(message, config = {}) {
  const formattedText = formatMessageForWhatsApp(message);
  const shareUrl = generateWhatsAppShareUrl(formattedText, config.recipientPhone || "");

  // If a live webhook or Cloud API endpoint is provided:
  if (config.webhookUrl) {
    try {
      const response = await fetch(config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
        },
        body: JSON.stringify({
          recipient: config.recipientPhone || config.channelId || "DEFAULT_CHANNEL",
          message: formattedText,
          rawPayload: message,
          timestamp: new Date().toISOString(),
        }),
      });

      const responseData = await response.json().catch(() => ({ status: response.status }));
      return {
        success: response.ok,
        transport: "WEBHOOK_GATEWAY",
        statusCode: response.status,
        data: responseData,
        shareUrl,
        formattedText,
      };
    } catch (err) {
      return {
        success: false,
        transport: "WEBHOOK_GATEWAY",
        error: err.message,
        shareUrl,
        formattedText,
      };
    }
  }

  // Default headless/client-side dispatch via deep-link
  return {
    success: true,
    transport: "DEEP_LINK_CLIENT",
    shareUrl,
    formattedText,
    timestamp: new Date().toISOString(),
  };
}

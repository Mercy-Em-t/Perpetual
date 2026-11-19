/**
 * Marketing & Community Broadcast Guardrails
 * Manages:
 * 1. Promotional announcements & new arrival broadcasts to WhatsApp Community / Channels.
 * 2. Strict Rate Limiting (BVA: Max 2 broadcasts / day, 2-hour cooldown).
 * 3. Channel Validation (Only broadcast to community_jid or channel_jid, NEVER internal ops).
 * 4. Anti-Spam Formatting & Opt-out requirements.
 * 5. Full integration with Security Access Sentinel.
 */

import {
  resolveSenderRole,
  recordAuditLog,
  AUDIT_DECISION,
  SEVERITY
} from "./security_access_sentinel.mjs";

export const BROADCAST_LIMITS = {
  MAX_PER_DAY: 2,
  COOLDOWN_MS: 2 * 60 * 60 * 1000, // 2 hours
  MAX_MESSAGE_LENGTH: 1000,
  MIN_MESSAGE_LENGTH: 10
};

// In-Memory Broadcast History per Shop: shopSlug -> Array of timestamps
const broadcastHistory = new Map();

/**
 * Checks whether a broadcast is permitted under rate-limiting and boundary rules.
 */
export function checkBroadcastRateLimit(shopSlug, nowMs = Date.now()) {
  const history = broadcastHistory.get(shopSlug) || [];

  // Filter to last 24 hours
  const oneDayAgo = nowMs - 24 * 60 * 60 * 1000;
  const recent = history.filter(ts => ts > oneDayAgo);

  // 1. Max per day boundary check
  if (recent.length >= BROADCAST_LIMITS.MAX_PER_DAY) {
    return {
      allowed: false,
      reason: `DAILY_LIMIT_EXCEEDED: Shop '${shopSlug}' has reached the maximum of ${BROADCAST_LIMITS.MAX_PER_DAY} broadcasts per 24h.`,
      recentCount: recent.length
    };
  }

  // 2. Cooldown boundary check
  if (recent.length > 0) {
    const lastBroadcast = recent[recent.length - 1];
    const timeSinceLast = nowMs - lastBroadcast;
    if (timeSinceLast < BROADCAST_LIMITS.COOLDOWN_MS) {
      const waitMinutes = Math.ceil((BROADCAST_LIMITS.COOLDOWN_MS - timeSinceLast) / 60000);
      return {
        allowed: false,
        reason: `COOLDOWN_ACTIVE: Please wait ${waitMinutes} more minutes before broadcasting again.`,
        waitMinutes
      };
    }
  }

  return { allowed: true, recentCount: recent.length };
}

/**
 * Records a successful broadcast in the rate-limiter tracker.
 */
export function recordBroadcast(shopSlug, nowMs = Date.now()) {
  const history = broadcastHistory.get(shopSlug) || [];
  history.push(nowMs);
  broadcastHistory.set(shopSlug, history);
}

/**
 * Resets history (primarily used for unit testing).
 */
export function resetBroadcastHistory(shopSlug) {
  if (shopSlug) {
    broadcastHistory.delete(shopSlug);
  } else {
    broadcastHistory.clear();
  }
}

/**
 * Validates promotional broadcast payload.
 */
export function validateBroadcastContent(content) {
  if (!content || typeof content !== "string") {
    return { isValid: false, reason: "CONTENT_EMPTY: Broadcast message content cannot be empty." };
  }

  const trimmed = content.trim();

  // BVA: Length Boundaries
  if (trimmed.length < BROADCAST_LIMITS.MIN_MESSAGE_LENGTH) {
    return {
      isValid: false,
      reason: `CONTENT_TOO_SHORT: Message must be at least ${BROADCAST_LIMITS.MIN_MESSAGE_LENGTH} characters.`
    };
  }

  if (trimmed.length > BROADCAST_LIMITS.MAX_MESSAGE_LENGTH) {
    return {
      isValid: false,
      reason: `CONTENT_TOO_LONG: Message exceeds limit of ${BROADCAST_LIMITS.MAX_MESSAGE_LENGTH} characters (Current: ${trimmed.length}).`
    };
  }

  return { isValid: true, sanitized: trimmed };
}

/**
 * Dispatches a promotional broadcast to the shop's designated Community Group or Channel.
 */
export async function executeShopBroadcast({
  shop,
  senderPhone,
  content,
  targetChannelType = "COMMUNITY", // "COMMUNITY" or "CHANNEL"
  safeSendMessage,
  nowMs = Date.now()
}) {
  const shopSlug = shop?.slug || "unknown";

  // 1. Role Authorization Check
  const role = resolveSenderRole(senderPhone, shop);
  const authorizedRoles = ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"];
  if (!authorizedRoles.includes(role)) {
    recordAuditLog({
      actorPhone: senderPhone,
      actorRole: role,
      channelType: targetChannelType,
      command: `!broadcast (${shopSlug})`,
      tenantSlug: shopSlug,
      decision: AUDIT_DECISION.DENIED_ROLE_UNAUTHORIZED,
      severity: SEVERITY.HIGH,
      reason: `Role '${role}' cannot dispatch marketing broadcasts.`
    });

    return {
      success: false,
      error: `Access Denied: Only Store Owners and Managers can dispatch community announcements.`
    };
  }

  // 2. Channel Resolution Check
  const routing = shop?.fulfillment_settings?.whatsapp_routing || {};
  let targetJid = null;

  if (targetChannelType === "CHANNEL") {
    targetJid = routing.channel_jid;
    if (!targetJid) {
      return {
        success: false,
        error: `No WhatsApp Broadcast Channel JID registered for ${shop.name}.`
      };
    }
  } else {
    targetJid = routing.community_jid;
    if (!targetJid) {
      return {
        success: false,
        error: `No WhatsApp Customer Community Group JID registered for ${shop.name}.`
      };
    }
  }

  // 3. Content Validation (BVA)
  const contentVerdict = validateBroadcastContent(content);
  if (!contentVerdict.isValid) {
    return { success: false, error: contentVerdict.reason };
  }

  // 4. Rate Limiting Check (BVA)
  const rateLimitVerdict = checkBroadcastRateLimit(shopSlug, nowMs);
  if (!rateLimitVerdict.allowed) {
    recordAuditLog({
      actorPhone: senderPhone,
      actorRole: role,
      channelJid: targetJid,
      channelType: targetChannelType,
      command: `!broadcast (${shopSlug})`,
      tenantSlug: shopSlug,
      decision: AUDIT_DECISION.DENIED_ROLE_UNAUTHORIZED,
      severity: SEVERITY.LOW,
      reason: rateLimitVerdict.reason
    });

    return { success: false, error: rateLimitVerdict.reason };
  }

  // 5. Format Clean Message with Shop Footer
  const formattedText =
    `📢 *ANNOUNCEMENT FROM ${shop.name.toUpperCase()}*\n` +
    `-----------------------------------------\n\n` +
    `${contentVerdict.sanitized}\n\n` +
    `🛍️ _Shop online at: https://tms-storefront.vercel.app/${shopSlug}_\n` +
    `💬 _Reply !items to view active catalog or !help for customer options._`;

  // 6. Dispatch Message
  if (safeSendMessage) {
    await safeSendMessage(targetJid, { text: formattedText });
  }

  // 7. Record History & Audit Log
  recordBroadcast(shopSlug, nowMs);
  recordAuditLog({
    actorPhone: senderPhone,
    actorRole: role,
    channelJid: targetJid,
    channelType: targetChannelType,
    command: `!broadcast (${shopSlug})`,
    tenantSlug: shopSlug,
    decision: AUDIT_DECISION.PERMITTED,
    severity: SEVERITY.INFO,
    reason: `Promotional broadcast sent to ${targetChannelType} (${targetJid})`
  });

  return {
    success: true,
    targetJid,
    targetChannelType,
    timestamp: nowMs
  };
}

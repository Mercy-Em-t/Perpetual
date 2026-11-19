/**
 * Security Access Matrix & Audit Trail Sentinel
 * Enforces:
 * 1. Strict Default-Deny (Zero-Trust) for all inbound commands.
 * 2. Two-Factor Validation: Sender Identity (Phone) AND Channel Appropriateness.
 * 3. Community Lineage Verification (Bounces orphan / standalone groups).
 * 4. Severity-Tiered Breach Logging (INFO, LOW, MEDIUM, HIGH, CRITICAL).
 * 5. Smart Admin Alert Dispatcher with anti-spam rate limiting.
 */

import { GROUPS } from "./config.mjs";

// Master Severity Levels
export const SEVERITY = {
  INFO: "INFO",         // Authorized successful operations (Logged silently)
  LOW: "LOW",           // Minor non-malicious errors (e.g. wrong channel by authorized user)
  MEDIUM: "MEDIUM",     // Unregistered user attempting non-mutating command in group
  HIGH: "HIGH",         // Unauthorized user attempting sensitive mutation (!paid, !dispatch, !product, !suspend)
  CRITICAL: "CRITICAL"  // Cryptographic tampering, injection payload, brute-force flood
};

// Action Results
export const AUDIT_DECISION = {
  PERMITTED: "PERMITTED",
  DENIED_UNREGISTERED_SENDER: "DENIED_UNREGISTERED_SENDER",
  DENIED_WRONG_CHANNEL: "DENIED_WRONG_CHANNEL",
  DENIED_ROLE_UNAUTHORIZED: "DENIED_ROLE_UNAUTHORIZED",
  DENIED_ORPHAN_GROUP: "DENIED_ORPHAN_GROUP",
  DENIED_INJECTION_DETECTED: "DENIED_INJECTION_DETECTED",
  DENIED_INVALID_SIGNATURE: "DENIED_INVALID_SIGNATURE"
};

// In-Memory Audit Buffer (Persistent across calls in node process, writeable to DB/log)
const auditLogStore = [];
const MAX_AUDIT_LOGS = 1000;

// Admin Alert Throttling State (prevents alerting spam to admin DM)
const alertThrottleMap = new Map();
const THROTTLE_WINDOW_MS = 60 * 1000; // 60 seconds

/**
 * Normalizes phone numbers to clean digits (last 9 digits for Kenya / global matching).
 */
export function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/@.*$/, "").replace(/[^0-9]/g, "");
}

/**
 * Checks whether sender is a Platform Superadmin.
 */
export function isSuperadmin(senderPhone, envOwnerPhone = process.env.WHATSAPP_OWNER_PHONE) {
  const clean = normalizePhone(senderPhone);
  if (!clean) return false;
  const adminPhones = [
    "254710720949",
    normalizePhone(envOwnerPhone)
  ].filter(Boolean);

  return adminPhones.some(admin => clean.endsWith(admin.slice(-9)));
}

/**
 * Resolves the sender's role for a specific tenant/shop.
 */
export function resolveSenderRole(senderPhone, shop) {
  const clean = normalizePhone(senderPhone);
  if (!clean) return "UNREGISTERED";

  if (isSuperadmin(clean)) return "SUPERADMIN";
  if (!shop) return "UNREGISTERED";

  const routing = shop.fulfillment_settings?.whatsapp_routing || {};
  const ownerPhone = normalizePhone(routing.owner_phone || shop.phone || shop.whatsapp_number);
  if (ownerPhone && clean.endsWith(ownerPhone.slice(-9))) {
    return "SHOP_OWNER";
  }

  const managerList = [
    ...(Array.isArray(routing.authorized_managers) ? routing.authorized_managers : [])
  ].map(normalizePhone).filter(Boolean);
  if (managerList.some(mgr => clean.endsWith(mgr.slice(-9)))) {
    return "SHOP_MANAGER";
  }

  const staffList = [
    ...(Array.isArray(routing.staff_phones) ? routing.staff_phones : []),
    ...(Array.isArray(shop.appearance_config?.staff_phones) ? shop.appearance_config.staff_phones : [])
  ].map(normalizePhone).filter(Boolean);
  if (staffList.some(staff => clean.endsWith(staff.slice(-9)))) {
    return "FLOOR_STAFF";
  }

  return "UNREGISTERED";
}

/**
 * Validates group community lineage.
 * Ensures the group is an authorized departmental group belonging to a registered store
 * or platform system channel, rejecting rogue/orphan groups.
 */
export function validateGroupLineage(replyJid, context) {
  if (!replyJid) return { isValid: false, reason: "MISSING_JID" };

  // Direct 1-on-1 messages are valid communication pipes
  if (replyJid.endsWith("@s.whatsapp.net")) {
    return { isValid: true, channelType: "DIRECT_MESSAGE" };
  }

  // System platform groups
  if (context?.tier === "SYSTEM") {
    return { isValid: true, channelType: `SYSTEM_${context.role}` };
  }

  // Registered shop groups
  if (context?.tier === "SHOP" && context.shop) {
    const routing = context.shop.fulfillment_settings?.whatsapp_routing || {};
    const validJids = [
      routing.operations_jid,
      routing.management_jid,
      routing.community_jid,
      routing.channel_jid
    ].filter(Boolean);

    if (validJids.includes(replyJid)) {
      return { isValid: true, channelType: `SHOP_${context.role}` };
    }
  }

  // Any group not matching registered system or shop routing is an orphan/standalone group
  return { isValid: false, reason: "ORPHAN_STANDALONE_GROUP" };
}

/**
 * Command Classification & Channel Matrix
 */
const COMMAND_RULES = {
  // 1. Station Mutations: Strictly Shop Operations or Management
  "!paid": {
    roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"],
    channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"],
    severityOnDenial: SEVERITY.HIGH,
    wrongChannelMsg: "Station mutation `!paid` must be sent inside the Shop Operations or Management group, not in direct messages or other channels."
  },
  "!clear": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"], channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"], severityOnDenial: SEVERITY.HIGH },
  "!pair": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"], channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"], severityOnDenial: SEVERITY.HIGH },
  "!pack": {
    roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"],
    channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"],
    severityOnDenial: SEVERITY.HIGH,
    wrongChannelMsg: "Packaging action `!pack` must be logged on the Shop Operations floor channel."
  },
  "!verify": {
    roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"],
    channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"],
    severityOnDenial: SEVERITY.HIGH,
    wrongChannelMsg: "Verification action `!verify` must be logged on the Shop Operations floor channel."
  },
  "!dispatch": {
    roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"],
    channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"],
    severityOnDenial: SEVERITY.HIGH,
    wrongChannelMsg: "Courier dispatch `!dispatch` must be logged on the Shop Operations floor channel."
  },
  "!delivered": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"], channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"], severityOnDenial: SEVERITY.HIGH },
  "!confirm": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"], channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT"], severityOnDenial: SEVERITY.HIGH },
  "!cancel": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!reject": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE"], severityOnDenial: SEVERITY.HIGH },
  "!resurrect": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT"], severityOnDenial: SEVERITY.HIGH },
  "!revive": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT"], severityOnDenial: SEVERITY.HIGH },

  // 2. Catalog & Product Pricing: Strictly Shop Management
  "!product": {
    roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"],
    channels: ["SHOP_MANAGEMENT"],
    severityOnDenial: SEVERITY.HIGH,
    wrongChannelMsg: "Catalog updates (`!product`) must be performed inside the Shop Management channel."
  },
  "!item": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT"], severityOnDenial: SEVERITY.HIGH },
  "!items": {
    roles: ["*"], // Read catalog items allowed in community or ops
    channels: ["SHOP_COMMUNITY", "SHOP_CHANNEL", "SHOP_OPERATIONS", "SHOP_MANAGEMENT", "DIRECT_MESSAGE"],
    severityOnDenial: SEVERITY.LOW
  },
  "!catalog": {
    roles: ["*"],
    channels: ["SHOP_COMMUNITY", "SHOP_CHANNEL", "SHOP_OPERATIONS", "SHOP_MANAGEMENT", "DIRECT_MESSAGE"],
    severityOnDenial: SEVERITY.LOW
  },

  // 3. Financial Summaries & Orders
  "!summary": {
    roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"],
    channels: ["SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"],
    severityOnDenial: SEVERITY.MEDIUM,
    wrongChannelMsg: "Financial summaries are restricted to Management and Executive channels."
  },
  "!sales": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.MEDIUM },
  "!pulse": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.MEDIUM },
  "!orders": {
    roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER", "FLOOR_STAFF"],
    channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE", "SYSTEM_OPERATIONS", "DIRECT_MESSAGE"],
    severityOnDenial: SEVERITY.MEDIUM,
    wrongChannelMsg: "Order lists can only be viewed in verified staff operations channels."
  },
  "!order": {
    roles: ["*"], // Customers can check their order status if query matches
    channels: ["SHOP_OPERATIONS", "SHOP_MANAGEMENT", "SHOP_COMMUNITY", "DIRECT_MESSAGE"],
    severityOnDenial: SEVERITY.LOW
  },

  // 4. Vouchers & Refunds
  "!voucher": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE"], severityOnDenial: SEVERITY.HIGH },
  "!refund": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SHOP_MANAGEMENT", "SYSTEM_EXECUTIVE"], severityOnDenial: SEVERITY.HIGH },

  // 5. System Governance: STRICTLY SUPERADMIN
  "!suspend": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!reinstate": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!tenant": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!provision": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!docket": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!backup": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!shop": {
    // !shop bind is restricted to Superadmin or Shop Owner
    roles: ["SUPERADMIN", "SHOP_OWNER"],
    channels: ["SYSTEM_EXECUTIVE", "SHOP_MANAGEMENT", "DIRECT_MESSAGE"],
    severityOnDenial: SEVERITY.HIGH,
    wrongChannelMsg: "Shop binding commands are restricted to platform administration."
  },
  "!bind": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!shops": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.MEDIUM },
  "!stores": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.MEDIUM },
  "!infractions": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!infraction": { roles: ["SUPERADMIN"], channels: ["SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },

  // 6. Helpdesk & Tickets
  "!ticket": { roles: ["*"], channels: ["SYSTEM_HELPDESK", "SHOP_MANAGEMENT", "SHOP_OPERATIONS", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.LOW },
  "!tickets": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SYSTEM_HELPDESK", "SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.LOW },
  "!resolve": { roles: ["SUPERADMIN", "SHOP_OWNER", "SHOP_MANAGER"], channels: ["SYSTEM_HELPDESK", "SYSTEM_EXECUTIVE", "DIRECT_MESSAGE"], severityOnDenial: SEVERITY.HIGH },
  "!health": { roles: ["*"], channels: ["*"], severityOnDenial: SEVERITY.LOW },
  "!status": { roles: ["*"], channels: ["*"], severityOnDenial: SEVERITY.LOW },
  "!help": { roles: ["*"], channels: ["*"], severityOnDenial: SEVERITY.LOW }
};

/**
 * Two-Factor Security Guard
 * Evaluates whether (Sender + Channel + Command) is permitted under strict Default Deny.
 */
export function evaluateAccess({
  command,
  senderPhone,
  replyJid,
  context,
  shop
}) {
  const normCmd = (command || "").trim().toLowerCase().split(/\s+/)[0];
  const rule = COMMAND_RULES[normCmd];

  // 1. Lineage Check: Is the group an approved community group?
  const lineage = validateGroupLineage(replyJid, context);
  if (!lineage.isValid) {
    return {
      permitted: false,
      decision: AUDIT_DECISION.DENIED_ORPHAN_GROUP,
      severity: SEVERITY.MEDIUM,
      reason: `Command attempted in orphan/standalone group (${replyJid}) not linked to any community.`
    };
  }

  const channelType = lineage.channelType;

  // 2. If command is not in known rules, default deny!
  if (!rule) {
    return {
      permitted: false,
      decision: AUDIT_DECISION.DENIED_ROLE_UNAUTHORIZED,
      severity: SEVERITY.MEDIUM,
      reason: `Unknown or unlisted command '${normCmd}' rejected under Default-Deny.`
    };
  }

  // 3. Sender Role Evaluation
  const role = resolveSenderRole(senderPhone, shop || context?.shop);

  // Check if role is allowed
  const isRoleAllowed = rule.roles.includes("*") || rule.roles.includes(role);
  if (!isRoleAllowed) {
    return {
      permitted: false,
      decision: role === "UNREGISTERED" ? AUDIT_DECISION.DENIED_UNREGISTERED_SENDER : AUDIT_DECISION.DENIED_ROLE_UNAUTHORIZED,
      severity: rule.severityOnDenial || SEVERITY.HIGH,
      role,
      channelType,
      reason: `Sender phone (${normalizePhone(senderPhone)}) with role '${role}' is not authorized to execute '${normCmd}'.`
    };
  }

  // 4. Channel Appropriateness Check
  // Even if sender is authorized, did they execute it in the correct channel?
  const isChannelAllowed = rule.channels.includes("*") || rule.channels.includes(channelType);
  if (!isChannelAllowed) {
    return {
      permitted: false,
      decision: AUDIT_DECISION.DENIED_WRONG_CHANNEL,
      severity: SEVERITY.LOW,
      role,
      channelType,
      reason: rule.wrongChannelMsg || `Command '${normCmd}' is not permitted in channel type '${channelType}'.`
    };
  }

  // All checks passed!
  return {
    permitted: true,
    decision: AUDIT_DECISION.PERMITTED,
    severity: SEVERITY.INFO,
    role,
    channelType
  };
}

/**
 * Records an immutable audit log entry.
 */
export function recordAuditLog({
  actorPhone,
  actorRole,
  channelJid,
  channelType,
  command,
  tenantSlug,
  decision,
  severity,
  reason,
  metadata = {}
}) {
  const now = new Date();
  const eatFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const entry = {
    id: `AUD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    timestamp: now.toISOString(),
    timestamp_eat: `${eatFormatter.format(now)} EAT`,
    actor_phone: normalizePhone(actorPhone),
    actor_role: actorRole || "UNKNOWN",
    channel_jid: channelJid || "UNKNOWN",
    channel_type: channelType || "UNKNOWN",
    command: (command || "").slice(0, 100),
    tenant_slug: tenantSlug || "platform",
    decision,
    severity,
    reason: reason || "",
    metadata
  };

  auditLogStore.unshift(entry);
  if (auditLogStore.length > MAX_AUDIT_LOGS) {
    auditLogStore.pop();
  }

  return entry;
}

/**
 * Retrieves the current audit log history (for Admin query or report generation).
 */
export function getAuditLogs(filter = {}) {
  let logs = [...auditLogStore];
  if (filter.severity) {
    logs = logs.filter(l => l.severity === filter.severity);
  }
  if (filter.tenantSlug) {
    logs = logs.filter(l => l.tenant_slug === filter.tenantSlug);
  }
  if (filter.actorPhone) {
    const clean = normalizePhone(filter.actorPhone);
    logs = logs.filter(l => l.actor_phone.endsWith(clean.slice(-9)));
  }
  if (filter.limit) {
    logs = logs.slice(0, filter.limit);
  }
  return logs;
}

/**
 * Smart Admin Alert Dispatcher
 * Sends a clean, actionable security incident card to the Admin's private WhatsApp DM
 * for HIGH and CRITICAL violations, with sliding-window anti-spam throttling.
 */
export async function dispatchSecurityAlertIfNeeded({
  auditEntry,
  safeSendMessage,
  adminJid = process.env.WHATSAPP_OWNER_PHONE ? `${normalizePhone(process.env.WHATSAPP_OWNER_PHONE)}@s.whatsapp.net` : "254710720949@s.whatsapp.net"
}) {
  // Only alert on HIGH or CRITICAL severity
  if (auditEntry.severity !== SEVERITY.HIGH && auditEntry.severity !== SEVERITY.CRITICAL) {
    return { alerted: false, reason: "SEVERITY_BELOW_THRESHOLD" };
  }

  if (!safeSendMessage) {
    return { alerted: false, reason: "NO_DISPATCHER" };
  }

  const phone = auditEntry.actor_phone || "Unknown";
  const now = Date.now();
  const throttleKey = `${phone}:${auditEntry.decision}`;
  const lastAlertTime = alertThrottleMap.get(throttleKey) || 0;

  // If alerted within the last 60 seconds for the same actor and violation, throttle to prevent spam
  if (now - lastAlertTime < THROTTLE_WINDOW_MS) {
    return { alerted: false, reason: "THROTTLED" };
  }

  alertThrottleMap.set(throttleKey, now);

  const icon = auditEntry.severity === SEVERITY.CRITICAL ? "🚨" : "🛡️";
  const alertText =
    `${icon} *SECURITY INCIDENT ALERT: ${auditEntry.severity}*\n` +
    `-----------------------------------------\n` +
    `• *Incident ID:* \`${auditEntry.id}\`\n` +
    `• *Time:* ${auditEntry.timestamp_eat}\n` +
    `• *Actor Phone:* \`${phone}\` (Role: ${auditEntry.actor_role})\n` +
    `• *Channel Type:* \`${auditEntry.channel_type}\`\n` +
    `• *Attempted Command:* \`${auditEntry.command}\`\n` +
    `• *Tenant:* \`${auditEntry.tenant_slug}\`\n` +
    `• *Violation Decision:* \`${auditEntry.decision}\`\n` +
    `• *Forensic Reason:* ${auditEntry.reason}\n\n` +
    `⚠️ _Request was bounced immediately. The command was NOT executed._`;

  try {
    await safeSendMessage(adminJid, { text: alertText });
    return { alerted: true, incidentId: auditEntry.id };
  } catch (err) {
    console.error(`[SECURITY ALERT DISPATCH FAILED]`, err.message);
    return { alerted: false, error: err.message };
  }
}

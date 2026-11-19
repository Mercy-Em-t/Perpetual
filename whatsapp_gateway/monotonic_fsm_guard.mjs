/**
 * Monotonic FSM Guard & Forward-Only State Engine
 * Enforces:
 * 1. Strict Forward-Propagation: Orders can ONLY move forward in their lifecycle.
 * 2. Anti-Backwash Defense: Rejects any attempt to rewind, recycle, or reset completed/in-flight orders.
 * 3. Idempotency Guard: Safely handles duplicate messages/webhooks without state corruption.
 * 4. Terminal State Freeze: Cancelled, Refunded, or Completed orders are permanently immutable.
 */

import { recordAuditLog, AUDIT_DECISION, SEVERITY } from "./security_access_sentinel.mjs";

export const FSM_RANKS = {
  // Rank 0: Ingress & Reservation
  "PENDING": 0,
  "UNPAID": 0,
  "CREATED": 0,
  "HELD": 0,

  // Rank 1: Cashier Settlement
  "PAID": 1,
  "SETTLED": 1,
  "COMMITTED": 1,

  // Rank 2: Kitchen / Floor Packaging
  "PACKAGING": 2,
  "PACKED": 2,
  "BOXED": 2,

  // Rank 3: QA Verification & Packing Slip
  "VERIFIED": 3,
  "QA_PASSED": 3,

  // Rank 4: Logistics & Courier Handover
  "IN_TRANSIT": 4,
  "DISPATCHED": 4,

  // Rank 5: Customer Doorstep Arrival
  "DELIVERED": 5,

  // Rank 6: Dual Confirmation & Financial Settlement Closed
  "COMPLETED": 6,
  "CLOSED": 6,

  // Terminal Dead States
  "CANCELLED": 99,
  "REFUNDED": 99
};

/**
 * Resolves the numeric rank of an existing order.
 */
export function getOrderRank(order) {
  if (!order) return 0;

  // Check terminal flags first
  const statusUpper = String(order.status || "").toUpperCase();
  const internalUpper = String(order.internal_status || "").toUpperCase();

  if (statusUpper === "CANCELLED" || internalUpper === "CANCELLED") return FSM_RANKS.CANCELLED;
  if (statusUpper === "REFUNDED" || internalUpper === "REFUNDED") return FSM_RANKS.REFUNDED;
  if (statusUpper === "COMPLETED" || internalUpper === "COMPLETED") return FSM_RANKS.COMPLETED;

  // Priority: internal_status specifies precise station, fallback to db status
  if (internalUpper && FSM_RANKS[internalUpper] !== undefined) {
    return FSM_RANKS[internalUpper];
  }

  if (statusUpper && FSM_RANKS[statusUpper] !== undefined) {
    return FSM_RANKS[statusUpper];
  }

  return 0;
}

/**
 * Maps incoming command to its target FSM station rank and representation.
 */
export function getCommandTargetRank(command) {
  const norm = String(command || "").trim().toLowerCase();

  switch (norm) {
    case "!paid":
    case "!clear":
    case "!pair":
      return { rank: 1, targetInternal: "PAID", targetDbStatus: "paid", label: "PAID & SETTLED" };

    case "!pack":
      return { rank: 2, targetInternal: "PACKAGING", targetDbStatus: null, label: "PACKAGING (Crafting & Boxed)" };

    case "!verify":
      return { rank: 3, targetInternal: "VERIFIED", targetDbStatus: null, label: "QA & PAYMENT VERIFIED" };

    case "!dispatch":
      return { rank: 4, targetInternal: "IN_TRANSIT", targetDbStatus: "dispatched", label: "DISPATCHED (In Transit with Rider)" };

    case "!delivered":
      return { rank: 5, targetInternal: "DELIVERED", targetDbStatus: "dispatched", label: "DELIVERED BY RIDER" };

    case "!confirm":
      return { rank: 6, targetInternal: "COMPLETED", targetDbStatus: "completed", label: "COMPLETED (Dual Confirmed)" };

    case "!cancel":
      return { rank: 99, targetInternal: "CANCELLED", targetDbStatus: "cancelled", label: "CANCELLED" };

    case "!refund":
      return { rank: 99, targetInternal: "REFUNDED", targetDbStatus: "refunded", label: "REFUNDED" };

    default:
      return null;
  }
}

/**
 * Evaluates whether an order can transition to the target command.
 * Enforces Forward-Only state propagation and anti-backwash invariance.
 */
export function evaluateFsmTransition(order, command, actorPhone = "system") {
  const target = getCommandTargetRank(command);
  if (!target) {
    return {
      allowed: false,
      reason: "UNKNOWN_FSM_COMMAND",
      message: `Command '${command}' does not map to a recognized FSM station.`
    };
  }

  const currentRank = getOrderRank(order);
  const currentInternal = String(order?.internal_status || order?.status || "PENDING").toUpperCase();

  // 1. Terminal Freeze: If order is cancelled or refunded, no further station updates are permitted
  if (currentRank === FSM_RANKS.CANCELLED || currentRank === FSM_RANKS.REFUNDED) {
    return {
      allowed: false,
      isTerminal: true,
      reason: "TERMINAL_STATE_FROZEN",
      message: `🛑 *Order Frozen:* Order \`${order?.id?.slice(0, 8)}\` is currently *${currentInternal}*. Completed or aborted orders cannot be altered or re-advanced.`
    };
  }

  // 2. Completed Order Freeze: Cannot backwash a completed order
  if (currentRank === FSM_RANKS.COMPLETED) {
    return {
      allowed: false,
      isTerminal: true,
      reason: "ORDER_ALREADY_COMPLETED",
      message: `🔒 *Order Already Completed:* Order \`${order?.id?.slice(0, 8)}\` is finalized and delivered. It cannot be reverted back to *${target.label}*.`
    };
  }

  // 3. Idempotency Check (Duplicate message / duplicate webhook)
  if (currentRank === target.rank) {
    return {
      allowed: false,
      isIdempotent: true,
      reason: "IDEMPOTENT_ALREADY_AT_STATION",
      message: `ℹ️ *Already at Station:* Order \`${order?.id?.slice(0, 8)}\` is already marked as *${target.label}*. No state change required.`
    };
  }

  // 4. Anti-Backwash Guard: Strict Forward Propagation Invariant
  // Target rank MUST be strictly greater than current rank!
  if (target.rank < currentRank) {
    recordAuditLog({
      actorPhone,
      actorRole: "OPERATOR",
      command,
      tenantSlug: order?.shop_id || "platform",
      decision: "DENIED_BACKWASH_ATTEMPT",
      severity: SEVERITY.LOW,
      reason: `Attempted state backwash from rank ${currentRank} (${currentInternal}) to rank ${target.rank} (${target.label})`
    });

    return {
      allowed: false,
      isBackwash: true,
      reason: "STATE_REGRESSION_PREVENTED",
      message: `⚠️ *State Backwash Blocked:* Order \`${order?.id?.slice(0, 8)}\` is already at station *${currentInternal}* (Stage ${currentRank}).\n\nIt cannot be reverted backward to *${target.label}* (Stage ${target.rank}). Order flow is strictly forward-only.`
    };
  }

  // 5. Permitted Forward Transition
  return {
    allowed: true,
    target,
    currentRank,
    targetRank: target.rank
  };
}

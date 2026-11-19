/**
 * Test Suite: Monotonic FSM Invariance, Anti-Backwash State Safety & Ambient Voice Parser
 * 
 * Verifies:
 * 1. Strict Forward-Propagation: PENDING -> PAID -> PACKAGING -> VERIFIED -> DISPATCHED -> COMPLETED
 * 2. Anti-Backwash: Rejects attempting to mark a DISPATCHED or COMPLETED order as PAID/PACKAGING.
 * 3. Terminal State Freeze: Cancelled/Refunded/Completed orders cannot be mutated.
 * 4. Idempotency: Duplicate messages at the same station do not duplicate actions or corrupt state.
 * 5. Ambient Voice-to-FSM: Speech transcripts in English & Swahili parse directly into FSM commands.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFsmTransition,
  getOrderRank,
  getCommandTargetRank,
  FSM_RANKS
} from "./monotonic_fsm_guard.mjs";

import {
  parseVoiceTranscription
} from "./voice_fsm_parser.mjs";

describe("Monotonic FSM Invariant: Strict Forward-Only Progression", () => {

  test("FSM-1: Normal forward station progression is permitted", () => {
    // 1. PENDING (Rank 0) -> !paid (Rank 1)
    const order0 = { id: "ord-test-001", status: "pending", internal_status: "PENDING" };
    const step1 = evaluateFsmTransition(order0, "!paid");
    assert.equal(step1.allowed, true);
    assert.equal(step1.targetRank, 1);

    // 2. PAID (Rank 1) -> !pack (Rank 2)
    const order1 = { id: "ord-test-001", status: "paid", internal_status: "PAID" };
    const step2 = evaluateFsmTransition(order1, "!pack");
    assert.equal(step2.allowed, true);
    assert.equal(step2.targetRank, 2);

    // 3. PACKAGING (Rank 2) -> !verify (Rank 3)
    const order2 = { id: "ord-test-001", status: "paid", internal_status: "PACKAGING" };
    const step3 = evaluateFsmTransition(order2, "!verify");
    assert.equal(step3.allowed, true);
    assert.equal(step3.targetRank, 3);

    // 4. VERIFIED (Rank 3) -> !dispatch (Rank 4)
    const order3 = { id: "ord-test-001", status: "paid", internal_status: "VERIFIED" };
    const step4 = evaluateFsmTransition(order3, "!dispatch");
    assert.equal(step4.allowed, true);
    assert.equal(step4.targetRank, 4);

    // 5. IN_TRANSIT (Rank 4) -> !delivered (Rank 5)
    const order4 = { id: "ord-test-001", status: "dispatched", internal_status: "IN_TRANSIT" };
    const step5 = evaluateFsmTransition(order4, "!delivered");
    assert.equal(step5.allowed, true);
    assert.equal(step5.targetRank, 5);

    // 6. DELIVERED (Rank 5) -> !confirm (Rank 6)
    const order5 = { id: "ord-test-001", status: "dispatched", internal_status: "DELIVERED" };
    const step6 = evaluateFsmTransition(order5, "!confirm");
    assert.equal(step6.allowed, true);
    assert.equal(step6.targetRank, 6);
  });

  test("FSM-2: Anti-Backwash Defense — Dispatched order cannot be rewound to PAID or PACKAGING", () => {
    // Order is already DISPATCHED with a courier
    const dispatchedOrder = {
      id: "ord-dispatched-001",
      status: "dispatched",
      internal_status: "IN_TRANSIT"
    };

    // Attempt 1: Late or rogue !paid message arriving
    const resPaid = evaluateFsmTransition(dispatchedOrder, "!paid");
    assert.equal(resPaid.allowed, false);
    assert.equal(resPaid.isBackwash, true);
    assert.equal(resPaid.reason, "STATE_REGRESSION_PREVENTED");
    assert.match(resPaid.message, /State Backwash Blocked/);

    // Attempt 2: Late !pack arriving
    const resPack = evaluateFsmTransition(dispatchedOrder, "!pack");
    assert.equal(resPack.allowed, false);
    assert.equal(resPack.isBackwash, true);
    assert.equal(resPack.reason, "STATE_REGRESSION_PREVENTED");
  });

  test("FSM-3: Terminal State Freeze — Completed order is permanently immutable", () => {
    const completedOrder = {
      id: "ord-complete-999",
      status: "completed",
      internal_status: "COMPLETED"
    };

    const resPaid = evaluateFsmTransition(completedOrder, "!paid");
    assert.equal(resPaid.allowed, false);
    assert.equal(resPaid.isTerminal, true);
    assert.equal(resPaid.reason, "ORDER_ALREADY_COMPLETED");
  });

  test("FSM-4: Cancelled or Refunded order is frozen against all station movements", () => {
    const cancelledOrder = {
      id: "ord-cancelled-777",
      status: "cancelled",
      internal_status: "CANCELLED"
    };

    const res = evaluateFsmTransition(cancelledOrder, "!dispatch");
    assert.equal(res.allowed, false);
    assert.equal(res.isTerminal, true);
    assert.equal(res.reason, "TERMINAL_STATE_FROZEN");
  });

  test("FSM-5: Idempotency Guard — Duplicate messages at the same station are acknowledged without state changes", () => {
    const paidOrder = {
      id: "ord-paid-222",
      status: "paid",
      internal_status: "PAID"
    };

    // Duplicate !paid sent
    const res = evaluateFsmTransition(paidOrder, "!paid");
    assert.equal(res.allowed, false);
    assert.equal(res.isIdempotent, true);
    assert.equal(res.reason, "IDEMPOTENT_ALREADY_AT_STATION");
    assert.match(res.message, /Already at Station/);
  });
});

describe("Ambient Voice-to-FSM Intelligence Parser (Audio Transcription Bridge)", () => {

  test("VOICE-1: Transcribed Swahili speech for packaging translates to !pack", () => {
    const transcript = "Nimepack order 4e46 tayari";
    const res = parseVoiceTranscription(transcript);
    assert.equal(res.success, true);
    assert.equal(res.command, "!pack");
    assert.equal(res.orderId, "4e46");
    assert.equal(res.normalizedCommand, "!pack 4e46");
  });

  test("VOICE-2: Transcribed payment voice note translates to !paid with M-Pesa reference", () => {
    const transcript = "Lipa order 4e46 ref QKC982143";
    const res = parseVoiceTranscription(transcript);
    assert.equal(res.success, true);
    assert.equal(res.command, "!paid");
    assert.equal(res.orderId, "4e46");
    assert.equal(res.extraArg, "QKC982143");
    assert.equal(res.normalizedCommand, "!paid 4e46 QKC982143");
  });

  test("VOICE-3: Transcribed dispatch voice note translates to !dispatch with courier name", () => {
    const transcript = "Dispatch order ORD-1234 rider Brian";
    const res = parseVoiceTranscription(transcript);
    assert.equal(res.success, true);
    assert.equal(res.command, "!dispatch");
    assert.equal(res.orderId, "ORD-1234");
    assert.equal(res.extraArg, "Brian");
    assert.equal(res.normalizedCommand, "!dispatch ORD-1234 Brian");
  });

  test("VOICE-4: Unrelated conversation does not trigger false-positive FSM commands", () => {
    const transcript = "Habari za asubuhi, tutakutana saa ngapi leo?";
    const res = parseVoiceTranscription(transcript);
    assert.equal(res.success, false);
    assert.equal(res.reason, "NO_MATCHING_FSM_INTENT");
  });
});

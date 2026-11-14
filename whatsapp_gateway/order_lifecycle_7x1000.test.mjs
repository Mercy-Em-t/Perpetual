import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { OrderGuard } from "./order_guard.mjs";
import { sealCheckoutEnvelope } from "./blind_checkout_crypto.mjs";

const PII_KEY = "test-pii-secret-key-32bytes-tms!";
const INSPECTOR_KEY = "test-order-guard-inspector-key!!";
const HMAC_SECRET = "test-hmac-secret-tms-storefront!";

const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);

/** Deterministic PRNG so 7x1000 telemetry is reproducible across CI runs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Number(sorted[idx].toFixed(3));
}

function summarizeLatencies(samplesMs, wallMs, count) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    wall_ms: Number(wallMs.toFixed(2)),
    p50_ms: quantile(sorted, 0.5),
    p95_ms: quantile(sorted, 0.95),
    p99_ms: quantile(sorted, 0.99),
    rps: wallMs > 0 ? Math.round((count / wallMs) * 1000) : 0
  };
}

function seal(rawCheckout) {
  return sealCheckoutEnvelope(rawCheckout, {
    piiKey: PII_KEY,
    inspectorKey: INSPECTOR_KEY,
    hmacSecret: HMAC_SECRET
  });
}

function createGuard(nowRef, overrides = {}) {
  return new OrderGuard({
    inspectorKey: INSPECTOR_KEY,
    hmacSecret: HMAC_SECRET,
    stateFile: null,
    nowFn: () => nowRef.ms,
    holdTtlMs: 10 * 60 * 1000,
    graceTtlMs: 3 * 60 * 1000,
    maxOrderValue: 20000,
    ...overrides
  });
}

/**
 * Mirrors src/services/order-guard-client.js exponential backoff & retry semantics
 * against a simulated transport + real OrderGuard instance, tracking virtual wait time
 * so 7,000 requests run fast while computing exact production backoff schedules.
 */
async function executeWithBackoff(transportFn, { maxRetries = 2, baseDelayMs = 60, maxDelayMs = 800, rng = Math.random } = {}) {
  let attempt = 0;
  let retriesUsed = 0;
  let simulatedBackoffMs = 0;

  while (true) {
    try {
      const res = await transportFn(attempt);
      if (RETRYABLE_HTTP_STATUSES.has(res.httpStatus) && attempt < maxRetries) {
        const expDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
        const jitter = Math.round(rng() * 30);
        simulatedBackoffMs += Math.min(maxDelayMs, expDelay + jitter);
        retriesUsed += 1;
        attempt += 1;
        await Promise.resolve();
        continue;
      }
      if (RETRYABLE_HTTP_STATUSES.has(res.httpStatus)) {
        return {
          ok: false,
          httpStatus: res.httpStatus,
          verdict: {
            decision: "REJECTED",
            code: "GATEWAY_UNREACHABLE",
            can_show_payment: false,
            error: "Order Guard HTTP 5xx after retries"
          },
          retriesUsed,
          simulatedBackoffMs
        };
      }
      return {
        ok: res.httpStatus < 400,
        httpStatus: res.httpStatus,
        verdict: res.body,
        retriesUsed,
        simulatedBackoffMs
      };
    } catch (err) {
      if (attempt >= maxRetries) {
        return {
          ok: false,
          httpStatus: 0,
          verdict: {
            decision: "REJECTED",
            code: "GATEWAY_UNREACHABLE",
            can_show_payment: false,
            error: err.message
          },
          retriesUsed,
          simulatedBackoffMs
        };
      }
      const expDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      const jitter = Math.round(rng() * 30);
      simulatedBackoffMs += Math.min(maxDelayMs, expDelay + jitter);
      retriesUsed += 1;
      attempt += 1;
      await Promise.resolve();
    }
  }
}

/** Mirrors applyOrderGuardRemedy from order-guard-client.js + min/step helpers */
function applyRemedy(verdict, items = []) {
  if (!verdict || !Array.isArray(items)) {
    return { remedied: false, action: "NO_REMEDY", updatedItems: items, canRetryImmediately: false };
  }
  const targetKey = String(verdict.item || "").trim().toLowerCase();

  if (verdict.decision === "TRIMMED_SUREBET" && Array.isArray(verdict.items)) {
    return { remedied: true, action: "SYNCED_SUREBET", updatedItems: verdict.items, canRetryImmediately: false };
  }
  if (verdict.code === "INSUFFICIENT_STOCK" && targetKey && Number(verdict.available) > 0) {
    const nextQty = Number(verdict.available);
    const updatedItems = items.map((it) => {
      const k = String(it.id || it.item_id || it.name || "").trim().toLowerCase();
      return k === targetKey ? { ...it, qty: nextQty, quantity: nextQty } : it;
    });
    return { remedied: true, action: "ADJUSTED_TO_AVAILABLE", updatedItems, canRetryImmediately: true };
  }
  if (verdict.code === "MAX_PER_ORDER_EXCEEDED" && targetKey && Number(verdict.max_per_order) > 0) {
    const capQty = Number(verdict.max_per_order);
    const updatedItems = items.map((it) => {
      const k = String(it.id || it.item_id || it.name || "").trim().toLowerCase();
      return k === targetKey ? { ...it, qty: capQty, quantity: capQty } : it;
    });
    return { remedied: true, action: "CAPPED_TO_MAX_PER_ORDER", updatedItems, canRetryImmediately: true };
  }
  if (verdict.code === "BELOW_MIN_QTY" && targetKey && Number(verdict.min_qty) > 0) {
    const minQty = Number(verdict.min_qty);
    const updatedItems = items.map((it) => {
      const k = String(it.id || it.item_id || it.name || "").trim().toLowerCase();
      return k === targetKey ? { ...it, qty: minQty, quantity: minQty } : it;
    });
    return { remedied: true, action: "RAISED_TO_MIN_QTY", updatedItems, canRetryImmediately: true };
  }
  if (verdict.code === "INVALID_STEP_QTY" && targetKey && Number(verdict.step_qty) > 1) {
    const step = Number(verdict.step_qty);
    const updatedItems = items.map((it) => {
      const k = String(it.id || it.item_id || it.name || "").trim().toLowerCase();
      if (k !== targetKey) return it;
      const cur = Number(it.qty ?? it.quantity ?? step);
      const snapped = Math.max(step, Math.floor(cur / step) * step);
      return { ...it, qty: snapped, quantity: snapped };
    });
    return { remedied: true, action: "SNAPPED_TO_STEP_QTY", updatedItems, canRetryImmediately: true };
  }
  if (verdict.code === "SOLD_OUT" && targetKey) {
    const updatedItems = items.filter((it) => {
      const k = String(it.id || it.item_id || it.name || "").trim().toLowerCase();
      return k !== targetKey;
    });
    return {
      remedied: true,
      action: "REMOVED_SOLD_OUT",
      updatedItems,
      canRetryImmediately: updatedItems.length > 0
    };
  }
  return { remedied: false, action: "NO_REMEDY", updatedItems: items, canRetryImmediately: false };
}

function logSampleReport(report) {
  console.log(`[SAMPLE_REPORT] ${JSON.stringify(report)}`);
}

describe("TMS Storefront -> Order Guard -> Payment Lifecycle Probe (7 samples x 1,000 requests = 7,000)", () => {
  it("Sample 1/7 (1,000 reqs): Healthy Happy Path + Full Hold->Commit Lifecycle + Idempotent Resumes", async () => {
    const nowRef = { ms: Date.UTC(2026, 10, 14, 9, 0, 0) };
    const guard = createGuard(nowRef);
    const shopId = "shop-tms-s1";
    await guard.configureItemPolicy(shopId, "sku-tote", {
      name: "TMS Canvas Tote",
      daily_cap: 1500,
      unit_price: 1500
    });

    const latMs = [];
    const outcomes = {
      committed_fresh: 0,
      held_awaiting_resume: 0,
      resumed_hold_then_committed: 0,
      replayed_already_committed: 0,
      rejected: 0
    };

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const r0 = performance.now();
      if (i < 850) {
        const orderId = `S1-ORD-${i}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470010${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-tote", qty: 1, unit_price: 1500 }]
        }));
        assert.equal(v.decision, "APPROVED");
        assert.equal(v.can_show_payment, true);
        const c = await guard.commitOrder(orderId);
        assert.equal(c.code, "COMMITTED");
        outcomes.committed_fresh += 1;
      } else if (i < 900) {
        const orderId = `S1-HOLD-${i - 850}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25471110${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-tote", qty: 1, unit_price: 1500 }]
        }));
        assert.equal(v.code, "STOCK_RESERVED");
        outcomes.held_awaiting_resume += 1;
      } else if (i < 950) {
        const idx = i - 900;
        const orderId = `S1-HOLD-${idx}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25471110${String(850 + idx).padStart(4, "0")}`,
          items: [{ id: "sku-tote", qty: 1, unit_price: 1500 }]
        }));
        assert.equal(v.code, "HOLD_ALREADY_ACTIVE");
        assert.equal(v.can_show_payment, true);
        const c = await guard.commitOrder(orderId);
        assert.equal(c.code, "COMMITTED");
        outcomes.resumed_hold_then_committed += 1;
      } else {
        const orderId = `S1-ORD-${i - 950}`;
        const c = await guard.commitOrder(orderId);
        assert.equal(c.code, "ALREADY_COMMITTED");
        outcomes.replayed_already_committed += 1;
      }
      latMs.push(performance.now() - r0);
    }
    const wallMs = performance.now() - t0;

    const summary = await guard.getDailyStockSummary(shopId);
    const pool = summary.items.find((x) => x.item_id === "sku-tote");
    assert.equal(pool.sold, 900);
    assert.equal(pool.held, 0);
    assert.equal(outcomes.rejected, 0);

    logSampleReport({
      sample: "S1_HAPPY_PATH_FULL_LIFECYCLE",
      requests: 1000,
      outcomes,
      inventory_check: { daily_cap: 1500, sold: pool.sold, held: pool.held, available: pool.available, oversold: pool.sold > 1500 },
      latency_ms: summarizeLatencies(latMs, wallMs, 1000)
    });
  });

  it("Sample 2/7 (1,000 reqs): Premature Termination, TTL Expiry (10m+3m Grace), Late Recovery & Refund Guard", async () => {
    const nowRef = { ms: Date.UTC(2026, 10, 14, 10, 0, 0) };
    const guard = createGuard(nowRef);
    const shopId = "shop-tms-s2";
    await guard.configureItemPolicy(shopId, "sku-scarce", {
      name: "Savannah Ceramic Mug",
      daily_cap: 350,
      unit_price: 1200
    });
    await guard.configureItemPolicy(shopId, "sku-grace", {
      name: "Grace Window Pouch",
      daily_cap: 100,
      unit_price: 900
    });

    // Reserve 50 holds on sku-grace at T0 to test 11m grace commit in requests 950..999
    for (let g = 0; g < 50; g++) {
      const v = await guard.inspectAndReserve(seal({
        order_id: `S2-GRACE-${g}`,
        shop_id: shopId,
        customer_phone: `+25479990${String(g).padStart(4, "0")}`,
        items: [{ id: "sku-grace", qty: 1, unit_price: 900 }]
      }));
      assert.equal(v.decision, "APPROVED");
    }

    const latMs = [];
    const outcomes = {
      abandoned_before_pay_expired: 0,
      released_by_customer_abort: 0,
      fresh_committed_after_reclaim: 0,
      late_payment_recovered: 0,
      refund_required_prevented_oversell: 0,
      hold_not_recoverable_after_abort: 0,
      grace_window_committed: 0
    };

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const r0 = performance.now();
      if (i < 300) {
        // Reserve and prematurely close tab without paying
        const v = await guard.inspectAndReserve(seal({
          order_id: `S2-ABANDON-${i}`,
          shop_id: shopId,
          customer_phone: `+25470020${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-scarce", qty: 1, unit_price: 1200 }]
        }));
        assert.equal(v.decision, "APPROVED");
        outcomes.abandoned_before_pay_expired += 1;
        if (i === 299) {
          // Advance past 10m hold + 3m grace (13m 1s total) so all 300 expire on next sweep
          // Meanwhile grace-window items were reserved at T0; check wait: grace holds would ALSO expire if +13m!
          // Keep track: create 50 grace holds AFTER advancing clock to T0+14m, then advance +11m later?
          // Let's do grace holds right after reclaim before advancing past 13m for grace!
        }
      } else if (i < 450) {
        if (i === 300) {
          nowRef.ms += 13 * 60 * 1000 + 1000;
          const swept = await guard.sweepExpiredHolds();
          assert.ok(swept >= 300, `Expected at least 300 expired holds swept, got ${swept}`);
        }
        const orderId = `S2-ABORT-${i - 300}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470120${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-scarce", qty: 1, unit_price: 1200 }]
        }));
        assert.equal(v.decision, "APPROVED");
        const rel = await guard.releaseOrder(orderId, "CUSTOMER_ABORTED");
        assert.equal(rel.code, "HOLD_RELEASED");
        outcomes.released_by_customer_abort += 1;
      } else if (i < 650) {
        const orderId = `S2-FRESH-${i - 450}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470220${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-scarce", qty: 1, unit_price: 1200 }]
        }));
        assert.equal(v.decision, "APPROVED");
        const c = await guard.commitOrder(orderId);
        assert.equal(c.code, "COMMITTED");
        outcomes.fresh_committed_after_reclaim += 1;
      } else if (i < 800) {
        // Late M-Pesa confirmation arrives on EXPIRED S2-ABANDON-0..149 while 150 units remain
        const idx = i - 650;
        const c = await guard.commitOrder(`S2-ABANDON-${idx}`);
        assert.equal(c.success, true);
        assert.equal(c.code, "LATE_PAYMENT_RECOVERED");
        outcomes.late_payment_recovered += 1;
      } else if (i < 900) {
        // Late M-Pesa arrives on EXPIRED S2-ABANDON-150..249 AFTER cap (350) is sold out -> REFUND_REQUIRED!
        const idx = 150 + (i - 800);
        const c = await guard.commitOrder(`S2-ABANDON-${idx}`);
        assert.equal(c.success, false);
        assert.equal(c.code, "REFUND_REQUIRED");
        outcomes.refund_required_prevented_oversell += 1;
      } else if (i < 950) {
        // Late payment attempt on explicitly aborted hold -> never recoverable
        const idx = i - 900;
        const c = await guard.commitOrder(`S2-ABORT-${idx}`);
        assert.equal(c.success, false);
        assert.equal(c.code, "HOLD_NOT_RECOVERABLE");
        outcomes.hold_not_recoverable_after_abort += 1;
      } else {
        // Fresh batch of 50 holds testing the 11-minute mark (past 10m hold, inside 3m grace)
        const idx = i - 950;
        if (idx === 0) {
          for (let g = 0; g < 50; g++) {
            await guard.inspectAndReserve(seal({
              order_id: `S2-IN-GRACE-${g}`,
              shop_id: shopId,
              customer_phone: `+25478880${String(g).padStart(4, "0")}`,
              items: [{ id: "sku-grace", qty: 1, unit_price: 900 }]
            }));
          }
          nowRef.ms += 11 * 60 * 1000; // +11m: past holdTtlMs(10m), inside grace_until(13m)
        }
        const c = await guard.commitOrder(`S2-IN-GRACE-${idx}`);
        assert.equal(c.success, true);
        assert.equal(c.code, "COMMITTED");
        outcomes.grace_window_committed += 1;
      }
      latMs.push(performance.now() - r0);
    }
    const wallMs = performance.now() - t0;

    nowRef.ms += 15 * 60 * 1000;
    await guard.sweepExpiredHolds();
    const summary = await guard.getDailyStockSummary(shopId);
    const scarcePool = summary.items.find((x) => x.item_id === "sku-scarce");
    const gracePool = summary.items.find((x) => x.item_id === "sku-grace");

    assert.equal(scarcePool.sold, 350);
    assert.equal(scarcePool.held, 0);
    assert.equal(gracePool.sold, 50);
    assert.equal(gracePool.held, 0);

    logSampleReport({
      sample: "S2_PREMATURE_TERMINATION_AND_TTL_SWEEP",
      requests: 1000,
      outcomes,
      ttl: {
        hold_ttl_ms: 600000,
        grace_ttl_ms: 180000,
        abandoned_expired_and_reclaimed: 300,
        late_payments_recovered: outcomes.late_payment_recovered,
        refund_required_prevented_oversell: outcomes.refund_required_prevented_oversell
      },
      inventory_check: {
        sku_scarce: { daily_cap: 350, sold: scarcePool.sold, held: scarcePool.held, oversold: scarcePool.sold > 350 },
        sku_grace: { daily_cap: 100, sold: gracePool.sold, held: gracePool.held, oversold: gracePool.sold > 100 }
      },
      latency_ms: summarizeLatencies(latMs, wallMs, 1000)
    });
  });

  it("Sample 3/7 (1,000 reqs): Restarted Sessions, Active-Hold Resume, Order-ID Collision & Replay Guards", async () => {
    const nowRef = { ms: Date.UTC(2026, 10, 14, 11, 0, 0) };
    const guard = createGuard(nowRef);
    const shopId = "shop-tms-s3";
    await guard.configureItemPolicy(shopId, "sku-serum", {
      name: "Baobab Glow Serum",
      daily_cap: 600,
      unit_price: 2200
    });

    const latMs = [];
    const outcomes = {
      initial_holds_reserved: 0,
      restarted_session_resumed_and_committed: 0,
      cross_customer_collision_blocked: 0,
      duplicate_post_commit_replays: 0
    };

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const r0 = performance.now();
      if (i < 400) {
        const v = await guard.inspectAndReserve(seal({
          order_id: `S3-ORD-${i}`,
          shop_id: shopId,
          customer_phone: `+25470030${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-serum", qty: 1, unit_price: 2200 }]
        }));
        assert.equal(v.code, "STOCK_RESERVED");
        outcomes.initial_holds_reserved += 1;
      } else if (i < 750) {
        const idx = i - 400;
        // Customer refreshes tab / restarts browser -> reuses order_id with same phone & shop
        const v = await guard.inspectAndReserve(seal({
          order_id: `S3-ORD-${idx}`,
          shop_id: shopId,
          customer_phone: `+25470030${String(idx).padStart(4, "0")}`,
          items: [{ id: "sku-serum", qty: 1, unit_price: 2200 }]
        }));
        assert.equal(v.decision, "APPROVED");
        assert.equal(v.code, "HOLD_ALREADY_ACTIVE");
        assert.equal(v.can_show_payment, true);
        const c = await guard.commitOrder(`S3-ORD-${idx}`);
        assert.equal(c.code, "COMMITTED");
        outcomes.restarted_session_resumed_and_committed += 1;
      } else if (i < 900) {
        // Collision test against active holds 350..399
        const targetIdx = 350 + ((i - 750) % 50);
        const v = await guard.inspectAndReserve(seal({
          order_id: `S3-ORD-${targetIdx}`,
          shop_id: shopId,
          customer_phone: `+25479999${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-serum", qty: 1, unit_price: 2200 }]
        }));
        assert.equal(v.decision, "REJECTED");
        assert.equal(v.code, "ORDER_ID_CONFLICT");
        assert.equal(v.can_show_payment, false);
        outcomes.cross_customer_collision_blocked += 1;
      } else {
        // Double-tap / webhook duplicate replay against committed 0..99
        const idx = i - 900;
        const c = await guard.commitOrder(`S3-ORD-${idx}`);
        assert.equal(c.success, true);
        assert.equal(c.code, "ALREADY_COMMITTED");
        outcomes.duplicate_post_commit_replays += 1;
      }
      latMs.push(performance.now() - r0);
    }
    const wallMs = performance.now() - t0;

    nowRef.ms += 15 * 60 * 1000;
    await guard.sweepExpiredHolds();
    const summary = await guard.getDailyStockSummary(shopId);
    const pool = summary.items.find((x) => x.item_id === "sku-serum");
    assert.equal(pool.sold, 350);
    assert.equal(pool.held, 0);

    logSampleReport({
      sample: "S3_RESTARTED_SESSIONS_AND_DUPLICATES",
      requests: 1000,
      outcomes,
      inventory_check: { daily_cap: 600, sold: pool.sold, held: pool.held, available: pool.available, oversold: pool.sold > 600 },
      latency_ms: summarizeLatencies(latMs, wallMs, 1000)
    });
  });

  it("Sample 4/7 (1,000 reqs): OOS Scarcity, Surebet Auto-Trim, Multi-Item Remedy & Live Restock Recovery", async () => {
    const nowRef = { ms: Date.UTC(2026, 10, 14, 12, 0, 0) };
    const guard = createGuard(nowRef);
    const shopId = "shop-tms-s4";

    await guard.configureItemPolicy(shopId, "sku-hot", {
      name: "Limited Linen Robe",
      daily_cap: 200,
      partial_fill_mode: "strict",
      unit_price: 3500
    });
    await guard.configureItemPolicy(shopId, "sku-steady", {
      name: "Shea Hand Wash",
      daily_cap: 1000,
      partial_fill_mode: "strict",
      unit_price: 800
    });
    for (let s = 0; s < 50; s++) {
      await guard.configureItemPolicy(shopId, `sku-sure-${s}`, {
        name: `Surebet Soap #${s}`,
        daily_cap: 3,
        partial_fill_mode: "surebet",
        unit_price: 600
      });
    }

    const latMs = [];
    const outcomes = {
      initial_sold: 0,
      insufficient_stock_remedied_to_available: 0,
      sold_out_unrecoverable_single_item: 0,
      surebet_trimmed_and_committed: 0,
      multi_item_oos_removed_and_committed: 0,
      post_restock_recovered_and_committed: 0
    };
    const remediesApplied = {
      ADJUSTED_TO_AVAILABLE: 0,
      SYNCED_SUREBET: 0,
      REMOVED_SOLD_OUT: 0
    };

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const r0 = performance.now();
      if (i < 195) {
        const orderId = `S4-HOT-${i}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470040${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-hot", qty: 1, unit_price: 3500 }]
        }));
        assert.equal(v.decision, "APPROVED");
        await guard.commitOrder(orderId);
        outcomes.initial_sold += 1;
      } else if (i < 245) {
        // Pool has 5 left at i===195; buyer requests 10 -> INSUFFICIENT_STOCK -> adjusted to 5 -> commits
        // Remaining 49 buyers hit SOLD_OUT
        const items = [{ id: "sku-hot", qty: 10, unit_price: 3500 }];
        const orderId = `S4-LOW-${i}`;
        const v1 = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470041${String(i).padStart(4, "0")}`,
          items
        }));
        if (i === 195) {
          assert.equal(v1.code, "INSUFFICIENT_STOCK");
          assert.equal(v1.available, 5);
          const rem = applyRemedy(v1, items);
          assert.equal(rem.action, "ADJUSTED_TO_AVAILABLE");
          assert.equal(rem.canRetryImmediately, true);
          remediesApplied.ADJUSTED_TO_AVAILABLE += 1;

          const v2 = await guard.inspectAndReserve(seal({
            order_id: `${orderId}-REM`,
            shop_id: shopId,
            customer_phone: `+25470041${String(i).padStart(4, "0")}`,
            items: rem.updatedItems
          }));
          assert.equal(v2.decision, "APPROVED");
          await guard.commitOrder(`${orderId}-REM`);
          outcomes.insufficient_stock_remedied_to_available += 1;
        } else {
          assert.equal(v1.code, "SOLD_OUT");
          const rem = applyRemedy(v1, items);
          assert.equal(rem.action, "REMOVED_SOLD_OUT");
          assert.equal(rem.canRetryImmediately, false);
          remediesApplied.REMOVED_SOLD_OUT += 1;
          outcomes.sold_out_unrecoverable_single_item += 1;
        }
      } else if (i < 295) {
        // 50 buyers ordering 5 units on surebet cap=3 -> TRIMMED_SUREBET (assigned=3) + client syncs qty
        const sIdx = i - 245;
        const orderId = `S4-SURE-${sIdx}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470042${String(sIdx).padStart(4, "0")}`,
          items: [{ id: `sku-sure-${sIdx}`, qty: 5, unit_price: 600 }]
        }));
        assert.equal(v.decision, "TRIMMED_SUREBET");
        assert.equal(v.code, "PARTIAL_SUREBET_ASSIGNED");
        assert.equal(v.items[0].qty, 3);
        const rem = applyRemedy(v, [{ id: `sku-sure-${sIdx}`, qty: 5, unit_price: 600 }]);
        assert.equal(rem.action, "SYNCED_SUREBET");
        remediesApplied.SYNCED_SUREBET += 1;
        await guard.commitOrder(orderId);
        outcomes.surebet_trimmed_and_committed += 1;
      } else if (i < 400) {
        // 105 single-item buyers hit OOS before restock -> queued for restock alert
        const items = [{ id: "sku-hot", qty: 1, unit_price: 3500 }];
        const v = await guard.inspectAndReserve(seal({
          order_id: `S4-OOS-${i}`,
          shop_id: shopId,
          customer_phone: `+25470043${String(i).padStart(4, "0")}`,
          items
        }));
        assert.equal(v.code, "SOLD_OUT");
        const rem = applyRemedy(v, items);
        assert.equal(rem.action, "REMOVED_SOLD_OUT");
        assert.equal(rem.canRetryImmediately, false);
        remediesApplied.REMOVED_SOLD_OUT += 1;
        outcomes.sold_out_unrecoverable_single_item += 1;
      } else if (i < 500) {
        // 100 multi-item carts: [sku-hot (OOS), sku-steady (in stock)] -> remedy strips OOS -> commits remaining!
        const items = [
          { id: "sku-hot", qty: 1, unit_price: 3500 },
          { id: "sku-steady", qty: 1, unit_price: 800 }
        ];
        const v1 = await guard.inspectAndReserve(seal({
          order_id: `S4-MIX1-${i}`,
          shop_id: shopId,
          customer_phone: `+25470044${String(i).padStart(4, "0")}`,
          items
        }));
        assert.equal(v1.code, "SOLD_OUT");
        const rem = applyRemedy(v1, items);
        assert.equal(rem.action, "REMOVED_SOLD_OUT");
        assert.equal(rem.canRetryImmediately, true);
        assert.equal(rem.updatedItems.length, 1);
        remediesApplied.REMOVED_SOLD_OUT += 1;

        const v2 = await guard.inspectAndReserve(seal({
          order_id: `S4-MIX2-${i}`,
          shop_id: shopId,
          customer_phone: `+25470044${String(i).padStart(4, "0")}`,
          items: rem.updatedItems
        }));
        assert.equal(v2.decision, "APPROVED");
        await guard.commitOrder(`S4-MIX2-${i}`);
        outcomes.multi_item_oos_removed_and_committed += 1;
      } else {
        if (i === 500) {
          // LIVE RESTOCK EVENT: +500 units added mid-day!
          await guard.configureItemPolicy(shopId, "sku-hot", { daily_cap: 700 });
        }
        const orderId = `S4-RESTOCK-${i}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470045${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-hot", qty: 1, unit_price: 3500 }]
        }));
        assert.equal(v.decision, "APPROVED");
        await guard.commitOrder(orderId);
        outcomes.post_restock_recovered_and_committed += 1;
      }
      latMs.push(performance.now() - r0);
    }
    const wallMs = performance.now() - t0;

    const summary = await guard.getDailyStockSummary(shopId);
    const hotPool = summary.items.find((x) => x.item_id === "sku-hot");
    const steadyPool = summary.items.find((x) => x.item_id === "sku-steady");
    assert.equal(hotPool.sold, 700);
    assert.equal(hotPool.held, 0);
    assert.equal(steadyPool.sold, 100);

    logSampleReport({
      sample: "S4_OOS_AND_LIVE_RESTOCK_RECOVERY",
      requests: 1000,
      outcomes,
      remedies_applied: remediesApplied,
      inventory_check: {
        sku_hot: { initial_cap: 200, restocked_cap: 700, sold: hotPool.sold, held: hotPool.held, oversold: hotPool.sold > 700 },
        sku_steady: { daily_cap: 1000, sold: steadyPool.sold, held: steadyPool.held, oversold: steadyPool.sold > 1000 }
      },
      latency_ms: summarizeLatencies(latMs, wallMs, 1000)
    });
  });

  it("Sample 5/7 (1,000 reqs): Invalid Carts, Unable-to-Add Constraints, Approval Gates & Self-Healing Remedies", async () => {
    const nowRef = { ms: Date.UTC(2026, 10, 14, 13, 0, 0) };
    const guard = createGuard(nowRef);
    const shopId = "shop-tms-s5";

    await guard.configureItemPolicy(shopId, "sku-gated", {
      name: "Wholesale Essential Pack",
      daily_cap: 5000,
      min_qty: 2,
      step_qty: 2,
      max_per_order: 6,
      max_per_customer_per_day: 8,
      unit_price: 400
    });
    await guard.configureItemPolicy(shopId, "sku-unpriced", {
      name: "Custom Commission Print",
      daily_cap: 500
    });
    await guard.configureItemPolicy(shopId, "sku-luxury", {
      name: "Collector Leather Trunk",
      daily_cap: 500,
      unit_price: 25000
    });

    const latMs = [];
    const outcomes = {
      rejected_empty_order: 0,
      rejected_invalid_quantity: 0,
      rejected_invalid_price: 0,
      remedied_below_min_qty_committed: 0,
      remedied_invalid_step_qty_committed: 0,
      remedied_max_per_order_committed: 0,
      daily_customer_initial_committed: 0,
      rejected_daily_customer_limit: 0,
      high_value_approved_and_committed: 0,
      high_value_declined_and_released: 0,
      rejected_corrupt_envelope: 0
    };
    const remediesApplied = {
      RAISED_TO_MIN_QTY: 0,
      SNAPPED_TO_STEP_QTY: 0,
      CAPPED_TO_MAX_PER_ORDER: 0
    };

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const r0 = performance.now();
      if (i < 150) {
        const v = await guard.inspectAndReserve(seal({
          order_id: `S5-EMP-${i}`,
          shop_id: shopId,
          customer_phone: `+25470050${String(i).padStart(4, "0")}`,
          items: []
        }));
        assert.equal(v.code, "EMPTY_ORDER");
        outcomes.rejected_empty_order += 1;
      } else if (i < 300) {
        const badQtys = [0, -2, 1.5];
        const v = await guard.inspectAndReserve(seal({
          order_id: `S5-QTY-${i}`,
          shop_id: shopId,
          customer_phone: `+25470051${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-gated", qty: badQtys[i % 3], unit_price: 400 }]
        }));
        assert.equal(v.code, "INVALID_QUANTITY");
        outcomes.rejected_invalid_quantity += 1;
      } else if (i < 400) {
        const badPrices = [-100, Number.NaN];
        const v = await guard.inspectAndReserve(seal({
          order_id: `S5-PRC-${i}`,
          shop_id: shopId,
          customer_phone: `+25470052${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-unpriced", qty: 1, unit_price: badPrices[i % 2] }]
        }));
        assert.equal(v.code, "INVALID_PRICE");
        outcomes.rejected_invalid_price += 1;
      } else if (i < 500) {
        const items = [{ id: "sku-gated", qty: 1, unit_price: 400 }];
        const v1 = await guard.inspectAndReserve(seal({
          order_id: `S5-MIN1-${i}`,
          shop_id: shopId,
          customer_phone: `+25470053${String(i).padStart(4, "0")}`,
          items
        }));
        assert.equal(v1.code, "BELOW_MIN_QTY");
        const rem = applyRemedy(v1, items);
        assert.equal(rem.action, "RAISED_TO_MIN_QTY");
        remediesApplied.RAISED_TO_MIN_QTY += 1;
        const v2 = await guard.inspectAndReserve(seal({
          order_id: `S5-MIN2-${i}`,
          shop_id: shopId,
          customer_phone: `+25470053${String(i).padStart(4, "0")}`,
          items: rem.updatedItems
        }));
        assert.equal(v2.decision, "APPROVED");
        await guard.commitOrder(`S5-MIN2-${i}`);
        outcomes.remedied_below_min_qty_committed += 1;
      } else if (i < 600) {
        const items = [{ id: "sku-gated", qty: 3, unit_price: 400 }];
        const v1 = await guard.inspectAndReserve(seal({
          order_id: `S5-STP1-${i}`,
          shop_id: shopId,
          customer_phone: `+25470054${String(i).padStart(4, "0")}`,
          items
        }));
        assert.equal(v1.code, "INVALID_STEP_QTY");
        const rem = applyRemedy(v1, items);
        assert.equal(rem.action, "SNAPPED_TO_STEP_QTY");
        remediesApplied.SNAPPED_TO_STEP_QTY += 1;
        const v2 = await guard.inspectAndReserve(seal({
          order_id: `S5-STP2-${i}`,
          shop_id: shopId,
          customer_phone: `+25470054${String(i).padStart(4, "0")}`,
          items: rem.updatedItems
        }));
        assert.equal(v2.decision, "APPROVED");
        await guard.commitOrder(`S5-STP2-${i}`);
        outcomes.remedied_invalid_step_qty_committed += 1;
      } else if (i < 750) {
        const items = [{ id: "sku-gated", qty: 10, unit_price: 400 }];
        const v1 = await guard.inspectAndReserve(seal({
          order_id: `S5-MAX1-${i}`,
          shop_id: shopId,
          customer_phone: `+25470055${String(i).padStart(4, "0")}`,
          items
        }));
        assert.equal(v1.code, "MAX_PER_ORDER_EXCEEDED");
        const rem = applyRemedy(v1, items);
        assert.equal(rem.action, "CAPPED_TO_MAX_PER_ORDER");
        remediesApplied.CAPPED_TO_MAX_PER_ORDER += 1;
        const v2 = await guard.inspectAndReserve(seal({
          order_id: `S5-MAX2-${i}`,
          shop_id: shopId,
          customer_phone: `+25470055${String(i).padStart(4, "0")}`,
          items: rem.updatedItems
        }));
        assert.equal(v2.decision, "APPROVED");
        await guard.commitOrder(`S5-MAX2-${i}`);
        outcomes.remedied_max_per_order_committed += 1;
      } else if (i < 850) {
        // 50 customers place qty 6 (valid), then try qty 4 same day (total 10 > daily_limit 8)
        const custIdx = (i - 750) % 50;
        const phone = `+25478856${String(custIdx).padStart(4, "0")}`;
        if (i < 800) {
          const v = await guard.inspectAndReserve(seal({
            order_id: `S5-DAY1-${custIdx}`,
            shop_id: shopId,
            customer_phone: phone,
            items: [{ id: "sku-gated", qty: 6, unit_price: 400 }]
          }));
          assert.equal(v.decision, "APPROVED");
          await guard.commitOrder(`S5-DAY1-${custIdx}`);
          outcomes.daily_customer_initial_committed += 1;
        } else {
          const v = await guard.inspectAndReserve(seal({
            order_id: `S5-DAY2-${custIdx}`,
            shop_id: shopId,
            customer_phone: phone,
            items: [{ id: "sku-gated", qty: 4, unit_price: 400 }]
          }));
          assert.equal(v.code, "DAILY_CUSTOMER_LIMIT_EXCEEDED");
          outcomes.rejected_daily_customer_limit += 1;
        }
      } else if (i < 950) {
        const orderId = `S5-HV-${i - 850}`;
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: `+25470057${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-luxury", qty: 1, unit_price: 25000 }]
        }));
        assert.equal(v.decision, "NEEDS_APPROVAL");
        assert.equal(v.can_show_payment, false);
        const preCommit = await guard.commitOrder(orderId);
        assert.equal(preCommit.code, "APPROVAL_REQUIRED");

        if (i < 920) {
          const ap = await guard.approveHeldOrder(orderId, shopId);
          assert.equal(ap.code, "APPROVED_FOR_PAYMENT");
          const postCommit = await guard.commitOrder(orderId);
          assert.equal(postCommit.code, "COMMITTED");
          outcomes.high_value_approved_and_committed += 1;
        } else {
          const dec = await guard.releaseOrder(orderId, "MANAGER_DECLINED", shopId);
          assert.equal(dec.code, "HOLD_RELEASED");
          outcomes.high_value_declined_and_released += 1;
        }
      } else {
        const env = seal({
          order_id: `S5-TAMPER-${i}`,
          shop_id: shopId,
          customer_phone: `+25470058${String(i).padStart(4, "0")}`,
          items: [{ id: "sku-gated", qty: 2, unit_price: 400 }]
        });
        env.order_sealed = env.order_sealed.slice(0, -6) + "AAAAAA";
        const v = await guard.inspectAndReserve(env);
        assert.equal(v.code, "ENVELOPE_DECRYPT_FAILED");
        outcomes.rejected_corrupt_envelope += 1;
      }
      latMs.push(performance.now() - r0);
    }
    const wallMs = performance.now() - t0;

    const summary = await guard.getDailyStockSummary(shopId);
    const gatedPool = summary.items.find((x) => x.item_id === "sku-gated");
    const luxPool = summary.items.find((x) => x.item_id === "sku-luxury");
    // 100*2 (min) + 100*2 (step) + 150*6 (max) + 50*6 (daily) = 200+200+900+300 = 1600
    assert.equal(gatedPool.sold, 1600);
    assert.equal(gatedPool.held, 0);
    assert.equal(luxPool.sold, 70);
    assert.equal(luxPool.held, 0);

    logSampleReport({
      sample: "S5_INVALID_CART_AND_POLICY_GATES",
      requests: 1000,
      outcomes,
      remedies_applied: remediesApplied,
      inventory_check: {
        sku_gated: { daily_cap: 5000, sold: gatedPool.sold, held: gatedPool.held, oversold: gatedPool.sold > 5000 },
        sku_luxury: { daily_cap: 500, sold: luxPool.sold, held: luxPool.held, oversold: luxPool.sold > 500 }
      },
      latency_ms: summarizeLatencies(latMs, wallMs, 1000)
    });
  });

  it("Sample 6/7 (1,000 reqs): No Internet, Unable-to-Load 5xx Outages, Exponential Backoff & Offline Queue Sync", async () => {
    const nowRef = { ms: Date.UTC(2026, 10, 14, 14, 0, 0) };
    const guard = createGuard(nowRef);
    const shopId = "shop-tms-s6";
    const rng = mulberry32(6000);
    await guard.configureItemPolicy(shopId, "sku-net", {
      name: "Baobab Oil 100ml",
      daily_cap: 1500,
      unit_price: 1100
    });

    const latMs = [];
    const offlineQueue = [];
    const outcomes = {
      online_fast_path_committed: 0,
      recovered_after_1_retry_committed: 0,
      recovered_after_2_retries_committed: 0,
      offline_fail_closed_then_synced_committed: 0,
      non_retryable_fail_fast: 0
    };
    let attemptsTotal = 0;
    let retriesUsedTotal = 0;
    let simulatedBackoffMsTotal = 0;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const r0 = performance.now();
      const orderId = `S6-NET-${i}`;
      const envelope = i >= 900
        ? seal({ order_id: orderId, shop_id: shopId, customer_phone: `+25470060${String(i).padStart(4, "0")}`, items: [] })
        : seal({ order_id: orderId, shop_id: shopId, customer_phone: `+25470060${String(i).padStart(4, "0")}`, items: [{ id: "sku-net", qty: 1, unit_price: 1100 }] });

      const faultMode = i < 300
        ? "HEALTHY"
        : i < 550
          ? "ONE_503_BLIP"
          : i < 750
            ? "TWO_NET_DROPS"
            : i < 900
              ? "OFFLINE_DOWN"
              : "NON_RETRYABLE_400";

      const res = await executeWithBackoff(async (attempt) => {
        attemptsTotal += 1;
        if (faultMode === "ONE_503_BLIP" && attempt === 0) {
          return { httpStatus: 503, body: { error: "Service Unavailable" } };
        }
        if (faultMode === "TWO_NET_DROPS" && attempt < 2) {
          if (attempt === 0) return { httpStatus: 502, body: { error: "Bad Gateway" } };
          throw new TypeError("Failed to fetch (network drop)");
        }
        if (faultMode === "OFFLINE_DOWN") {
          throw new TypeError("ERR_INTERNET_DISCONNECTED");
        }
        const v = await guard.inspectAndReserve(envelope);
        const httpStatus = v.decision === "REJECTED"
          ? (v.code === "EMPTY_ORDER" ? 400 : 409)
          : 200;
        return { httpStatus, body: v };
      }, { maxRetries: 2, baseDelayMs: 60, maxDelayMs: 800, rng });

      retriesUsedTotal += res.retriesUsed;
      simulatedBackoffMsTotal += res.simulatedBackoffMs;

      if (i < 300) {
        assert.equal(res.ok, true);
        assert.equal(res.retriesUsed, 0);
        await guard.commitOrder(orderId);
        outcomes.online_fast_path_committed += 1;
      } else if (i < 550) {
        assert.equal(res.ok, true);
        assert.equal(res.retriesUsed, 1);
        await guard.commitOrder(orderId);
        outcomes.recovered_after_1_retry_committed += 1;
      } else if (i < 750) {
        assert.equal(res.ok, true);
        assert.equal(res.retriesUsed, 2);
        await guard.commitOrder(orderId);
        outcomes.recovered_after_2_retries_committed += 1;
      } else if (i < 900) {
        assert.equal(res.ok, false);
        assert.equal(res.verdict.code, "GATEWAY_UNREACHABLE");
        assert.equal(res.verdict.can_show_payment, false);
        assert.equal(res.retriesUsed, 2);
        // Queued offline (`queueOrder`) and synced cleanly once `online` event restores network!
        offlineQueue.push({ orderId, envelope });
      } else {
        assert.equal(res.ok, false);
        assert.equal(res.httpStatus, 400);
        assert.equal(res.retriesUsed, 0);
        assert.equal(res.verdict.code, "EMPTY_ORDER");
        outcomes.non_retryable_fail_fast += 1;
      }
      latMs.push(performance.now() - r0);
    }

    // Connectivity returns (`online` event triggers offline queue sync!)
    assert.equal(offlineQueue.length, 150);
    for (const queued of offlineQueue) {
      const r0 = performance.now();
      const v = await guard.inspectAndReserve(queued.envelope);
      assert.equal(v.decision, "APPROVED");
      const c = await guard.commitOrder(queued.orderId);
      assert.equal(c.code, "COMMITTED");
      outcomes.offline_fail_closed_then_synced_committed += 1;
      latMs.push(performance.now() - r0);
    }
    const wallMs = performance.now() - t0;

    const summary = await guard.getDailyStockSummary(shopId);
    const pool = summary.items.find((x) => x.item_id === "sku-net");
    assert.equal(pool.sold, 900);
    assert.equal(pool.held, 0);

    logSampleReport({
      sample: "S6_NETWORK_OUTAGE_AND_BACKOFF_RETRY",
      requests: 1000,
      outcomes,
      retries: {
        attempts_total: attemptsTotal,
        retries_used: retriesUsedTotal,
        recovered_after_retry: outcomes.recovered_after_1_retry_committed + outcomes.recovered_after_2_retries_committed,
        exhausted_to_offline_queue: offlineQueue.length,
        offline_queue_synced: outcomes.offline_fail_closed_then_synced_committed,
        simulated_backoff_ms_total: simulatedBackoffMsTotal,
        simulated_backoff_ms_avg_per_retry: Number((simulatedBackoffMsTotal / retriesUsedTotal).toFixed(2))
      },
      inventory_check: { daily_cap: 1500, sold: pool.sold, held: pool.held, oversold: pool.sold > 1500 },
      latency_ms: summarizeLatencies(latMs, wallMs, 1000)
    });
  });

  it("Sample 7/7 (1,000 reqs): Mixed Chaotic Production Simulation (Concurrent Flows + Mid-Day Restock + Global Invariants)", async () => {
    const nowRef = { ms: Date.UTC(2026, 10, 14, 15, 0, 0) };
    const guard = createGuard(nowRef);
    const shopId = "shop-tms-s7";
    const rng = mulberry32(20261114);

    const skus = [
      { id: "s7-bag", name: "Artisan Woven Bag", cap: 180, restockTo: 480, price: 2400, maxPerOrder: 5, fill: "strict" },
      { id: "s7-soap", name: "Eucalyptus Soap Bar", cap: 85, restockTo: 385, price: 650, maxPerOrder: 6, fill: "surebet" },
      { id: "s7-honey", name: "Wildflower Honey 500g", cap: 200, restockTo: 500, price: 1450, maxPerOrder: 4, fill: "strict" },
      { id: "s7-coffee", name: "Kenyan AA Whole Bean", cap: 250, restockTo: 550, price: 1800, maxPerOrder: 5, fill: "strict" }
    ];
    for (const s of skus) {
      await guard.configureItemPolicy(shopId, s.id, {
        name: s.name,
        daily_cap: s.cap,
        max_per_order: s.maxPerOrder,
        partial_fill_mode: s.fill,
        unit_price: s.price
      });
    }

    const latMs = [];
    const activeHolds = [];
    const outcomes = {
      committed_clean: 0,
      committed_after_backoff_retry: 0,
      committed_after_remedy: 0,
      surebet_trimmed_and_committed: 0,
      resumed_restarted_session_committed: 0,
      manager_approved_committed: 0,
      manager_declined_released: 0,
      abandoned_ttl_expired: 0,
      rejected_sold_out: 0,
      rejected_invalid_input: 0,
      queued_offline_synced: 0
    };
    let restocked = false;
    let retriesUsedTotal = 0;
    let simulatedBackoffMsTotal = 0;

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const r0 = performance.now();
      nowRef.ms += 1200;
      if (i > 0 && i % 150 === 0) {
        // Periodic sweep check
        await guard.sweepExpiredHolds();
      }
      if (i === 600 && !restocked) {
        for (const s of skus) {
          await guard.configureItemPolicy(shopId, s.id, { daily_cap: s.restockTo });
        }
        restocked = true;
      }

      const roll = rng();
      const sku = skus[i % skus.length];
      const phone = `+2547${String(10000000 + i)}`;
      const orderId = `S7-ORD-${i}`;

      if (roll < 0.45) {
        // Healthy standard flow
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: phone,
          items: [{ id: sku.id, qty: 1, unit_price: sku.price }]
        }));
        if (v.decision === "APPROVED") {
          await guard.commitOrder(orderId);
          outcomes.committed_clean += 1;
        } else if (v.code === "SOLD_OUT") {
          outcomes.rejected_sold_out += 1;
        }
      } else if (roll < 0.60) {
        // Network jitter with exponential backoff recovery (occasionally sustained outage queued offline)
        const severe = rng() < 0.25;
        const env = seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: phone,
          items: [{ id: sku.id, qty: 1, unit_price: sku.price }]
        });
        const res = await executeWithBackoff(async (attempt) => {
          if (severe) throw new TypeError("ETIMEDOUT");
          if (attempt === 0) return { httpStatus: 503, body: { error: "503" } };
          const v = await guard.inspectAndReserve(env);
          return { httpStatus: v.decision === "REJECTED" ? 409 : 200, body: v };
        }, { maxRetries: 2, baseDelayMs: 60, maxDelayMs: 800, rng });
        retriesUsedTotal += res.retriesUsed;
        simulatedBackoffMsTotal += res.simulatedBackoffMs;
        if (!res.ok && res.verdict.code === "GATEWAY_UNREACHABLE") {
          const syncV = await guard.inspectAndReserve(env);
          if (syncV.decision === "APPROVED") {
            await guard.commitOrder(orderId);
            outcomes.queued_offline_synced += 1;
          } else {
            outcomes.rejected_sold_out += 1;
          }
        } else if (res.verdict.decision === "APPROVED") {
          await guard.commitOrder(orderId);
          outcomes.committed_after_backoff_retry += 1;
        } else {
          outcomes.rejected_sold_out += 1;
        }
      } else if (roll < 0.72) {
        // Premature abandonment -> hold expires after 13m TTL
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: phone,
          items: [{ id: sku.id, qty: 1, unit_price: sku.price }]
        }));
        if (v.decision === "APPROVED") {
          activeHolds.push(orderId);
          outcomes.abandoned_ttl_expired += 1;
        } else {
          outcomes.rejected_sold_out += 1;
        }
      } else if (roll < 0.82) {
        // Restarted session: reserve, re-inspect with same order_id (`HOLD_ALREADY_ACTIVE`), then commit
        const env = seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: phone,
          items: [{ id: sku.id, qty: 1, unit_price: sku.price }]
        });
        const v1 = await guard.inspectAndReserve(env);
        if (v1.decision === "APPROVED") {
          const v2 = await guard.inspectAndReserve(env);
          assert.equal(v2.code, "HOLD_ALREADY_ACTIVE");
          await guard.commitOrder(orderId);
          outcomes.resumed_restarted_session_committed += 1;
        } else {
          outcomes.rejected_sold_out += 1;
        }
      } else if (roll < 0.90) {
        // Scarcity / big qty / surebet / remedy
        const reqQty = sku.fill === "surebet" ? sku.maxPerOrder : sku.maxPerOrder + 2;
        const items = [{ id: sku.id, qty: reqQty, unit_price: sku.price }];
        const v1 = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: phone,
          items
        }));
        if (v1.decision === "TRIMMED_SUREBET") {
          await guard.commitOrder(orderId);
          outcomes.surebet_trimmed_and_committed += 1;
        } else if (v1.decision === "APPROVED") {
          await guard.commitOrder(orderId);
          outcomes.committed_clean += 1;
        } else {
          const rem = applyRemedy(v1, items);
          if (rem.remedied && rem.canRetryImmediately) {
            const v2 = await guard.inspectAndReserve(seal({
              order_id: `${orderId}-REM`,
              shop_id: shopId,
              customer_phone: phone,
              items: rem.updatedItems
            }));
            if (v2.decision === "APPROVED" || v2.decision === "TRIMMED_SUREBET") {
              await guard.commitOrder(`${orderId}-REM`);
              outcomes.committed_after_remedy += 1;
            } else {
              outcomes.rejected_sold_out += 1;
            }
          } else {
            outcomes.rejected_sold_out += 1;
          }
        }
      } else if (roll < 0.95) {
        // Invalid input (empty or 0 qty)
        const badItems = rng() < 0.5 ? [] : [{ id: sku.id, qty: 0, unit_price: sku.price }];
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: phone,
          items: badItems
        }));
        assert.equal(v.decision, "REJECTED");
        outcomes.rejected_invalid_input += 1;
      } else {
        // High-value order (>20,000 KES) requiring WhatsApp manager approval
        const qty = sku.maxPerOrder;
        await guard.configureItemPolicy(shopId, sku.id, { max_per_order: 50 }); // temp allow HV qty
        const hvQty = Math.ceil(21000 / sku.price);
        const v = await guard.inspectAndReserve(seal({
          order_id: orderId,
          shop_id: shopId,
          customer_phone: phone,
          items: [{ id: sku.id, qty: hvQty, unit_price: sku.price }]
        }));
        await guard.configureItemPolicy(shopId, sku.id, { max_per_order: sku.maxPerOrder });
        if (v.decision === "NEEDS_APPROVAL") {
          if (rng() < 0.7) {
            await guard.approveHeldOrder(orderId, shopId);
            await guard.commitOrder(orderId);
            outcomes.manager_approved_committed += 1;
          } else {
            await guard.releaseOrder(orderId, "MANAGER_DECLINED", shopId);
            outcomes.manager_declined_released += 1;
          }
        } else if (v.decision === "APPROVED") {
          await guard.commitOrder(orderId);
          outcomes.committed_clean += 1;
        } else {
          outcomes.rejected_sold_out += 1;
        }
      }
      latMs.push(performance.now() - r0);
    }
    const wallMs = performance.now() - t0;

    // Advance past all active TTLs and confirm zero held stock and zero oversell across ALL SKUs
    nowRef.ms += 20 * 60 * 1000;
    await guard.sweepExpiredHolds();
    const summary = await guard.getDailyStockSummary(shopId);

    const totalAccounted = Object.values(outcomes).reduce((acc, n) => acc + n, 0);
    assert.equal(totalAccounted, 1000);

    const inventoryBySku = {};
    for (const s of skus) {
      const p = summary.items.find((x) => x.item_id === s.id);
      assert.equal(p.held, 0, `${s.id} leaked held stock after TTL sweep!`);
      assert.ok(p.sold <= s.restockTo, `${s.id} oversold: ${p.sold} > ${s.restockTo}`);
      inventoryBySku[s.id] = { cap: s.restockTo, sold: p.sold, held: p.held, available: p.available, oversold: false };
    }

    logSampleReport({
      sample: "S7_MIXED_CHAOS_PRODUCTION_SIMULATION",
      requests: 1000,
      total_accounted: totalAccounted,
      outcomes,
      retries: {
        retries_used: retriesUsedTotal,
        simulated_backoff_ms_total: simulatedBackoffMsTotal
      },
      inventory_check: inventoryBySku,
      latency_ms: summarizeLatencies(latMs, wallMs, 1000)
    });
  });
});

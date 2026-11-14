import test from "node:test";
import assert from "node:assert/strict";
import { OrderGuard, getEatDateString } from "./order_guard.mjs";
import {
  sealCheckoutEnvelope,
  unsealWithKey,
  decryptInspectablePart
} from "./blind_checkout_crypto.mjs";

const PII_KEY = "super-secret-pii-key-not-given-to-inspector";
const INSPECTOR_KEY = "order-guard-inspector-key-only";
const HMAC_SECRET = "order-guard-hmac-secret";

function createTestGuard(nowRef = { ms: Date.UTC(2026, 10, 14, 7, 0, 0) }) {
  return new OrderGuard({
    inspectorKey: INSPECTOR_KEY,
    hmacSecret: HMAC_SECRET,
    stateFile: null, // pure in-memory for isolated deterministic tests
    nowFn: () => nowRef.ms,
    holdTtlMs: 10 * 60 * 1000,
    graceTtlMs: 3 * 60 * 1000,
    maxOrderValue: 20000
  });
}

test("1. Cryptographic Blindness: Order Guard decrypts ONLY order items, never PII", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "samosa", { name: "Beef Samosa", daily_cap: 50, max_per_order: 20, unit_price: 80 });

  const envelope = sealCheckoutEnvelope({
    order_id: "ORD-BLIND-1",
    shop_id: "shop-1",
    customer_name: "Alice Wanjiku",
    customer_phone: "0712345678",
    delivery_address: "Kilimani, Nairobi",
    notes: "Gate 4B",
    items: [{ id: "samosa", name: "Beef Samosa", qty: 5, unit_price: 80 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });

  // Order Guard's key MUST NOT be able to decrypt pii_sealed
  assert.throws(() => {
    unsealWithKey(envelope.pii_sealed, INSPECTOR_KEY, "pii");
  });
  assert.throws(() => {
    unsealWithKey(envelope.pii_sealed, INSPECTOR_KEY, "order_guard");
  });

  // Order Guard CAN decrypt order_sealed and process the items
  const inspectable = decryptInspectablePart(envelope, INSPECTOR_KEY);
  assert.equal(inspectable.items[0].id, "samosa");
  assert.equal(inspectable.items[0].qty, 5);
  assert.equal(inspectable.customer_name, undefined);
  assert.equal(inspectable.customer_phone, undefined);

  const verdict = await guard.inspectAndReserve(envelope);
  assert.equal(verdict.decision, "APPROVED");
  assert.equal(verdict.can_show_payment, true);

  // Outer gateway with PII_KEY can still recover PII after approval
  const pii = unsealWithKey(envelope.pii_sealed, PII_KEY, "pii");
  assert.equal(pii.customer_name, "Alice Wanjiku");
  assert.equal(pii.customer_phone, "0712345678");
});

test("2. 1000 concurrent buyers vs 50 samosas -> exactly 50 succeed, 0 oversell", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "samosa", { name: "Samosa", daily_cap: 50, max_per_order: 5, unit_price: 50 });

  const requests = Array.from({ length: 1000 }, (_, idx) => {
    const env = sealCheckoutEnvelope({
      order_id: `ORD-RACE-${idx}`,
      shop_id: "shop-1",
      customer_phone: `0700${String(idx).padStart(6, "0")}`,
      items: [{ id: "samosa", name: "Samosa", qty: 1, unit_price: 50 }]
    }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });
    return guard.inspectAndReserve(env);
  });

  const results = await Promise.all(requests);
  const approved = results.filter(r => r.decision === "APPROVED");
  const rejected = results.filter(r => r.decision === "REJECTED" && r.code === "SOLD_OUT");

  assert.equal(approved.length, 50);
  assert.equal(rejected.length, 950);

  const stock = await guard.getDailyStockSummary("shop-1");
  const samosa = stock.items.find(i => i.item_id === "samosa");
  assert.equal(samosa.held, 50);
  assert.equal(samosa.available, 0);
});

test("3. 1000 packets of unga: rejected for retail, allowed for wholesale tier (bounded by stock)", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "unga", {
    name: "Unga 2kg",
    daily_cap: 1500,
    max_per_order: 10,
    wholesale_max_per_order: 1200,
    unit_price: 180
  });

  // Retail customer asks for 1000 -> rejected
  const retailEnv = sealCheckoutEnvelope({
    order_id: "ORD-UNGA-RETAIL",
    shop_id: "shop-1",
    customer_phone: "0711111111",
    items: [{ id: "unga", name: "Unga 2kg", qty: 1000, unit_price: 180 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });

  const retailVerdict = await guard.inspectAndReserve(retailEnv);
  assert.equal(retailVerdict.decision, "REJECTED");
  assert.equal(retailVerdict.code, "MAX_PER_ORDER_EXCEEDED");
  assert.equal(retailVerdict.can_show_payment, false);

  // Promote customer to wholesale tier -> 1000 unga goes through
  await guard.setCustomerTier("shop-1", "0722222222", "wholesale");
  const wholesaleEnv = sealCheckoutEnvelope({
    order_id: "ORD-UNGA-WHOLESALE",
    shop_id: "shop-1",
    customer_phone: "0722222222",
    items: [{ id: "unga", name: "Unga 2kg", qty: 1000, unit_price: 180 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });

  const wholesaleVerdict = await guard.inspectAndReserve(wholesaleEnv);
  assert.equal(wholesaleVerdict.decision, "APPROVED");
  assert.equal(wholesaleVerdict.items[0].qty, 1000);
});

test("4. 3kg sugar left: strict mode rejects 4kg without locking so 2kg clears; surebet mode auto-assigns 3kg", async () => {
  // 4A. Strict mode: Customer B wants 4kg (rejected), Customer A wants 2kg (cleared!)
  const strictGuard = createTestGuard();
  await strictGuard.configureItemPolicy("shop-1", "sugar", {
    name: "Sugar 1kg",
    daily_cap: 3,
    partial_fill_mode: "strict",
    unit_price: 160
  });

  const reqB = await strictGuard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-SUGAR-B",
    shop_id: "shop-1",
    customer_phone: "0700000002",
    items: [{ id: "sugar", name: "Sugar 1kg", qty: 4, unit_price: 160 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(reqB.decision, "REJECTED");
  assert.equal(reqB.code, "INSUFFICIENT_STOCK");
  assert.equal(reqB.available, 3);

  const reqA = await strictGuard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-SUGAR-A",
    shop_id: "shop-1",
    customer_phone: "0700000001",
    items: [{ id: "sugar", name: "Sugar 1kg", qty: 2, unit_price: 160 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(reqA.decision, "APPROVED");
  assert.equal(reqA.items[0].qty, 2);

  // 4B. Surebet mode: Customer asks for 4kg when 3kg is left -> surebet assigns 3kg
  const surebetGuard = createTestGuard();
  await surebetGuard.configureItemPolicy("shop-1", "sugar", {
    name: "Sugar 1kg",
    daily_cap: 3,
    partial_fill_mode: "surebet",
    unit_price: 160
  });

  const surebetVerdict = await surebetGuard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-SUGAR-SUREBET",
    shop_id: "shop-1",
    customer_phone: "0700000003",
    items: [{ id: "sugar", name: "Sugar 1kg", qty: 4, unit_price: 160 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(surebetVerdict.decision, "TRIMMED_SUREBET");
  assert.equal(surebetVerdict.items[0].qty, 3);
  assert.equal(surebetVerdict.trim_notices[0].requested_qty, 4);
  assert.equal(surebetVerdict.trim_notices[0].assigned_qty, 3);
});

test("5. Expired holds return to buyable pool automatically; midnight EAT replenishes full daily cap", async () => {
  const nowRef = { ms: Date.UTC(2026, 10, 14, 20, 50, 0) }; // 23:50 EAT
  const guard = createTestGuard(nowRef);
  await guard.configureItemPolicy("shop-1", "salt", { name: "Salt", daily_cap: 60, max_per_order: 60, unit_price: 40 });

  // Customer 1 holds all 60 packets at 23:50 EAT, then abandons checkout
  const v1 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-SALT-1",
    shop_id: "shop-1",
    customer_phone: "0700000010",
    items: [{ id: "salt", name: "Salt", qty: 60, unit_price: 40 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(v1.decision, "APPROVED");

  // Advance 14 minutes -> 00:04 EAT next day (midnight rollover + hold expired)
  nowRef.ms += 14 * 60 * 1000;
  assert.equal(getEatDateString(nowRef.ms), "2026-11-15");

  const stockNextDay = await guard.getDailyStockSummary("shop-1");
  const salt = stockNextDay.items.find(i => i.item_id === "salt");
  assert.equal(salt.available, 60);
  assert.equal(salt.held, 0);
  assert.equal(salt.sold, 0);
});

test("6. Late payment after hold expiry: returns REFUND_REQUIRED if stock is gone", async () => {
  const nowRef = { ms: Date.UTC(2026, 10, 14, 10, 0, 0) };
  const guard = createTestGuard(nowRef);
  await guard.configureItemPolicy("shop-1", "cake", { name: "Cake", daily_cap: 2, unit_price: 500 });

  // Buyer 1 holds 2 cakes, never pays within 13 min
  await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-LATE-1",
    shop_id: "shop-1",
    customer_phone: "0700000020",
    items: [{ id: "cake", name: "Cake", qty: 2, unit_price: 500 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  // Advance 15 minutes -> hold expires, Buyer 2 buys and pays for both cakes
  nowRef.ms += 15 * 60 * 1000;
  await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-FAST-2",
    shop_id: "shop-1",
    customer_phone: "0700000021",
    items: [{ id: "cake", name: "Cake", qty: 2, unit_price: 500 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  const commit2 = await guard.commitOrder("ORD-FAST-2");
  assert.equal(commit2.success, true);

  // Now Buyer 1's late payment arrives -> MUST NOT oversell, returns REFUND_REQUIRED
  const lateCommit = await guard.commitOrder("ORD-LATE-1");
  assert.equal(lateCommit.success, false);
  assert.equal(lateCommit.code, "REFUND_REQUIRED");
});

test("7. High-value retail order (> KES 20,000) goes to NEEDS_APPROVAL without showing Till, then !approve-order unlocks", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "item_t", { name: "Item T", daily_cap: 100, max_per_order: 20, unit_price: 5000 });

  const env = sealCheckoutEnvelope({
    order_id: "ORD-BIG-1",
    shop_id: "shop-1",
    customer_phone: "0700000030",
    items: [{ id: "item_t", name: "Item T", qty: 5, unit_price: 5000 }] // KES 25,000 > 20,000
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });

  const verdict = await guard.inspectAndReserve(env);
  assert.equal(verdict.decision, "NEEDS_APPROVAL");
  assert.equal(verdict.can_show_payment, false);

  const approved = await guard.approveHeldOrder("ORD-BIG-1");
  assert.equal(approved.success, true);
  assert.equal(approved.can_show_payment, true);

  const committed = await guard.commitOrder("ORD-BIG-1");
  assert.equal(committed.success, true);
});

test("8. Security: Client-supplied customer_tier & negative/NaN unit_price are rejected", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "unga", { name: "Unga", daily_cap: 500, max_per_order: 10 });

  // Attempt to spoof customer_tier: "wholesale" in request -> ignored, treated as retail
  const spoofEnv = sealCheckoutEnvelope({
    order_id: "ORD-SPOOF-1",
    shop_id: "shop-1",
    customer_phone: "0799000111",
    customer_tier: "wholesale",
    items: [{ id: "unga", name: "Unga", qty: 50, unit_price: 100 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });

  const spoofRes = await guard.inspectAndReserve(spoofEnv);
  assert.equal(spoofRes.decision, "REJECTED");
  assert.equal(spoofRes.code, "MAX_PER_ORDER_EXCEEDED");
  assert.equal(spoofRes.can_show_payment, false);

  // Attempt NaN / negative unit_price
  const badPriceEnv = sealCheckoutEnvelope({
    order_id: "ORD-BADPRICE-1",
    shop_id: "shop-1",
    customer_phone: "0799000112",
    items: [{ id: "unga", name: "Unga", qty: 2, unit_price: -500 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });

  const badPriceRes = await guard.inspectAndReserve(badPriceEnv);
  assert.equal(badPriceRes.decision, "REJECTED");
  assert.equal(badPriceRes.code, "INVALID_PRICE");
  assert.equal(badPriceRes.can_show_payment, false);
});

test("9. Cross-shop isolation & status guard: cannot approve/release another shop or commit DECLINED/NEEDS_APPROVAL", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-A", "item_t", { name: "Item T", daily_cap: 50, unit_price: 5000 });

  const env = sealCheckoutEnvelope({
    order_id: "ORD-SHOP-A-1",
    shop_id: "shop-A",
    customer_phone: "0700000040",
    items: [{ id: "item_t", name: "Item T", qty: 5, unit_price: 5000 }] // NEEDS_APPROVAL
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET });

  const v = await guard.inspectAndReserve(env);
  assert.equal(v.decision, "NEEDS_APPROVAL");

  // Cannot commit before manager approval
  const earlyCommit = await guard.commitOrder("ORD-SHOP-A-1");
  assert.equal(earlyCommit.success, false);
  assert.equal(earlyCommit.code, "APPROVAL_REQUIRED");

  // Shop B cannot approve or decline Shop A's order
  const crossApprove = await guard.approveHeldOrder("ORD-SHOP-A-1", "shop-B");
  assert.equal(crossApprove.success, false);
  assert.equal(crossApprove.code, "SHOP_MISMATCH");

  // Shop A declines -> stock returned, and commitOrder MUST refuse DECLINED
  const declined = await guard.releaseOrder("ORD-SHOP-A-1", "DECLINED", "shop-A");
  assert.equal(declined.success, true);

  const commitDeclined = await guard.commitOrder("ORD-SHOP-A-1");
  assert.equal(commitDeclined.success, false);
  assert.equal(commitDeclined.code, "HOLD_NOT_RECOVERABLE");
});

test("10. Phone canonicalization: 0712..., +254712..., 254712... share the same daily limit & tier", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "sugar", {
    name: "Sugar 1kg",
    daily_cap: 100,
    max_per_customer_per_day: 3,
    unit_price: 160
  });

  const v1 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-PH-1",
    shop_id: "shop-1",
    customer_phone: "0712345678",
    items: [{ id: "sugar", name: "Sugar 1kg", qty: 2, unit_price: 160 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(v1.decision, "APPROVED");

  // Same phone formatted as +254 712-345-678 asking for 2 more (2+2=4 > 3/day) -> REJECTED!
  const v2 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-PH-2",
    shop_id: "shop-1",
    customer_phone: "+254 712-345-678",
    items: [{ id: "sugar", name: "Sugar 1kg", qty: 2, unit_price: 160 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(v2.decision, "REJECTED");
  assert.equal(v2.code, "DAILY_CUSTOMER_LIMIT_EXCEEDED");
  assert.equal(v2.can_show_payment, false);
});

test("11. Multi-item X + Y (Y sold out): rejects with exact item, locks 0 of X, and immediate retry with X clears", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "item_x", { name: "Item X", daily_cap: 10, unit_price: 100 });
  await guard.configureItemPolicy("shop-1", "item_y", { name: "Item Y", daily_cap: 0, unit_price: 200 });

  // Order X (available) + Y (sold out)
  const rejected = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-XY-1",
    shop_id: "shop-1",
    customer_phone: "0712000999",
    items: [
      { id: "item_x", name: "Item X", qty: 3, unit_price: 100 },
      { id: "item_y", name: "Item Y", qty: 1, unit_price: 200 }
    ]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(rejected.decision, "REJECTED");
  assert.equal(rejected.code, "SOLD_OUT");
  assert.equal(rejected.item, "item_y");
  assert.equal(rejected.available, 0);
  assert.equal(rejected.can_show_payment, false);

  // Confirm Item X was NOT locked (all-or-nothing)
  const poolAfterReject = await guard.getDailyStockSummary("shop-1");
  const itemX = poolAfterReject.items.find(i => i.item_id === "item_x");
  assert.equal(itemX.held, 0);
  assert.equal(itemX.available, 10);

  // Customer is NOT blocked: removes Y and retries with X -> clears immediately
  const retried = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-X-ONLY",
    shop_id: "shop-1",
    customer_phone: "0712000999",
    items: [{ id: "item_x", name: "Item X", qty: 3, unit_price: 100 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(retried.decision, "APPROVED");
  assert.equal(retried.can_show_payment, true);
  assert.equal(retried.items[0].id, "item_x");
  assert.equal(retried.items[0].qty, 3);
});

test("12. MUST FAIL: Zero, negative, fractional, or NaN quantities never pass", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "clips", { name: "Hair Clips", daily_cap: 50, unit_price: 150 });

  for (const badQty of [0, -1, -50, 1.5, NaN]) {
    const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
      order_id: `ORD-BADQTY-${String(badQty)}`,
      shop_id: "shop-1",
      customer_phone: "0712111000",
      items: [{ id: "clips", name: "Hair Clips", qty: badQty, unit_price: 150 }]
    }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

    assert.equal(res.decision, "REJECTED");
    assert.equal(res.code, "INVALID_QUANTITY");
    assert.equal(res.can_show_payment, false);
  }
});

test("13. MUST FAIL: Empty items array never passes", async () => {
  const guard = createTestGuard();
  const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-EMPTY-1",
    shop_id: "shop-1",
    customer_phone: "0712111001",
    items: []
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(res.decision, "REJECTED");
  assert.equal(res.code, "EMPTY_ORDER");
  assert.equal(res.can_show_payment, false);
});

test("14. MUST FAIL: Tampered ciphertext or wrong inspector key never passes", async () => {
  const guard = createTestGuard();
  const env = sealCheckoutEnvelope({
    order_id: "ORD-TAMPER-1",
    shop_id: "shop-1",
    customer_phone: "0712111002",
    items: [{ id: "clips", name: "Hair Clips", qty: 1, unit_price: 150 }]
  }, { piiKey: PII_KEY, inspectorKey: "wrong-key", hmacSecret: HMAC_SECRET });

  const res = await guard.inspectAndReserve(env);
  assert.equal(res.decision, "REJECTED");
  assert.equal(res.code, "ENVELOPE_DECRYPT_FAILED");
  assert.equal(res.can_show_payment, false);
});

test("15. MUST FAIL: Quantity below min_qty never passes", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "pins", { name: "Safety Pins", daily_cap: 80, min_qty: 3, unit_price: 100 });

  const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-MIN-1",
    shop_id: "shop-1",
    customer_phone: "0712111003",
    items: [{ id: "pins", name: "Safety Pins", qty: 2, unit_price: 100 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(res.decision, "REJECTED");
  assert.equal(res.code, "BELOW_MIN_QTY");
  assert.equal(res.can_show_payment, false);
});

test("16. MUST FAIL / PASS: step_qty rejects non-multiples and passes exact multiples", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "pins", { name: "Safety Pins", daily_cap: 60, min_qty: 6, step_qty: 6, unit_price: 100 });

  const failRes = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-STEP-FAIL",
    shop_id: "shop-1",
    customer_phone: "0712111004",
    items: [{ id: "pins", name: "Safety Pins", qty: 7, unit_price: 100 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(failRes.decision, "REJECTED");
  assert.equal(failRes.code, "INVALID_STEP_QTY");
  assert.equal(failRes.can_show_payment, false);

  const passRes = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-STEP-PASS",
    shop_id: "shop-1",
    customer_phone: "0712111004",
    items: [{ id: "pins", name: "Safety Pins", qty: 12, unit_price: 100 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(passRes.decision, "APPROVED");
  assert.equal(passRes.can_show_payment, true);
});

test("17. MUST FAIL: Duplicate item lines in same cart cannot bypass max_per_order", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "bonnet", { name: "Satin Bonnet", daily_cap: 30, max_per_order: 5, unit_price: 550 });

  const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-DUP-1",
    shop_id: "shop-1",
    customer_phone: "0712111005",
    items: [
      { id: "bonnet", name: "Satin Bonnet", qty: 3, unit_price: 550 },
      { id: "bonnet", name: "Satin Bonnet", qty: 3, unit_price: 550 }
    ]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(res.decision, "REJECTED");
  assert.equal(res.code, "MAX_PER_ORDER_EXCEEDED");
  assert.equal(res.requested_qty, 6);
  assert.equal(res.can_show_payment, false);
});

test("18. MUST FAIL: Item with daily_cap = 0 is always SOLD_OUT", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "cap0", { name: "Zero Cap Item", daily_cap: 0, unit_price: 100 });

  const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-CAP0-1",
    shop_id: "shop-1",
    customer_phone: "0712111006",
    items: [{ id: "cap0", name: "Zero Cap Item", qty: 1, unit_price: 100 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(res.decision, "REJECTED");
  assert.equal(res.code, "SOLD_OUT");
  assert.equal(res.can_show_payment, false);
});

test("19. MUST FAIL: NaN or Infinity unit_price tampering is rejected", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "clips", { name: "Hair Clips", daily_cap: 50 });

  for (const badPrice of ["not-a-number", Infinity, -0.01]) {
    const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
      order_id: `ORD-NANPRICE-${String(badPrice)}`,
      shop_id: "shop-1",
      customer_phone: "0712111007",
      items: [{ id: "clips", name: "Hair Clips", qty: 1, unit_price: badPrice }]
    }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

    assert.equal(res.decision, "REJECTED");
    assert.equal(res.code, "INVALID_PRICE");
    assert.equal(res.can_show_payment, false);
  }
});

test("20. MUST FAIL: Reusing an active order_id from another shop or customer is rejected", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-A", "clips", { name: "Hair Clips", daily_cap: 50, unit_price: 150 });
  await guard.configureItemPolicy("shop-B", "clips", { name: "Hair Clips", daily_cap: 50, unit_price: 150 });

  const first = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-SHARED-ID",
    shop_id: "shop-A",
    customer_phone: "0712111008",
    items: [{ id: "clips", name: "Hair Clips", qty: 1, unit_price: 150 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(first.decision, "APPROVED");

  const hijack = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-SHARED-ID",
    shop_id: "shop-B",
    customer_phone: "0712111999",
    items: [{ id: "clips", name: "Hair Clips", qty: 1, unit_price: 150 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(hijack.decision, "REJECTED");
  assert.equal(hijack.code, "ORDER_ID_CONFLICT");
  assert.equal(hijack.can_show_payment, false);
});

test("21. MUST FAIL TO AUTO-CLEAR: Flagged customer always requires manager approval (no Till shown)", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "pins", { name: "Safety Pins", daily_cap: 50, unit_price: 100 });
  await guard.setCustomerTier("shop-1", "0712111009", "flagged");

  const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-FLAGGED-1",
    shop_id: "shop-1",
    customer_phone: "0712111009",
    items: [{ id: "pins", name: "Safety Pins", qty: 1, unit_price: 100 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(res.decision, "NEEDS_APPROVAL");
  assert.equal(res.code, "FLAGGED_CUSTOMER_APPROVAL");
  assert.equal(res.can_show_payment, false);
});

test("22. MUST FAIL: Invalid policy values and invalid customer tiers throw errors", async () => {
  const guard = createTestGuard();
  await assert.rejects(() => guard.configureItemPolicy("shop-1", "x", { daily_cap: -5 }));
  await assert.rejects(() => guard.configureItemPolicy("shop-1", "x", { max_per_order: 0 }));
  await assert.rejects(() => guard.setCustomerTier("shop-1", "0712111010", "vip_godmode"));
});

test("23. MUST PASS: Payment within +3 min grace period commits cleanly", async () => {
  const nowRef = { ms: Date.UTC(2026, 10, 14, 10, 0, 0) };
  const guard = createTestGuard(nowRef);
  await guard.configureItemPolicy("shop-1", "blender", { name: "Beauty Blender", daily_cap: 10, unit_price: 200 });

  await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-GRACE-1",
    shop_id: "shop-1",
    customer_phone: "0712111011",
    items: [{ id: "blender", name: "Beauty Blender", qty: 2, unit_price: 200 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  // Advance 11 minutes (past 10m TTL, still inside +3m grace window)
  nowRef.ms += 11 * 60 * 1000;
  const commit = await guard.commitOrder("ORD-GRACE-1");
  assert.equal(commit.success, true);
  assert.equal(commit.code, "COMMITTED");
});

test("24. MUST PASS: Late payment after expiry recovers when stock is still available", async () => {
  const nowRef = { ms: Date.UTC(2026, 10, 14, 10, 0, 0) };
  const guard = createTestGuard(nowRef);
  await guard.configureItemPolicy("shop-1", "spray", { name: "Spray Bottle", daily_cap: 10, unit_price: 300 });

  await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-LATE-OK",
    shop_id: "shop-1",
    customer_phone: "0712111012",
    items: [{ id: "spray", name: "Spray Bottle", qty: 2, unit_price: 300 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  // Advance 15 minutes (hold expires, but 10 are still available in pool)
  nowRef.ms += 15 * 60 * 1000;
  const commit = await guard.commitOrder("ORD-LATE-OK");
  assert.equal(commit.success, true);
  assert.equal(commit.code, "LATE_PAYMENT_RECOVERED");
});

test("25. MUST PASS / FAIL: Releasing a hold frees stock immediately; releasing a committed order fails", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "cap", { name: "Shower Cap", daily_cap: 5, unit_price: 250 });

  await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-REL-1",
    shop_id: "shop-1",
    customer_phone: "0712111013",
    items: [{ id: "cap", name: "Shower Cap", qty: 5, unit_price: 250 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  // Release -> pool back to 5
  const rel = await guard.releaseOrder("ORD-REL-1", "CANCELLED");
  assert.equal(rel.success, true);

  // Next buyer can now buy and commit all 5
  await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-REL-2",
    shop_id: "shop-1",
    customer_phone: "0712111014",
    items: [{ id: "cap", name: "Shower Cap", qty: 5, unit_price: 250 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  await guard.commitOrder("ORD-REL-2");

  // Cannot release an already committed order
  const relCommitted = await guard.releaseOrder("ORD-REL-2", "CANCELLED");
  assert.equal(relCommitted.success, false);
  assert.equal(relCommitted.code, "HOLD_NOT_ACTIVE");
});

test("26. KEby254 Live Shop: Satin Bonnet cap, Eye Pencil surebet, Crochet Hook + Safety Pins checkout", async () => {
  const guard = createTestGuard();
  const KEBY254_ID = "e254e254-0254-4254-8254-000000000254";
  await guard.configureItemPolicy(KEBY254_ID, "keby254-satin-bonnet", {
    name: "Satin Bonnet (Double-Sided)", daily_cap: 30, max_per_order: 5, partial_fill_mode: "strict", unit_price: 550
  });
  await guard.configureItemPolicy(KEBY254_ID, "keby254-eye-pencil", {
    name: "Eye Pencil", daily_cap: 4, max_per_order: 10, partial_fill_mode: "surebet", unit_price: 180
  });
  await guard.configureItemPolicy(KEBY254_ID, "keby254-crochet-hook", {
    name: "Crochet Hook", daily_cap: 45, max_per_order: 10, partial_fill_mode: "strict", unit_price: 220
  });

  // 6 Satin Bonnets > max_per_order (5) -> MUST FAIL
  const overBonnet = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "KE254-TEST-1",
    shop_id: KEBY254_ID,
    customer_phone: "0712345001",
    items: [{ id: "keby254-satin-bonnet", name: "Satin Bonnet (Double-Sided)", qty: 6, unit_price: 550 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(overBonnet.decision, "REJECTED");
  assert.equal(overBonnet.code, "MAX_PER_ORDER_EXCEEDED");
  assert.equal(overBonnet.can_show_payment, false);

  // Valid multi-item KEby254 checkout: 2 Bonnets + 6 Eye Pencils (surebet trims to 4) + 3 Crochet Hooks -> PASSES
  const validCheckout = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "KE254-TEST-2",
    shop_id: KEBY254_ID,
    customer_phone: "0712345001",
    items: [
      { id: "keby254-satin-bonnet", name: "Satin Bonnet (Double-Sided)", qty: 2, unit_price: 550 },
      { id: "keby254-eye-pencil", name: "Eye Pencil", qty: 6, unit_price: 180 },
      { id: "keby254-crochet-hook", name: "Crochet Hook", qty: 3, unit_price: 220 }
    ]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(validCheckout.decision, "TRIMMED_SUREBET");
  assert.equal(validCheckout.can_show_payment, true);
  assert.equal(validCheckout.items.find(i => i.id === "keby254-eye-pencil").qty, 4);
  assert.equal(validCheckout.total_value, 2 * 550 + 4 * 180 + 3 * 220);

  const settled = await guard.commitOrder("KE254-TEST-2");
  assert.equal(settled.success, true);
});

test("27. Exact fulfillment boundary: x=4 available rejects 4+k (k=1,2,3,6) with 0 locked, then retry with 4 succeeds", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "serum", {
    name: "Hair Serum",
    daily_cap: 4,
    max_per_order: 20,
    partial_fill_mode: "strict",
    unit_price: 450
  });

  for (const k of [1, 2, 3, 6]) {
    const res = await guard.inspectAndReserve(sealCheckoutEnvelope({
      order_id: `ORD-BOUND-${k}`,
      shop_id: "shop-1",
      customer_phone: "0712000401",
      items: [{ id: "serum", name: "Hair Serum", qty: 4 + k, unit_price: 450 }]
    }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

    assert.equal(res.decision, "REJECTED");
    assert.equal(res.code, "INSUFFICIENT_STOCK");
    assert.equal(res.can_show_payment, false);
    assert.equal(res.available, 4);
    assert.equal(res.requested_qty, 4 + k);
  }

  // Confirm 0 locked after rejections
  const summary = await guard.getDailyStockSummary("shop-1");
  const item = summary.items.find(i => i.item_id === "serum");
  assert.equal(item.held, 0);
  assert.equal(item.available, 4);

  // Immediate retry with exact available quantity 4 -> APPROVED
  const approved = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-BOUND-EXACT",
    shop_id: "shop-1",
    customer_phone: "0712000401",
    items: [{ id: "serum", name: "Hair Serum", qty: 4, unit_price: 450 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));

  assert.equal(approved.decision, "APPROVED");
  assert.equal(approved.can_show_payment, true);
  assert.equal(approved.items[0].qty, 4);
});

test("28. Anti-hoarding: ordinary order amounts enforced (max_per_order=3, max_per_customer_per_day=5)", async () => {
  const guard = createTestGuard();
  await guard.configureItemPolicy("shop-1", "clips", {
    name: "Hair Clips",
    daily_cap: 40,
    max_per_order: 3,
    max_per_customer_per_day: 5,
    unit_price: 150
  });

  // Single customer trying to hoard all 40 -> MAX_PER_ORDER_EXCEEDED
  const hoardRes = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-HOARD-ALL",
    shop_id: "shop-1",
    customer_phone: "0712000501",
    items: [{ id: "clips", name: "Hair Clips", qty: 40, unit_price: 150 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(hoardRes.decision, "REJECTED");
  assert.equal(hoardRes.code, "MAX_PER_ORDER_EXCEEDED");
  assert.equal(hoardRes.can_show_payment, false);

  // Order 1: 3 units -> APPROVED
  const o1 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-HOARD-1",
    shop_id: "shop-1",
    customer_phone: "0712000501",
    items: [{ id: "clips", name: "Hair Clips", qty: 3, unit_price: 150 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(o1.decision, "APPROVED");
  await guard.commitOrder("ORD-HOARD-1");

  // Order 2: 2 units -> APPROVED (total 5)
  const o2 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-HOARD-2",
    shop_id: "shop-1",
    customer_phone: "0712000501",
    items: [{ id: "clips", name: "Hair Clips", qty: 2, unit_price: 150 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(o2.decision, "APPROVED");
  await guard.commitOrder("ORD-HOARD-2");

  // Order 3: 1 unit -> DAILY_CUSTOMER_LIMIT_EXCEEDED
  const o3 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-HOARD-3",
    shop_id: "shop-1",
    customer_phone: "0712000501",
    items: [{ id: "clips", name: "Hair Clips", qty: 1, unit_price: 150 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(o3.decision, "REJECTED");
  assert.equal(o3.code, "DAILY_CUSTOMER_LIMIT_EXCEEDED");
  assert.equal(o3.can_show_payment, false);

  // 35 items remain for ordinary shoppers
  const summary = await guard.getDailyStockSummary("shop-1");
  const item = summary.items.find(i => i.item_id === "clips");
  assert.equal(item.available, 35);
});

test("29. Fast hold recovery: abandoned cart of full daily_cap=5 expires after 13m+1s TTL+grace", async () => {
  const nowRef = { ms: Date.UTC(2026, 10, 14, 7, 0, 0) };
  const guard = createTestGuard(nowRef);
  await guard.configureItemPolicy("shop-1", "bonnet", {
    name: "Satin Bonnet",
    daily_cap: 5,
    max_per_order: 5,
    unit_price: 550
  });

  // Buyer 1 reserves all 5 and abandons cart
  const hold1 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-ABANDON-1",
    shop_id: "shop-1",
    customer_phone: "0712000601",
    items: [{ id: "bonnet", name: "Satin Bonnet", qty: 5, unit_price: 550 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(hold1.decision, "APPROVED");

  // Advance clock by 13 minutes + 1 second (10m holdTtlMs + 3m graceTtlMs + 1s)
  nowRef.ms += (13 * 60 + 1) * 1000;
  guard.sweepExpiredHolds();

  // Next customer can immediately buy all 5 without waiting 24h
  const hold2 = await guard.inspectAndReserve(sealCheckoutEnvelope({
    order_id: "ORD-RECOVER-2",
    shop_id: "shop-1",
    customer_phone: "0712000602",
    items: [{ id: "bonnet", name: "Satin Bonnet", qty: 5, unit_price: 550 }]
  }, { piiKey: PII_KEY, inspectorKey: INSPECTOR_KEY, hmacSecret: HMAC_SECRET }));
  assert.equal(hold2.decision, "APPROVED");
  assert.equal(hold2.can_show_payment, true);
  assert.equal(hold2.items[0].qty, 5);
});

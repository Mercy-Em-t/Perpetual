/**
 * Order Guard & Blind Checkout Inspector
 *
 * Enforces:
 * - Zero-PII inspection (decrypts only `order_sealed`, never `pii_sealed`)
 * - Atomic buyable pool (`available = daily_cap - held - sold`) with zero oversell
 * - Midnight EAT (UTC+3) automatic daily stock replenishment
 * - Short-TTL checkout holds (carts hold nothing; unpaid holds auto-release)
 * - Policy engine: max_per_order, min_qty, step_qty, max_per_customer_per_day,
 *   max_order_value, customer tiers (retail / wholesale / flagged),
 *   and "surebet" auto-trim vs strict all-or-nothing contention handling.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { decryptInspectablePart, hashCustomerIdentity } from "./blind_checkout_crypto.mjs";

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

export function getEatDateString(nowMs = Date.now()) {
  const eatDate = new Date(nowMs + EAT_OFFSET_MS);
  return eatDate.toISOString().slice(0, 10);
}

export class OrderGuard {
  constructor(options = {}) {
    this.inspectorKey = options.inspectorKey || process.env.ORDER_GUARD_KEY || "dev-order-guard-inspector-key";
    this.hmacSecret = options.hmacSecret || process.env.ORDER_GUARD_HMAC_SECRET || "dev-order-guard-hmac";
    this.stateFile = options.stateFile !== undefined
      ? options.stateFile
      : path.resolve(process.cwd(), "order_guard_state.json");

    this.defaultHoldTtlMs = options.holdTtlMs ?? 10 * 60 * 1000;       // 10 minutes
    this.defaultGraceTtlMs = options.graceTtlMs ?? 3 * 60 * 1000;     // +3 minutes grace
    this.approvalHoldTtlMs = options.approvalHoldTtlMs ?? 30 * 60 * 1000; // 30 minutes for manager approval
    this.defaultMaxOrderValue = options.maxOrderValue ?? 20000;       // KES 20,000 retail auto-approve cap
    this.nowFn = options.nowFn || (() => Date.now());

    // Async mutex chain so all mutations are strictly serialized (0 oversell under concurrency)
    this._mutex = Promise.resolve();
    this._sweeperTimer = null;

    this.state = {
      policies: {},       // `${shopId}:${itemId}` -> { daily_cap, max_per_order, min_qty, step_qty, max_per_customer_per_day, partial_fill_mode, wholesale_max_per_order, ... }
      daily_pools: {},    // `${shopId}:${itemId}:${date}` -> { shop_id, item_id, sale_date, daily_cap, held, sold }
      holds: {},          // order_id -> { order_id, shop_id, sale_date, customer_hash, customer_tier, items: [{id, name, qty, unit_price}], status, expires_at, grace_until, created_at, updated_at }
      customer_daily: {}, // `${shopId}:${customerHash}:${itemId}:${date}` -> qty_reserved_or_sold
      customer_tiers: {}  // `${shopId}:${customerHash}` -> "retail" | "wholesale" | "trusted" | "flagged"
    };

    this._loadState();
  }

  _loadState() {
    if (!this.stateFile) return;
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
        if (raw && typeof raw === "object") {
          this.state = {
            policies: raw.policies || {},
            daily_pools: raw.daily_pools || {},
            holds: raw.holds || {},
            customer_daily: raw.customer_daily || {},
            customer_tiers: raw.customer_tiers || {}
          };
        }
      }
    } catch (err) {
      console.error("[ORDER_GUARD] Failed to load state file:", err.message);
    }
  }

  _saveState() {
    if (!this.stateFile) return;
    try {
      const tmpPath = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.stateFile);
    } catch (err) {
      console.error("[ORDER_GUARD] Failed to save state file:", err.message);
    }
  }

  _withLock(fn) {
    const run = this._mutex.then(() => fn());
    this._mutex = run.catch(() => {});
    return run;
  }

  _policyKey(shopId, itemId) {
    return `${shopId}:${String(itemId).trim().toLowerCase()}`;
  }

  _poolKey(shopId, itemId, saleDate) {
    return `${shopId}:${String(itemId).trim().toLowerCase()}:${saleDate}`;
  }

  _custDailyKey(shopId, customerHash, itemId, saleDate) {
    return `${shopId}:${customerHash}:${String(itemId).trim().toLowerCase()}:${saleDate}`;
  }

  _tierKey(shopId, customerHash) {
    return `${shopId}:${customerHash}`;
  }

  /**
   * Configures policy & daily cap for an item in a shop.
   */
  async configureItemPolicy(shopId, itemId, policy = {}) {
    return this._withLock(() => {
      const pKey = this._policyKey(shopId, itemId);
      const existing = this.state.policies[pKey] || {};
      const dailyCap = policy.daily_cap !== undefined && policy.daily_cap !== null
        ? Number(policy.daily_cap)
        : (existing.daily_cap ?? null);
      if (dailyCap !== null && (!Number.isFinite(dailyCap) || dailyCap < 0)) {
        throw new Error("daily_cap must be a non-negative number.");
      }
      const maxPerOrder = policy.max_per_order !== undefined && policy.max_per_order !== null
        ? Number(policy.max_per_order)
        : (existing.max_per_order ?? null);
      if (maxPerOrder !== null && (!Number.isFinite(maxPerOrder) || maxPerOrder < 1)) {
        throw new Error("max_per_order must be >= 1.");
      }

      const merged = {
        shop_id: shopId,
        item_id: String(itemId).trim(),
        name: policy.name ?? existing.name ?? String(itemId).trim(),
        daily_cap: dailyCap,
        max_per_order: maxPerOrder,
        wholesale_max_per_order: policy.wholesale_max_per_order !== undefined
          ? Number(policy.wholesale_max_per_order)
          : (existing.wholesale_max_per_order ?? null),
        max_per_customer_per_day: policy.max_per_customer_per_day !== undefined
          ? Number(policy.max_per_customer_per_day)
          : (existing.max_per_customer_per_day ?? null),
        min_qty: policy.min_qty !== undefined ? Number(policy.min_qty) : (existing.min_qty ?? 1),
        step_qty: policy.step_qty !== undefined ? Number(policy.step_qty) : (existing.step_qty ?? 1),
        partial_fill_mode: policy.partial_fill_mode ?? existing.partial_fill_mode ?? "strict",
        unit_price: policy.unit_price !== undefined ? Number(policy.unit_price) : (existing.unit_price ?? null)
      };
      this.state.policies[pKey] = merged;

      // Also update today's pool cap if a pool already exists
      const today = getEatDateString(this.nowFn());
      const poolKey = this._poolKey(shopId, itemId, today);
      if (this.state.daily_pools[poolKey] && merged.daily_cap !== null) {
        this.state.daily_pools[poolKey].daily_cap = merged.daily_cap;
      }

      this._saveState();
      return merged;
    });
  }

  /**
   * Sets a customer's trust tier using their hashed phone/ID (zero PII stored).
   */
  async setCustomerTier(shopId, phoneOrHash, tier = "retail", { alreadyHashed = false } = {}) {
    return this._withLock(() => {
      const customerHash = alreadyHashed
        ? phoneOrHash
        : hashCustomerIdentity(phoneOrHash, this.hmacSecret);
      const validTiers = new Set(["retail", "wholesale", "trusted", "flagged"]);
      const normalized = String(tier).toLowerCase().trim();
      if (!validTiers.has(normalized)) {
        throw new Error(`Invalid tier '${tier}'. Allowed: retail, wholesale, trusted, flagged`);
      }
      this.state.customer_tiers[this._tierKey(shopId, customerHash)] = normalized;
      this._saveState();
      return { shop_id: shopId, customer_hash: customerHash, tier: normalized };
    });
  }

  _getCustomerTier(shopId, customerHash) {
    // Server-authoritative only: never trust client-supplied tier claims
    return this.state.customer_tiers[this._tierKey(shopId, customerHash)] || "retail";
  }

  /**
   * Ensures today's EAT pool row exists for (shopId, itemId).
   * Automatically replenishes full `daily_cap` after midnight EAT!
   */
  _ensureDailyPool(shopId, itemId, saleDate) {
    const pKey = this._policyKey(shopId, itemId);
    const policy = this.state.policies[pKey] || {};
    const poolKey = this._poolKey(shopId, itemId, saleDate);

    if (!this.state.daily_pools[poolKey]) {
      this.state.daily_pools[poolKey] = {
        shop_id: shopId,
        item_id: String(itemId).trim(),
        name: policy.name || String(itemId).trim(),
        sale_date: saleDate,
        daily_cap: policy.daily_cap ?? null, // null = uncapped
        held: 0,
        sold: 0
      };
    }
    return this.state.daily_pools[poolKey];
  }

  _getAvailableInPool(pool) {
    if (pool.daily_cap === null || pool.daily_cap === undefined) {
      return Infinity;
    }
    return Math.max(0, pool.daily_cap - pool.held - pool.sold);
  }

  /**
   * Sweeps all expired unpaid holds and returns their stock to the buyable pool.
   */
  _sweepExpiredInternal(nowMs) {
    let releasedCount = 0;
    for (const hold of Object.values(this.state.holds)) {
      if (hold.status === "HELD" || hold.status === "NEEDS_APPROVAL") {
        const hardDeadline = hold.grace_until ?? hold.expires_at;
        if (nowMs >= hardDeadline) {
          this._releaseHoldInternal(hold, "EXPIRED", nowMs);
          releasedCount++;
        }
      }
    }
    if (releasedCount > 0) {
      this._saveState();
    }
    return releasedCount;
  }

  _releaseHoldInternal(hold, newStatus = "RELEASED", nowMs = this.nowFn()) {
    if (hold.status !== "HELD" && hold.status !== "NEEDS_APPROVAL") {
      return false;
    }
    for (const it of hold.items) {
      const poolKey = this._poolKey(hold.shop_id, it.id, hold.sale_date);
      const pool = this.state.daily_pools[poolKey];
      if (pool) {
        pool.held = Math.max(0, pool.held - it.qty);
      }
      const cKey = this._custDailyKey(hold.shop_id, hold.customer_hash, it.id, hold.sale_date);
      if (this.state.customer_daily[cKey]) {
        this.state.customer_daily[cKey] = Math.max(0, this.state.customer_daily[cKey] - it.qty);
      }
    }
    hold.status = newStatus;
    hold.updated_at = nowMs;
    return true;
  }

  async sweepExpiredHolds() {
    return this._withLock(() => this._sweepExpiredInternal(this.nowFn()));
  }

  startSweeper(intervalMs = 60_000) {
    if (this._sweeperTimer) return;
    this._sweeperTimer = setInterval(() => {
      this.sweepExpiredHolds().catch((err) => {
        console.error("[ORDER_GUARD] Sweeper error:", err.message);
      });
    }, intervalMs);
    if (this._sweeperTimer.unref) this._sweeperTimer.unref();
  }

  stopSweeper() {
    if (this._sweeperTimer) {
      clearInterval(this._sweeperTimer);
      this._sweeperTimer = null;
    }
  }

  /**
   * Returns live buyable stock for a shop on today's EAT date.
   */
  async getDailyStockSummary(shopId) {
    return this._withLock(() => {
      const nowMs = this.nowFn();
      this._sweepExpiredInternal(nowMs);
      const today = getEatDateString(nowMs);

      const items = [];
      const seen = new Set();

      for (const policy of Object.values(this.state.policies)) {
        if (policy.shop_id !== shopId) continue;
        const pool = this._ensureDailyPool(shopId, policy.item_id, today);
        seen.add(policy.item_id.toLowerCase());
        const available = this._getAvailableInPool(pool);
        items.push({
          item_id: pool.item_id,
          name: policy.name || pool.item_id,
          sale_date: today,
          daily_cap: pool.daily_cap,
          held: pool.held,
          sold: pool.sold,
          available: available === Infinity ? null : available,
          max_per_order: policy.max_per_order,
          partial_fill_mode: policy.partial_fill_mode
        });
      }

      for (const pool of Object.values(this.state.daily_pools)) {
        if (pool.shop_id !== shopId || pool.sale_date !== today) continue;
        if (seen.has(pool.item_id.toLowerCase())) continue;
        const available = this._getAvailableInPool(pool);
        items.push({
          item_id: pool.item_id,
          name: pool.name || pool.item_id,
          sale_date: today,
          daily_cap: pool.daily_cap,
          held: pool.held,
          sold: pool.sold,
          available: available === Infinity ? null : available,
          max_per_order: null,
          partial_fill_mode: "strict"
        });
      }

      return { shop_id: shopId, sale_date: today, items };
    });
  }

  /**
   * CORE ENTRYPOINT: Blind Checkout Inspector & Atomic Pool Reservation
   *
   * Receives a dual-encrypted checkout envelope:
   * - Decrypts ONLY `order_sealed` with `this.inspectorKey`
   * - NEVER decrypts or reads `pii_sealed`
   * - Validates every item against policy + live buyable pool
   * - Atomically reserves stock (all-or-nothing) or rejects/trims/flags for approval
   */
  async inspectAndReserve(envelope) {
    // 1. Decrypt ONLY the inspectable part (Order Guard has no PII key)
    let payload;
    try {
      payload = envelope?.order_sealed
        ? decryptInspectablePart(envelope, this.inspectorKey)
        : envelope;
    } catch (err) {
      return {
        decision: "REJECTED",
        code: "ENVELOPE_DECRYPT_FAILED",
        can_show_payment: false,
        error: "Order Guard could not decrypt order items payload."
      };
    }

    const {
      order_id,
      shop_id = "default",
      items = [],
      customer_hash = "anonymous",
      customer_tier: requestedTier = "retail",
      partial_fill_mode: orderFillMode = "strict"
    } = payload || {};

    if (!Array.isArray(items) || items.length === 0) {
      return {
        decision: "REJECTED",
        code: "EMPTY_ORDER",
        can_show_payment: false,
        error: "Checkout must contain at least one item."
      };
    }

    return this._withLock(() => {
      const nowMs = this.nowFn();
      // Always sweep expired holds first so abandoned checkouts return to the pool immediately
      this._sweepExpiredInternal(nowMs);

      const saleDate = getEatDateString(nowMs);
      const resolvedOrderId = order_id || `ORD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

      // Idempotency: if this order_id already has an active hold, verify same shop & customer
      const existingHold = this.state.holds[resolvedOrderId];
      if (existingHold && (existingHold.status === "HELD" || existingHold.status === "NEEDS_APPROVAL")) {
        if (existingHold.shop_id !== shop_id || existingHold.customer_hash !== customer_hash) {
          return {
            decision: "REJECTED",
            code: "ORDER_ID_CONFLICT",
            can_show_payment: false,
            error: "Order ID already belongs to another checkout."
          };
        }
        return {
          decision: existingHold.status === "NEEDS_APPROVAL" ? "NEEDS_APPROVAL" : "APPROVED",
          code: "HOLD_ALREADY_ACTIVE",
          order_id: resolvedOrderId,
          sale_date: existingHold.sale_date,
          items: existingHold.items,
          total_value: existingHold.total_value,
          expires_at: existingHold.expires_at,
          grace_until: existingHold.grace_until,
          can_show_payment: existingHold.status === "HELD"
        };
      }

      const tier = this._getCustomerTier(shop_id, customer_hash);
      const isPrivileged = tier === "wholesale" || tier === "trusted";

      // Aggregate duplicate item IDs in the same checkout
      const aggregated = new Map();
      for (const rawItem of items) {
        const id = String(rawItem.id || rawItem.item_id || rawItem.name || "").trim();
        const qty = Number(rawItem.qty ?? rawItem.quantity ?? 0);
        if (!id || !Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
          return {
            decision: "REJECTED",
            code: "INVALID_QUANTITY",
            can_show_payment: false,
            item: id || "unknown",
            error: `Quantity for '${id || "item"}' must be a positive whole number.`
          };
        }
        const prev = aggregated.get(id.toLowerCase());
        if (prev) {
          prev.qty += qty;
        } else {
          const rawPrice = "unit_price" in rawItem ? rawItem.unit_price : ("price" in rawItem ? rawItem.price : 0);
          const numPrice = rawPrice === null ? NaN : Number(rawPrice);
          aggregated.set(id.toLowerCase(), {
            id,
            name: rawItem.name || id,
            qty,
            unit_price: numPrice
          });
        }
      }

      const assignedItems = [];
      const trimNotices = [];
      let totalOrderValue = 0;

      // 2. Inspect every item against Policy & Live Pool (no mutation yet!)
      for (const line of aggregated.values()) {
        const pKey = this._policyKey(shop_id, line.id);
        const policy = this.state.policies[pKey] || {};
        const pool = this._ensureDailyPool(shop_id, line.id, saleDate);
        const available = this._getAvailableInPool(pool);

        const unitPrice = policy.unit_price !== null && policy.unit_price !== undefined
          ? Number(policy.unit_price)
          : line.unit_price;
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
          return {
            decision: "REJECTED",
            code: "INVALID_PRICE",
            can_show_payment: false,
            item: line.id,
            error: `Invalid price for ${line.name}.`
          };
        }

        // Rule A: min_qty & step_qty
        const minQty = policy.min_qty ?? 1;
        const stepQty = policy.step_qty ?? 1;
        if (line.qty < minQty) {
          return {
            decision: "REJECTED",
            code: "BELOW_MIN_QTY",
            can_show_payment: false,
            item: line.id,
            min_qty: minQty,
            requested_qty: line.qty,
            error: `Minimum order quantity for ${line.name} is ${minQty}.`
          };
        }
        if (stepQty > 1 && line.qty % stepQty !== 0) {
          return {
            decision: "REJECTED",
            code: "INVALID_STEP_QTY",
            can_show_payment: false,
            item: line.id,
            step_qty: stepQty,
            requested_qty: line.qty,
            error: `${line.name} must be ordered in multiples of ${stepQty}.`
          };
        }

        // Rule B: max_per_order (wholesale/trusted can have higher or uncapped limit)
        const maxPerOrder = isPrivileged
          ? policy.wholesale_max_per_order
          : policy.max_per_order;
        if (maxPerOrder !== null && maxPerOrder !== undefined && line.qty > maxPerOrder) {
          return {
            decision: "REJECTED",
            code: "MAX_PER_ORDER_EXCEEDED",
            can_show_payment: false,
            item: line.id,
            max_per_order: maxPerOrder,
            requested_qty: line.qty,
            tier,
            error: `Order limit exceeded for ${line.name}: requested ${line.qty}, max allowed per order is ${maxPerOrder} (tier: ${tier}).`
          };
        }

        // Rule C: max_per_customer_per_day (checked via blind customer_hash)
        if (!isPrivileged && policy.max_per_customer_per_day !== null && policy.max_per_customer_per_day !== undefined) {
          const cKey = this._custDailyKey(shop_id, customer_hash, line.id, saleDate);
          const alreadyToday = this.state.customer_daily[cKey] || 0;
          if (alreadyToday + line.qty > policy.max_per_customer_per_day) {
            return {
              decision: "REJECTED",
              code: "DAILY_CUSTOMER_LIMIT_EXCEEDED",
              can_show_payment: false,
              item: line.id,
              daily_limit: policy.max_per_customer_per_day,
              already_ordered_today: alreadyToday,
              requested_qty: line.qty,
              error: `Daily limit per customer reached for ${line.name} (${alreadyToday}/${policy.max_per_customer_per_day} used today).`
            };
          }
        }

        // Rule D: Buyable Pool Availability & "Surebet" Auto-Trim vs Strict
        if (available <= 0) {
          return {
            decision: "REJECTED",
            code: "SOLD_OUT",
            can_show_payment: false,
            item: line.id,
            available: 0,
            requested_qty: line.qty,
            error: `${line.name} is sold out for today (${saleDate}).`
          };
        }

        let finalQty = line.qty;
        const effectiveFillMode = policy.partial_fill_mode && policy.partial_fill_mode !== "strict"
          ? policy.partial_fill_mode
          : orderFillMode;

        if (line.qty > available) {
          if (effectiveFillMode === "surebet" || effectiveFillMode === "auto_trim") {
            finalQty = available;
            trimNotices.push({
              item: line.id,
              name: line.name,
              requested_qty: line.qty,
              assigned_qty: finalQty,
              reason: "SUREBET_REMAINING_STOCK"
            });
          } else {
            return {
              decision: "REJECTED",
              code: "INSUFFICIENT_STOCK",
              can_show_payment: false,
              item: line.id,
              available,
              requested_qty: line.qty,
              error: `Only ${available} of ${line.name} left in today's pool (requested ${line.qty}).`
            };
          }
        }

        totalOrderValue += unitPrice * finalQty;
        assignedItems.push({
          id: line.id,
          name: line.name,
          qty: finalQty,
          unit_price: unitPrice,
          line_total: unitPrice * finalQty
        });
      }

      // Rule E: Flagged customers or high-value retail orders -> NEEDS_APPROVAL (do NOT show Till yet!)
      const needsApproval =
        tier === "flagged" ||
        (!isPrivileged && this.defaultMaxOrderValue > 0 && totalOrderValue > this.defaultMaxOrderValue);

      // 3. Commit the Hold Atomically (all checks passed!)
      for (const it of assignedItems) {
        const pool = this._ensureDailyPool(shop_id, it.id, saleDate);
        pool.held += it.qty;

        const cKey = this._custDailyKey(shop_id, customer_hash, it.id, saleDate);
        this.state.customer_daily[cKey] = (this.state.customer_daily[cKey] || 0) + it.qty;
      }

      const holdTtl = needsApproval ? this.approvalHoldTtlMs : this.defaultHoldTtlMs;
      const expiresAt = nowMs + holdTtl;
      const graceUntil = expiresAt + (needsApproval ? 0 : this.defaultGraceTtlMs);

      this.state.holds[resolvedOrderId] = {
        order_id: resolvedOrderId,
        shop_id,
        sale_date: saleDate,
        customer_hash,
        customer_tier: tier,
        items: assignedItems,
        total_value: totalOrderValue,
        status: needsApproval ? "NEEDS_APPROVAL" : "HELD",
        expires_at: expiresAt,
        grace_until: graceUntil,
        created_at: nowMs,
        updated_at: nowMs
      };

      this._saveState();

      if (needsApproval) {
        return {
          decision: "NEEDS_APPROVAL",
          code: tier === "flagged" ? "FLAGGED_CUSTOMER_APPROVAL" : "HIGH_VALUE_ORDER_APPROVAL",
          order_id: resolvedOrderId,
          sale_date: saleDate,
          items: assignedItems,
          total_value: totalOrderValue,
          trim_notices: trimNotices,
          expires_at: expiresAt,
          can_show_payment: false,
          error: "Order requires manager approval before payment details are released."
        };
      }

      return {
        decision: trimNotices.length > 0 ? "TRIMMED_SUREBET" : "APPROVED",
        code: trimNotices.length > 0 ? "PARTIAL_SUREBET_ASSIGNED" : "STOCK_RESERVED",
        order_id: resolvedOrderId,
        sale_date: saleDate,
        items: assignedItems,
        total_value: totalOrderValue,
        trim_notices: trimNotices,
        expires_at: expiresAt,
        grace_until: graceUntil,
        can_show_payment: true
      };
    });
  }

  /**
   * Manager approves a held NEEDS_APPROVAL order so payment can proceed.
   * Enforces shopId isolation when called from a shop-scoped management group.
   */
  async approveHeldOrder(orderId, shopId = null) {
    return this._withLock(() => {
      const nowMs = this.nowFn();
      this._sweepExpiredInternal(nowMs);
      const hold = this.state.holds[orderId];
      if (!hold) {
        return { success: false, code: "HOLD_NOT_FOUND", error: `Order ${orderId} has no active hold.` };
      }
      if (shopId && hold.shop_id !== shopId) {
        return { success: false, code: "SHOP_MISMATCH", error: `Order ${orderId} belongs to another shop.` };
      }
      if (hold.status === "COMMITTED") {
        return { success: true, code: "ALREADY_COMMITTED", order_id: orderId };
      }
      if (hold.status !== "NEEDS_APPROVAL" && hold.status !== "HELD") {
        return { success: false, code: "HOLD_NOT_ACTIVE", status: hold.status };
      }
      hold.status = "HELD";
      hold.expires_at = nowMs + this.defaultHoldTtlMs;
      hold.grace_until = hold.expires_at + this.defaultGraceTtlMs;
      hold.updated_at = nowMs;
      this._saveState();
      return {
        success: true,
        code: "APPROVED_FOR_PAYMENT",
        order_id: orderId,
        expires_at: hold.expires_at,
        can_show_payment: true
      };
    });
  }

  /**
   * Releases an active hold (cancel or manager decline), returning stock to the buyable pool.
   */
  async releaseOrder(orderId, reason = "CANCELLED", shopId = null) {
    return this._withLock(() => {
      const hold = this.state.holds[orderId];
      if (!hold) {
        return { success: false, code: "HOLD_NOT_FOUND" };
      }
      if (shopId && hold.shop_id !== shopId) {
        return { success: false, code: "SHOP_MISMATCH", error: `Order ${orderId} belongs to another shop.` };
      }
      const released = this._releaseHoldInternal(hold, reason, this.nowFn());
      if (released) this._saveState();
      return { success: released, code: released ? "HOLD_RELEASED" : "HOLD_NOT_ACTIVE", status: hold.status };
    });
  }

  /**
   * Commits a hold permanently (`held` -> `sold`) when payment is verified.
   * - Requires active `HELD` status (rejects unapproved `NEEDS_APPROVAL`).
   * - Allows late-payment recovery ONLY for `EXPIRED` holds (never `DECLINED`/`CANCELLED`/`REFUND_REQUIRED`).
   * - Returns `REFUND_REQUIRED` without overselling if stock is gone.
   */
  async commitOrder(orderId) {
    return this._withLock(() => {
      const nowMs = this.nowFn();
      this._sweepExpiredInternal(nowMs);
      const hold = this.state.holds[orderId];
      if (!hold) {
        return { success: false, code: "HOLD_NOT_FOUND", error: `No hold found for ${orderId}` };
      }
      if (hold.status === "COMMITTED") {
        return { success: true, code: "ALREADY_COMMITTED", order_id: orderId, items: hold.items };
      }
      if (hold.status === "NEEDS_APPROVAL") {
        return {
          success: false,
          code: "APPROVAL_REQUIRED",
          order_id: orderId,
          error: `Order ${orderId} is awaiting manager approval and cannot be committed yet.`
        };
      }

      // Active hold (including grace period)
      if (hold.status === "HELD") {
        for (const it of hold.items) {
          const pool = this._ensureDailyPool(hold.shop_id, it.id, hold.sale_date);
          pool.held = Math.max(0, pool.held - it.qty);
          pool.sold += it.qty;
        }
        hold.status = "COMMITTED";
        hold.updated_at = nowMs;
        this._saveState();
        return { success: true, code: "COMMITTED", order_id: orderId, items: hold.items };
      }

      // Only EXPIRED holds are eligible for late-payment recovery (never DECLINED/CANCELLED/REFUND_REQUIRED)
      if (hold.status !== "EXPIRED") {
        return {
          success: false,
          code: "HOLD_NOT_RECOVERABLE",
          status: hold.status,
          order_id: orderId,
          error: `Hold for ${orderId} is '${hold.status}' and cannot be committed.`
        };
      }
      const today = getEatDateString(nowMs);
      for (const it of hold.items) {
        const pool = this._ensureDailyPool(hold.shop_id, it.id, today);
        if (this._getAvailableInPool(pool) < it.qty) {
          hold.status = "REFUND_REQUIRED";
          hold.updated_at = nowMs;
          this._saveState();
          return {
            success: false,
            code: "REFUND_REQUIRED",
            order_id: orderId,
            item: it.id,
            error: `Hold expired and ${it.name} is now sold out. Payment must be refunded.`
          };
        }
      }

      // Stock still available -> re-acquire & commit directly to sold
      for (const it of hold.items) {
        const pool = this._ensureDailyPool(hold.shop_id, it.id, today);
        pool.sold += it.qty;
        const cKey = this._custDailyKey(hold.shop_id, hold.customer_hash, it.id, today);
        this.state.customer_daily[cKey] = (this.state.customer_daily[cKey] || 0) + it.qty;
      }
      hold.sale_date = today;
      hold.status = "COMMITTED";
      hold.updated_at = nowMs;
      this._saveState();
      return { success: true, code: "LATE_PAYMENT_RECOVERED", order_id: orderId, items: hold.items };
    });
  }
}

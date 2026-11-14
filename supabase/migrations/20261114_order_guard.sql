-- Order Guard: Daily Stock Caps, Short-TTL Checkout Holds, Customer Tiers & Atomic RPCs
-- Midnight EAT (Africa/Nairobi, UTC+3) automatic daily replenishment.

-- 1. Policy columns on menu_items
ALTER TABLE IF EXISTS menu_items
  ADD COLUMN IF NOT EXISTS daily_cap INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS max_per_order INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS wholesale_max_per_order INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS max_per_customer_per_day INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS min_qty INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS step_qty INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS partial_fill_mode TEXT NOT NULL DEFAULT 'strict';

-- 2. Daily inventory pool (one row per item per EAT date; item_id TEXT supports UUIDs or slugs)
CREATE TABLE IF NOT EXISTS inventory_daily (
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sale_date DATE NOT NULL DEFAULT (timezone('Africa/Nairobi', now())::date),
  daily_cap INTEGER NOT NULL,
  held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  sold INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, item_id, sale_date),
  CONSTRAINT chk_no_oversell CHECK (held + sold <= daily_cap)
);

-- 3. Short-TTL checkout holds (carts reserve nothing; only active checkout holds lock stock)
CREATE TABLE IF NOT EXISTS order_holds (
  order_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  sale_date DATE NOT NULL,
  customer_hash TEXT NOT NULL,
  customer_tier TEXT NOT NULL DEFAULT 'retail',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('HELD', 'NEEDS_APPROVAL', 'COMMITTED', 'RELEASED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'REFUND_REQUIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  grace_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_holds_active_expiry
  ON order_holds (status, grace_until)
  WHERE status IN ('HELD', 'NEEDS_APPROVAL');

-- 4. Pseudonymous customer tiers (zero PII)
CREATE TABLE IF NOT EXISTS customer_tiers (
  shop_id TEXT NOT NULL,
  customer_hash TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'retail' CHECK (tier IN ('retail', 'wholesale', 'trusted', 'flagged')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, customer_hash)
);

-- Enable Row Level Security (service_role bypasses RLS; anon/authenticated cannot read/mutate)
ALTER TABLE inventory_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_tiers ENABLE ROW LEVEL SECURITY;

-- 5. Atomic sweep of expired holds
CREATE OR REPLACE FUNCTION og_sweep_expired_holds()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_hold RECORD;
  v_item JSONB;
  v_count INTEGER := 0;
BEGIN
  FOR v_hold IN
    SELECT * FROM order_holds
    WHERE status IN ('HELD', 'NEEDS_APPROVAL')
      AND grace_until <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_hold.items)
    LOOP
      UPDATE inventory_daily
         SET held = GREATEST(0, held - (v_item->>'qty')::INTEGER),
             updated_at = now()
       WHERE shop_id = v_hold.shop_id
         AND item_id = (v_item->>'id')
         AND sale_date = v_hold.sale_date;
    END LOOP;

    UPDATE order_holds
       SET status = 'EXPIRED', updated_at = now()
     WHERE order_id = v_hold.order_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 6. Atomic commit (held -> sold) on payment verification (all-or-nothing pre-check)
CREATE OR REPLACE FUNCTION og_commit_order(p_order_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_hold order_holds%ROWTYPE;
  v_item JSONB;
  v_today DATE := (timezone('Africa/Nairobi', now())::date);
  v_pool inventory_daily%ROWTYPE;
BEGIN
  PERFORM og_sweep_expired_holds();

  SELECT * INTO v_hold FROM order_holds WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'HOLD_NOT_FOUND');
  END IF;

  IF v_hold.status = 'COMMITTED' THEN
    RETURN jsonb_build_object('success', true, 'code', 'ALREADY_COMMITTED');
  END IF;

  IF v_hold.status = 'NEEDS_APPROVAL' THEN
    RETURN jsonb_build_object('success', false, 'code', 'APPROVAL_REQUIRED');
  END IF;

  IF v_hold.status = 'HELD' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_hold.items)
    LOOP
      UPDATE inventory_daily
         SET held = GREATEST(0, held - (v_item->>'qty')::INTEGER),
             sold = sold + (v_item->>'qty')::INTEGER,
             updated_at = now()
       WHERE shop_id = v_hold.shop_id
         AND item_id = (v_item->>'id')
         AND sale_date = v_hold.sale_date;
    END LOOP;

    UPDATE order_holds SET status = 'COMMITTED', updated_at = now() WHERE order_id = p_order_id;
    RETURN jsonb_build_object('success', true, 'code', 'COMMITTED');
  END IF;

  -- Only EXPIRED holds are eligible for late-payment recovery
  IF v_hold.status <> 'EXPIRED' THEN
    RETURN jsonb_build_object('success', false, 'code', 'HOLD_NOT_RECOVERABLE', 'status', v_hold.status);
  END IF;

  -- Phase 1: Lock and verify ALL items before mutating ANY row (prevents partial sold increment)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_hold.items)
  LOOP
    SELECT * INTO v_pool
      FROM inventory_daily
     WHERE shop_id = v_hold.shop_id
       AND item_id = (v_item->>'id')
       AND sale_date = v_today
     FOR UPDATE;

    IF NOT FOUND OR (v_pool.held + v_pool.sold + (v_item->>'qty')::INTEGER > v_pool.daily_cap) THEN
      UPDATE order_holds SET status = 'REFUND_REQUIRED', updated_at = now() WHERE order_id = p_order_id;
      RETURN jsonb_build_object('success', false, 'code', 'REFUND_REQUIRED', 'item', v_item->>'id');
    END IF;
  END LOOP;

  -- Phase 2: All items verified and locked -> commit atomically
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_hold.items)
  LOOP
    UPDATE inventory_daily
       SET sold = sold + (v_item->>'qty')::INTEGER,
           updated_at = now()
     WHERE shop_id = v_hold.shop_id
       AND item_id = (v_item->>'id')
       AND sale_date = v_today;
  END LOOP;

  UPDATE order_holds SET status = 'COMMITTED', sale_date = v_today, updated_at = now() WHERE order_id = p_order_id;
  RETURN jsonb_build_object('success', true, 'code', 'LATE_PAYMENT_RECOVERED');
END;
$$;

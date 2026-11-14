# WhatsApp Operations Gateway, Blind Checkout Inspector & Order Guard — Comprehensive Guide

## 1. What WhatsApp Does in This Platform

The **WhatsApp Operations Gateway** (`whatsapp_gateway/`, port `5174`, powered by `@whiskeysockets/baileys`) is the real-time **operational nervous system, RBAC command center, payment verifier, and storefront API edge** connecting customers, floor staff, management, and executive oversight.

### 1.1 Configuration (`whatsapp_gateway/config.mjs` & `.env`)
- **HTTP Gateway Port:** `PORT` (default `5174`)
- **Baileys Multi-Device Auth:** `WHATSAPP_AUTH_DIR` (persistent session credentials)
- **Supabase Backend:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **Blind Checkout & Order Guard Keys:**
  - `PII_ENCRYPTION_KEY` — held **only** by the outer gateway/fulfillment layer to seal/unseal customer PII (`customer_name`, `customer_phone`, `delivery_address`, `notes`).
  - `ORDER_GUARD_KEY` — held by the **Order Guard Inspector** to decrypt *only* order items (`items`, `shop_id`, `customer_hash`).
  - `ORDER_GUARD_HMAC_SECRET` — one-way HMAC secret for pseudonymous `customer_hash`.

### 1.2 Role-Based Group Architecture & Channel Isolation
`command_handler.mjs` enforces **3-Tier Isolation** via `resolveGroupContext`:

| Tier | Group / Role | JID / Mapping (`config.mjs`) | Who Uses It & Capabilities |
|---|---|---|---|
| **Tier 0: Platform System** | `general` (`perpetua`) | `120363429929736148@g.us` | Platform-wide floor operations mirror, `!status`, `!orders` |
| **Tier 0: Platform System** | `itHelpdesk` | `120363432040872305@g.us` | Gateway vitals (`!status`, `!health`), incident ticketing (`!ticket`, `!resolve`) |
| **Tier 0: Platform System** | `adminOversight` | `120363415291701803@g.us` | Executive GMV (`!summary`), store directory (`!shops`), group binding (`!shop bind <slug> [ops\|mgmt]`) |
| **Tier 0: Platform System** | `dailyRegisterAudit` | `120363414989313710@g.us` | Nightly 9:05 PM EOD closures (`!eod`, `!reconcile`) & M-Pesa Till variance audits |
| **Tier 0: Platform System** | `onboardingRequests` / `community` | `120363415523175268@g.us` / `120363429056719427@g.us` | New merchant signups & platform community |
| **Tier 1: Shop-Scoped** | `OPERATIONS` | `shop.fulfillment_settings.whatsapp_routing.operations_jid` | Cashier, Kitchen/Packer, QA, Courier: `!orders`, `!order <id>`, `!paid`, `!pack`, `!verify`, `!dispatch`, `!delivered` |
| **Tier 1: Shop-Scoped** | `MANAGEMENT` | `shop.fulfillment_settings.whatsapp_routing.management_jid` | Shop owners/managers: all Ops commands **plus** `!summary`, `!product` catalog CRUD, **and Order Guard controls** (`!pool`, `!tier`, `!approve-order`, `!decline-order`) |
| **Tier 1: Shop-Scoped** | `COMMUNITY` | `shop.fulfillment_settings.whatsapp_routing.community_jid` | Customers: `!catalog` / `!items`, `!order <id>`, `!status`, `!help` (strictly blocked from management/admin commands) |

### 1.3 Core WhatsApp Capabilities
1. **5/6-Station Order Pipeline:** Routes new orders and station handoffs (`PENDING -> PAID -> PACKAGING -> VERIFIED -> IN_TRANSIT -> DELIVERED -> COMPLETED`) across shop-scoped Ops, Management, and Platform Oversight groups.
2. **Zero-Trust M-Pesa Payment Verification (`/api/order/verify-payment`):**
   - Matches 10-character M-Pesa transaction codes against the Hardware Till SIM Pool (`till_receipt_pool.json` fed by the Android Till Relay APK) with single-use deduplication (`409 CODE_ALREADY_REDEEMED`).
   - If the code is not yet in the Till pool, keeps the order `PENDING` and sends an unverified claim card requiring `!paid <order_id> <ref>` from an authorized cashier/manager.
3. **In-Chat Product & Catalog Management (`!product`):** Add, edit, price-update, draft-approve (`!approve`, `!hide`, `!drafts`), toggle stock (`!product stock <id> in|out`), and broadcast arrivals to `@newsletter` WhatsApp Channels.
4. **1-Tap Re-Order & Order Resurrection:** `!reorder <order_id>` and `!resurrect <order_id>`.
5. **Order Guard Pool, Tier & Approval Controls (Management Only):**
   - `!pool` or `!pool today` — View live `available`, `held`, `sold`, `daily_cap`, `max_per_order`, and `partial_fill_mode` per item.
   - `!pool <item> cap <N>` — Set daily cap (auto-resets at midnight EAT).
   - `!pool <item> max <N>` — Set max quantity per retail order.
   - `!pool <item> mode <strict|surebet>` — Switch between all-or-nothing (`strict`) and auto-trim (`surebet`).
   - `!tier <phone> <retail|wholesale|trusted|flagged>` — Assign customer trust tier (phone numbers normalized across `07...`, `+2547...`, `2547...`).
   - `!approve-order <order_id>` / `!decline-order <order_id>` — Approve or decline high-value/flagged orders (strictly isolated to the owning shop).

---

## 2. Blind Checkout Inspector & Order Guard Architecture

### 2.1 Cryptographic Blindness (`whatsapp_gateway/blind_checkout_crypto.mjs`)
- `sealCheckoutEnvelope()` splits each incoming checkout into two AES-256-GCM envelopes (`v1.<iv>.<tag>.<ciphertext>`, enforcing 12-byte IV & 16-byte auth tag):
  - `pii_sealed`: Encrypted with `PII_ENCRYPTION_KEY`. **Order Guard never receives this key and cannot decrypt it.**
  - `order_sealed`: Encrypted with `ORDER_GUARD_KEY`. Contains only `order_id`, `shop_id`, `items`, and a one-way HMAC `customer_hash`.
- Client-supplied `customer_tier` is **ignored**; tiers are strictly server-authoritative.

### 2.2 Buyable Pool, No Cart Hoarding & Atomic Anti-Oversell (`whatsapp_gateway/order_guard.mjs`)
- **Carts reserve nothing:** Items sitting in customer carts stay in the buyable pool (`available = daily_cap - held - sold`).
- **Atomic Checkout Hold:** Stock is locked only at `POST /api/v1/storefront/checkout` for **10 minutes** (+3 minutes grace) via a serialized single-writer mutex (and `FOR UPDATE` row locks in Postgres).
- **Midnight EAT (UTC+3) Replenishment:** Pools are keyed by `(shop_id, item_id, sale_date_eat)`. The first request after `00:00 EAT` initializes a fresh row with full `daily_cap`.
- **Expired Hold Sweeper:** Runs lazily on every inspection/commit and every 60 seconds in the background, returning unpaid holds to the pool.
- **All-or-Nothing Multi-Item Validation (`X + Y`):** All items are validated *before* any stock is locked. If `Y` fails (`SOLD_OUT`, `INSUFFICIENT_STOCK`, `MAX_PER_ORDER_EXCEEDED`), **0 units of `X` are locked**, `can_show_payment` is `false`, and the customer is not blocked from fixing `Y` and retrying immediately.
- **Late Payment Safety (`commitOrder`):**
  - Only `HELD` orders can be committed (`NEEDS_APPROVAL`, `DECLINED`, and `CANCELLED` are refused).
  - If an `EXPIRED` hold receives payment later: it re-acquires stock if still available (`LATE_PAYMENT_RECOVERED`), or returns `409 REFUND_REQUIRED` + alerts management on WhatsApp without overselling.

### 2.3 Supabase SQL Migration (`supabase/migrations/20261114_order_guard.sql`)
- Adds policy columns to `menu_items` (`daily_cap`, `max_per_order`, `wholesale_max_per_order`, `max_per_customer_per_day`, `min_qty`, `step_qty`, `partial_fill_mode`).
- Creates `inventory_daily` (with `CHECK (held + sold <= daily_cap)`), `order_holds`, and `customer_tiers` with **Row Level Security (`RLS`)** enabled.
- Defines `og_sweep_expired_holds()` and `og_commit_order()` with two-phase `FOR UPDATE` locking to prevent partial `sold` increments.

---

## 3. Storefront & API Integrations

### 3.1 Gateway HTTP Endpoints (`whatsapp_gateway/http_routes.mjs`)
- `GET /api/v1/storefront/:slug/catalog` — Enriches catalog items with live `available_today`, `daily_cap`, and `max_per_order` (with local `config/shops/:slug.json` fallback when offline).
- `POST /api/v1/storefront/checkout` — Fetches authoritative prices from `menu_items`, resolves `shop_slug` → `shop.id`, seals the blind envelope, runs `OrderGuard.inspectAndReserve()`, and returns `mpesa_till_number` **only** when `can_show_payment: true`.
- `POST /api/v1/storefront/release-hold` — Immediately releases an abandoned/cancelled hold back to the pool.
- `POST /api/order/verify-payment` — Atomically commits the hold (`held → sold`) on verified payment.

### 3.2 Frontend Storefronts (`See -> Act -> Remedy & Continue`)
- **Perpetual Built-in Portal (`templates/storefront.html`, `GET /storefront` on `:5050`):** Includes the **🇰🇪 KEby254** tab, pre-payment Order Guard check, 1-tap **Fix & Retry** buttons, and M-Pesa Till hold banner.
- **TMS Whitelabel Core (`C:\Users\user\Documents\Quality assurance\tms-whitelabel-core`):**
  - Registered `keby254` in `src/tenants/keby254/tenant.config.ts` and `src/tenants/index.ts`.
  - Added `src/services/order-guard-client.js` and wired `inspectOrderWithGuard()` + inline **See → Act → Remedy & Continue** UI into `src/pages/Order.jsx` before `PaymentModal` opens.

---

## 4. Reusable Shop Manifest Template & KEby254 🇰🇪

- **Template:** `config/shop_manifests/shop.template.json` — Copy and fill in production Till, WhatsApp JIDs, and products/caps.
- **Seeder:** `node whatsapp_gateway/seed_shop.mjs <manifest.json>` — Provisions shop + catalog + Order Guard policies (syncs to Supabase when online, falls back locally when offline).
- **KEby254 Manifest:** `config/shop_manifests/keby254.json` (9 products: Hair Clips, Hairband Pack, Shower Cap, Eye Pencil Thick/Thin, Double-Sided Satin Bonnet defaulting 2nd side to Black, Spray Bottle, Beauty Blender, Sized+Colored Crochet Hook, Safety Pins).

---

## 5. Verification Status
- `node --test whatsapp_gateway/order_guard.test.mjs`: **26/26 tests passing** (1,000 concurrent buyers vs 50 stock with 0 oversell, cryptographic blindness, sugar 2kg vs 4kg, `X + Y` partial-cart retry, midnight EAT rollover, security/tampering must-fail checks, and KEby254 live checkout).
- `npm --prefix "C:\Users\user\Documents\Quality assurance\tms-whitelabel-core" run build`: **Passed** (`✓ built in 7.34s`).

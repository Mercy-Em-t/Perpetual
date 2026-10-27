# Multi-Tenant WhatsApp Gateway & Commerce Microservice

A production-grade, multi-tenant WhatsApp Gateway running on **Port 5174** (`http://127.0.0.1:5174`), providing real-time two-way communication between merchants, customers, platform executives, and the **TMS Whitelabel Supabase Commerce Engine**.

---

## 1. Trigger Policy & Privacy Rules

To ensure merchants and staff can hold normal discussions, send voice notes, and share photos without bot interruption, the gateway enforces a **non-intrusive listening filter**:

* **Group Chats (`@g.us`)**: The bot ONLY responds when:
  1. The message starts with an exclamation mark (`!`), e.g., `!orders`, `!status`, `!paid ORD-1042 KES650`.
  2. The bot is directly tagged/mentioned, e.g., `@254710720949 !status` or `@254710720949 orders`.
  * *All normal human conversation, jokes, voice notes, and media are completely ignored by the bot.*
* **Direct Messages (`@s.whatsapp.net`)**: Customers can send natural tracking inquiries (e.g. `order ORD-1042` or `help`) to track their deliveries.

---

## 2. Group Classification & RBAC

Groups are partitioned into strict architectural tiers:

1. **Commerce Shop Groups (`[Shop] - Operations` & `[Shop] - Management`)**:
   * Isolated strictly by `shop_id`.
   * **Floor Operations**: 5-station order pipeline (`!orders`, `!order`, `!paid`, `!pack`, `!verify`, `!dispatch`). Financial summaries (`!summary`) and catalog editing (`!product`) are strictly blocked to protect store margins.
   * **Management Oversight**: In-chat product creation, price updates, stock toggling, and scoped revenue summaries (`!summary today|week|month`).
   * **Spatial Isolation**: 3D scene commands are non-existent in this class.
2. **Platform Governance Groups (`Admin Oversight` & `IT Helpdesk`)**:
   * **Admin Oversight**: Platform-wide GMV rollups, tenant financial drilldowns (`!summary <slug>`), store directories (`!shops`), and on-the-fly group binding (`!shop bind`).
   * **IT Helpdesk**: Edge gateway vitals, error logging, and active incident cards (`!ticket <desc>`, `!resolve <id>`).
3. **3D Scene / Studio Editor Groups**:
   * Dedicated creative spatial channels (completely decoupled from retail stores).
4. **Unregistered Groups**:
   * Any new WhatsApp group is locked until an administrator binds it to a verified shop via `!shop bind <slug> [ops | mgmt]`.

---

## 3. Command Reference

### Order Fulfillment Flow (Floor Operations & Management)
* `!orders [today | pending | paid | dispatched]` — Filter active orders queue
* `!order <order_id>` — Deep dive into customer details, items, notes, and till reference
* `!paid <order_id> <mpesa_code>` — Confirm cashier settlement
* `!pack <order_id>` — Mark order as packaged and boxed
* `!verify <order_id>` — Mark QA checklist as verified
* `!dispatch <order_id> [courier]` — Mark order fulfilled and handed over to courier
* `!status` — Live open queue count, settled revenue today, and master till

#### Supported Query Formats (`!order` & Station Commands):
* **Short Hex Prefix:** `!order 5b0cd3f1` or `!order 832f1b75`
* **Leading Hash:** `!order #5b0cd3f1` or `!order #832f1b75`
* **Angle Brackets:** `!order <5b0cd3f1>` *(from documentation examples)*
* **Full UUID:** `!order 832f1b75-f351-4984-97f1-7869214bc26f`
* **Enterprise Prefix:** `!order ORD-DNH-261027-9K4E`
* **Prefix Spacing Tolerance:** `! order 5b0cd3f1`, `! product`, `! summary`, and `/order` are automatically normalized.

### Ambient "Read & Act" Superpowers (Protected by 6 Anti-Nonsense Guardrails)
When staff chat naturally without typing commands, the gateway passively listens:
1. `💳` **Auto M-Pesa Reconciler:** Forwarded raw Safaricom SMS auto-matches pending order and marks as `PAID`.
2. `📦` **Passive Order Notes:** Conversational shelf locations (`Order #832f packed on Shelf 2`) saved directly to `orders.notes`.
3. `🚚` **Rider Assignments:** Staff messages (`James rider taking Westlands for #832f`) update status to `dispatched`.
4. `📸` **Product Photo Ingestion:** Photos with captions auto-upload to Supabase CDN and create live storefront items.

#### 🛡️ Built-in Anti-Nonsense Guardrails:
* **Question Filter:** Messages with `?` or inquiry words (`is`, `where`, `why`) never alter order state.
* **Negation Protection:** *"James is NOT taking order #832f"* blocks courier assignment and flags note with `⚠️`.
* **Terminal State Lock:** Orders in `delivered`, `cancelled`, or `archived` are immutable.
* **Unpaid Dispatch Guard:** Blocks handing unpaid orders to couriers; alerts staff with `⚠️`.
* **Group RBAC:** Customers in Community groups cannot advance warehouse dispatch pipelines; Operations staff photos of waybills are blocked from product cataloging.
* **M-Pesa Single-Use & Ambiguity Guard:** Duplicates rejected; halts on multiple orders with identical prices to prevent misallocation.

### Product Catalog & Pricing (Management Only)
* `!product list [category]` — View active products with short IDs and prices
* `!product add` — Receive clean, copy-paste key-value product template
* `!product edit <name or ID>` — Receive pre-filled editable product card
* `!product save <ID>` — Save modified product details to Supabase
* `!product price <name or ID> <new_price>` — Update price (with ambiguity and drastic price change safety guards)
* `!product stock` — Dispatches store inventory health overview
* `!product stock <name or ID> <in | out>` — Toggle item availability in storefront

### Platform Administration (Executive Oversight Only)
* `!shops [query]` — List all 17 registered stores with slugs and WhatsApp link status
* `!summary` — Platform-wide GMV, settled orders, and active pipeline
* `!summary <shop_slug>` — Financial drilldown for a specific tenant
* `!shop bind <slug> [ops | mgmt]` — Instant on-the-fly WhatsApp group onboarding
* `!status` / `!health` — Live platform vitals, Supabase connection, and gateway state

---

## 4. Security & Environment Configuration

All credentials and database keys are isolated in `whatsapp_gateway/.env` (strictly ignored by Git):

```ini
SUPABASE_URL=https://ocsuqfabqsyrbsewcaez.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
PORT=5174
WHATSAPP_AUTH_DIR=C:\Users\user\Documents\Quality assurance\tms-whitelabel-core\docker-data\auth
```

* Zero hardcoded keys in tracked code (`config.mjs` loads via Node's native `process.loadEnvFile`).
* Server handover to Pavilion (`100.73.175.118`) synchronizes `.env` directly via encrypted SSH/SCP without touching Git.

---

## 5. Starting the Gateway Daemon

```powershell
# From this directory:
node whatsapp_service.mjs
```
The gateway binds locally to port `5174` and connects to WhatsApp Web as `254710720949@s.whatsapp.net`.

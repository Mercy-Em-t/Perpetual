# Autonomous Order Orchestration & Permutation Matrix
## Non-Linear State Engine, Timing Asynchrony & Forensic Settlement Invariants

---

### Executive Overview: Why Real-World E-Commerce is Non-Linear

In textbook e-commerce, order processing is described as a strict linear sequence:
$$\text{Cart} \longrightarrow \text{Submit Order} \longrightarrow \text{Prompt Payment} \longrightarrow \text{Process} \longrightarrow \text{Confirm}$$

In decentralized, multi-channel African commerce powered by mobile money (M-Pesa STK / Till SIM Relay), **this linear assumption fails**. Real-world actors operate asynchronously across different physical devices, network latencies, operating systems, and human behaviors:
1. **The Customer Browser**: Can refresh, lose network, switch apps to SIM Toolkit, background the tab, or pay *before* ever pressing submit.
2. **The Safaricom GSM Network**: SMS delivery can take from 800 milliseconds to several minutes depending on carrier load.
3. **The Android Till Relay Phone (Redmi Note 12)**: Battery optimization (MIUI Doze mode) can suspend CPU execution and queue SMS delivery until the device wakes.
4. **The Cloud Serverless Engine (Vercel + Supabase)**: Stateless HTTP invocations must handle concurrent hits, out-of-order events, and database locks idempotently.
5. **The WhatsApp Multi-Device Gateway**: Baileys daemon must manage messaging rate limits, group dispatches, and connection reconnections.

This document maps the **complete permutation space**, models the **non-linear state machine**, and details the **forensic invariants** that guarantee no order is ever lost, double-credited, or orphaned.

---

```mermaid
flowchart TD
    subgraph S0["Phase 0: Cart & Intent"]
        C1["Customer Assembles Cart"] --> C2["Fulfillment & Geofence Check"]
        C2 --> C3["Draft Order Generated (Status: pending)"]
    end

    subgraph S1["Phase 1: Asynchronous Payment Paths"]
        C3 -->|Path A: Normal Flow| P1["Customer pays Till via SIM Toolkit"]
        C1 -.->|Path B: Out-of-Order / Pre-Payment| P2["Customer pays BEFORE submitting order"]
        C3 -->|Path C: Third-Party Payer| P3["Friend / Colleague pays from another phone"]
        C3 -->|Path D: Manual Code Entry| P4["Customer inputs 10-char code manually"]
    end

    subgraph S2["Phase 2: Ingestion & Relay Hardware"]
        P1 & P2 & P3 --> GSM["Safaricom SMS to Relay Phone"]
        GSM -->|Phone Awake| RELAY_FAST["Fast Relay (< 1.5s)"]
        GSM -->|MIUI Doze / Asleep| RELAY_DELAY["Queued in SMS Inbox until Wake/Flush"]
        RELAY_FAST & RELAY_DELAY --> API["POST /api/till/receipt"]
        P4 --> API
    end

    subgraph S3["Phase 3: Autonomous Cloud Settlement Engine"]
        API --> DEDUP{"Is M-Pesa Code in Audit Log?"}
        DEDUP -- "Yes (Duplicate)" --> RES_DUP["Return DUPLICATE (Idempotent 200)"]
        DEDUP -- "No (Fresh)" --> MATCH{"Matching Active Order in Window?"}
        
        MATCH -- "Tier 0: Direct Code Match" --> SETTLE["Mark Order PAID & Claim Receipt"]
        MATCH -- "Tier 1: Amount + Phone Suffix" --> SETTLE
        MATCH -- "Tier 2: Amount + Name Token" --> SETTLE
        MATCH -- "Tier 3: Amount + Fresh Candidate (<15m)" --> SETTLE
        
        MATCH -- "No Match Found" --> POOL["Insert into Pool as UNCLAIMED (payment_audit_log & payments)"]
    end

    subgraph S4["Phase 4: Retroactive Claiming & Synchronization"]
        POOL -.->|Order created later or code entered| RETRO["60-min Lookback Engine auto-claims pool"]
        RETRO --> SETTLE
        SETTLE --> WS["Supabase Realtime Broadcast"]
        SETTLE --> WA["WhatsApp Operations & Customer Alert"]
        WS --> UI["Client UI Auto-Clears to Order Confirmation"]
    end
```

---

### The 5 Asynchronous Actors & Their Operating Realities

| Actor | Protocol / Environment | Physical Constraints & Failure Modes | Recovery Mechanism |
| :--- | :--- | :--- | :--- |
| **1. Customer Storefront** | React 19 PWA (Vite / Tailwind) on Mobile Browser | User leaves tab to open M-Pesa; mobile browser sleeps timer; network disconnects. | localStorage session caching, auto-reconnect WebSocket + exponential backoff polling. |
| **2. Carrier Network** | Safaricom GSM / M-Pesa | Delivery latency spikes (1s to 180s); alphanumeric sender masking (`MPESA`). | Alphanumeric regex parser, 15-minute sliding match window. |
| **3. Relay Phone** | Android 12/13 (Redmi Note 12) + `SavannahTillRelay.apk` | MIUI battery saver suspends background process; device reboots; Wi-Fi drops. | Sticky Foreground Service, `RECEIVE_BOOT_COMPLETED`, Wakelock, dead-man's switch heartbeat. |
| **4. Cloud Settlement** | Vercel Serverless + Supabase PostgreSQL | Stateless compute; max 12 functions budget; race conditions during concurrent checkouts. | Multi-action routing (`receipt.js`), atomic SQL upserts, idempotency unique indexes. |
| **5. WhatsApp Gateway** | Node.js + Baileys (Port 5174) | WhatsApp Web socket disconnects; anti-spam rate limiting; server restart. | File-backed multi-device credentials, auto-reconnect supervisor, queue retry engine. |

---

### Master Permutation & Combination Matrix ($P \times C$)

The table below catalogs the **24 critical permutations** of Timing, Identity, Amount, Hardware, and Concurrency:

| ID | Dimension | Scenario / Combination | Probability | System Risk | Forensic Handling & Defense Invariant |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **P-01** | **Timing** | **Happy Path**: Order submitted $\rightarrow$ Payment made $\rightarrow$ SMS received in 2s $\rightarrow$ Settle. | High (65%) | None | Tier 1 match (Phone + Amount). Settles order in < 2.5s; WebSocket clears modal. |
| **P-02** | **Timing** | **Pre-Payment**: Customer pays Till *before* pressing "Submit Order" or while cart is open. | Medium (15%) | Unmatched receipt | Stored in `payment_audit_log` as `unclaimed`. When order is created, 60-min lookback engine claims it instantly with 0 delay. |
| **P-03** | **Timing** | **Delayed Relay (Doze)**: Customer pays, but relay phone is in deep sleep. SMS queued for 3 mins. | Medium (10%) | Customer anxiety | Payment modal displays countdown radar; customer can enter code manually, or app flushes queue upon wake. v2.7.0 keeps CPU awake. |
| **P-04** | **Timing** | **Stale Checkout**: Customer initiates checkout, walks away for 45 mins, then pays. | Low (3%) | Window expired | 15-min default window rejects automatic pairing; receipt goes to `unclaimed`. Manual code input or cashier alert clears it. |
| **P-05** | **Identity** | **Payer $\ne$ Customer**: Husband pays from his M-Pesa line for wife's order (different phone number). | Medium (12%) | Phone mismatch | Tier 2 (Name token match). If names differ completely, customer pastes M-Pesa code into optional input for instant Tier 0 claim. |
| **P-06** | **Identity** | **Corporate / Agent Line**: Payment comes from a business till or agent phone with no recognizable name. | Low (4%) | Name/Phone empty | Falls back to Tier 3 (Newest single candidate in 15-min window) or explicit 10-char M-Pesa code input. |
| **P-07** | **Amount** | **Exact Match**: Paid amount matches order total down to the cent. | High (95%) | None | Immediate settlement. |
| **P-08** | **Amount** | **Underpayment**: Customer owes KES 500 but accidentally pays KES 450. | Low (1%) | Revenue loss | Order remains `pending`. Receipt recorded as partial; WhatsApp alert notifies customer of remaining balance. |
| **P-09** | **Amount** | **Overpayment / Tip**: Customer owes KES 150 but sends KES 200. | Low (2%) | Accounting variance | Order settled as `paid`; excess KES 50.00 logged in `raw_payload.overpayment` as customer credit / merchant tip. |
| **P-10** | **Amount** | **Split Payments**: Customer pays KES 200 first, then KES 300 five minutes later for KES 500 total. | Rare (0.5%) | Multi-receipt sync | Cumulative sum ledger accumulates payments against order ID until threshold is met. |
| **P-11** | **Concurrency**| **Amount Collision**: Two independent customers pay KES 1.00 at the exact same minute. | High during testing | Mis-attribution | **Disambiguated by Customer Phone Suffix** (Tier 1). If both phones are identical, disambiguated by order creation timestamp proximity. |
| **P-12** | **Network** | **Browser Tab Backgrounded**: Customer pays, minimizes Chrome, returns 10 mins later. | High (40%) | Stale UI state | `visibilitychange` event listener automatically polls `/api/till/receipt` on resume to refresh status immediately. |
| **P-13** | **Network** | **Offline Storefront**: Customer loses internet connectivity immediately after payment. | Medium (5%) | Disconnection | PWA Service Worker queues mutations; localStorage stores pending order ID; syncs on `online` event. |
| **P-14** | **Hardware** | **Relay Phone Battery Dies**: Redmi Note 12 powers off at 0%. | Low (1%) | Silent blackout | Dead-man's switch: `GET /api/till/receipt?action=health` alerts operations if no heartbeat is received for >20 mins. |
| **P-15** | **Hardware** | **SMS Parser Failure**: Safaricom changes SMS wording or punctuation. | Rare (0.1%) | Regex miss | Resilient multi-pattern regex fallback with raw payload storage in `payments` table for zero data loss. |
| **P-16** | **Security** | **Replay Attack / Spoofing**: Malicious user sends fake HTTP POST to `/api/till/receipt`. | Medium (threat) | Fraudulent orders | Layer 1: Secret header validation (`x-till-relay-secret`). Layer 2: M-Pesa code verification against Safaricom lookup if suspicious. |
| **P-17** | **Security** | **Code Recycling**: Customer submits a genuine M-Pesa code used on an order 3 days ago. | Low (1%) | Double credit | Unique constraint on `payment_audit_log(checkout_request_id)`. Returns `DUPLICATE` error. |
| **P-18** | **Storefront**| **Cart Abandonment**: Customer creates pending order, gets to payment modal, then cancels. | Medium (20%) | Cluttered database | Order remains `pending_cancelled` with 60-min TTL cleanup; items restored to inventory. |
| **P-19** | **Storefront**| **Multi-Shop Cart**: Customer adds items from Shop A and Shop B from global feed. | Medium (15%) | Cross-tenant split | Core architecture enforces single-shop checkout context (`targetShopId`) preventing mixed-tenant financial collisions. |
| **P-20** | **Fulfillment**| **Out-of-Bounds Address**: Customer pays for delivery to a location outside the shop's geofence. | Low (2%) | Undeliverable order | Hard geofence guard blocks payment modal initiation before draft order can be created. |
| **P-21** | **Operations** | **Cashier Manual Override**: Customer shows physical phone to store cashier before relay syncs. | Low (3%) | Duplicate verify | Cashier dashboard allows 1-tap manual verification; marks audit log `manual_override`. |
| **P-22** | **WhatsApp** | **Gateway Daemon Down**: Port 5174 WhatsApp service is temporarily restarting. | Low (1%) | Missed notification | Order still completes in Supabase and on storefront UI; notification queued in `events` table for retry upon reconnection. |
| **P-23** | **Accounting** | **Continuous Balance Variance**: Till balance drops unexpectedly due to manual withdrawal or airtime purchase. | Medium (weekly) | Ledger discrepancy | Automated EOD reconciliation calculates `currentTillBalance - expectedTillBalance` and flags `VARIANCE_DETECTED` with exact delta. |
| **P-24** | **PWA Cache** | **Stale JavaScript Bundle**: Browser caches old minified code containing syntax/TDZ error. | Low (transient) | Storefront crash | Auto-recovery ErrorBoundary clears ServiceWorker caches and registers cache-busting chunk URLs. |

---

### Deep-Dive: The 4 Core Architectural Resolution Engines

#### 1. The 3-Tier Cascading Settlement Engine (`/api/till/receipt`)
When a raw M-Pesa SMS arrives, the ingestion engine extracts:
* **M-Pesa Transaction Code** (10 characters, e.g. `UKADC1UUCB`)
* **Transaction Amount** (KES float)
* **Payer Phone Number** (e.g. `254710720949`)
* **Payer Name** (e.g. `Jane Doe`)
* **Till Working Balance** (e.g. `KES 738.56`)

It resolves the destination order using strict hierarchical matching:
```
           ┌────────────────────────────┐
           │     Incoming Receipt       │
           └─────────────┬──────────────┘
                         │
         ┌───────────────▼───────────────┐
         │ Tier 0: Direct M-Pesa Code    │ ── Match Found? ──► Settle Order
         └───────────────┬───────────────┘
                         │ (No)
         ┌───────────────▼───────────────┐
         │ Tier 1: Amount + Phone Suffix │ ── Match Found? ──► Settle Order
         └───────────────┬───────────────┘
                         │ (No)
         ┌───────────────▼───────────────┐
         │ Tier 2: Amount + Name Token   │ ── Match Found? ──► Settle Order
         └───────────────┬───────────────┘
                         │ (No)
         ┌───────────────▼───────────────┐
         │ Tier 3: Fresh Candidate (<15m)│ ── Match Found? ──► Settle Order
         └───────────────┬───────────────┘
                         │ (No)
         ┌───────────────▼───────────────┐
         │ Store in Unclaimed Pool       │
         └───────────────────────────────┘
```

#### 2. The Retroactive 60-Minute Lookback Engine
For **Permutation P-02 (Pre-Payment)**:
If a receipt arrived while the user was still entering their address:
1. Receipt is saved to `payments` with `order_id = null` and `status = 'pending'`.
2. Receipt code is saved to `payment_audit_log` with `status = 'unclaimed'`.
3. When the customer submits checkout in `PaymentModal.jsx`, `dispatchCheckoutNotification` or `handleAutoVerify` queries the unclaimed pool for any payment matching `(amount, customerPhone)` within the past 60 minutes.
4. If found, the order transitions to `paid` **instantly on render with 0 seconds wait time**.

#### 3. Continuous Forensic Ledger Continuity
For **Permutation P-23 (Balance Auditing)**:
Every settled and unclaimed transaction records a running mathematical proof:
$$\text{Expected Balance} = \text{Previous Balance} + \text{Amount}$$
$$\text{Variance} = \text{Current Balance} - \text{Expected Balance}$$
If $\text{Variance} = 0$, the ledger is stamped `🟢 BALANCED`.
If $\text{Variance} \ne 0$ (e.g. a merchant withdrawal or Safaricom fee occurred between transactions), the system flags the exact difference without blocking order fulfillment.

#### 4. Hardware Heartbeat & Dead-Man's Switch
For **Permutation P-14 (Relay Phone Offline)**:
* Android v2.7.0 emits periodic pings (`action=heartbeat`) with battery percentage, charging state, and network type.
* Ops monitoring invokes `GET /api/till/receipt?action=health`.
* If $\Delta t_{\text{ping}} > 20\text{ min}$, an automated WhatsApp high-priority dispatch is broadcast to the IT Helpdesk and Store Operations groups.

---

### Verified Invariants & Production Guarantees

1. **Zero Double-Settlement**: A single M-Pesa transaction code can never be attributed to more than one order in `payment_audit_log` due to database-level unique constraints.
2. **Zero Orphaned Money**: Any payment received on Till 5758419 that cannot be matched to an active order is permanently recorded in the `unclaimed` cloud pool for manual cashier claiming or customer code reconciliation.
3. **Multi-Tenant Isolation**: Store orders and Till balances are scoped by `shop_id` and `tenant_id`, preventing cross-store reconciliation contamination.
4. **Resilient Offline Fallback**: If internet connectivity is interrupted on the storefront, the customer's cart, draft order ID, and payment status are persisted in `localStorage` and resume automatically upon reconnection.

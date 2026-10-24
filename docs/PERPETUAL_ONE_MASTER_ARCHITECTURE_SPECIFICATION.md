# Perpetual One: Master Architecture Specification & Operations Manual
## Enterprise System Blueprint (v1.0.0-ENTERPRISE)

**System Name:** Perpetual One (`Perpetual`)  
**Version:** 1.0.0-ENTERPRISE  
**Release Date:** October 2026  
**Core Components:** Shared Agent Room (`:5050`) &bull; Baileys WhatsApp Community Gateway (`:5174`) &bull; Deterministic 3D Engine &bull; Enterprise Reactive Event Bus &bull; Multi-Tenant Storefront Gateway  

---

## 1. Executive Summary & System Topology

**Perpetual One** is an end-to-end autonomous business operations hub. It bridges modern generative AI agents, deterministic 3D spatial scenes, multi-tenant e-commerce storefronts, and real-world human teams through structured, two-way WhatsApp departmental communications.

### Core Capabilities:
1. **ASADF 5-Stage Task State Machine:** Manages multi-agent task lifecycles (`PENDING` $\to$ `CLAIMED` $\to$ `IN_PROGRESS` $\to$ `VERIFIED` $\to$ `DONE`).
2. **The "Dustman" Autonomous Reconciler:** A 5-second periodic daemon that detects abandoned agent leases ($>60\text{s}$), executes atomic database rollbacks, purges zombie locks, and escalates high-severity incident tickets to IT Helpdesk.
3. **Deterministic 3D Spatial Topology:** Anchors physical decor, sconce luminaires, and furniture to surface transformation matrices ($M_{\text{surface}} \times M_{\text{local}}$) with matrix pinning (`locking=True`), eliminating camera and viewport drift ($\Delta = 0.00000000$).
4. **The 3-Tier WhatsApp Community Gateway:** Decouples raw floor telemetry from executive governance across 3 dedicated groups nested under a parent WhatsApp Community.
5. **Enterprise Reactive Event Bus:** Adapted from Java Enterprise R&D, featuring immutable event records, non-blocking thread pool execution ($<0.2\text{ms}$ return), Dead Letter Queue (DLQ) fault isolation, and 15-second sliding-window deduplication.
6. **Live Multi-Tenant Storefront Portal (`/storefront`):** Native e-commerce gateway supporting brand catalogs for **Creative Gales** (Decor), **Digital Nairobi Haberdashery** (Textiles), and **Leah's Kitchen** (Rotating Pre-Orders).

```mermaid
flowchart TD
    subgraph Clients ["Ingress & Client Layer"]
        WebStore["Storefront Portal (:5050/storefront)"]
        RoomUI["Droplet Glass Dashboard (:5050/room)"]
        ExternalPOS["Shopify / WooCommerce / POS Webhooks"]
        DriveIngest["Google Drive Reference Bot"]
    end

    subgraph CorePlatform ["Perpetual One Microservice Core (:5050)"]
        OrdersAPI["Orders & Station API (orders_api.py)"]
        FSM["ASADF Task State Machine (task.py)"]
        Dustman["'Dustman' Lease Reconciler (Every 5s)"]
        Rollup["Hourly P&L Pulse Daemon (Every 3600s)"]
        EventBus["Enterprise Reactive Event Bus (event_bus.py)"]
        DB[(SQLite WAL Database<br/>agent_room.db)]
    end

    subgraph SpatialEngine ["Deterministic 3D Spatial Engine"]
        AssetListener["Event Listener Daemon (asset_listener.py)"]
        Registry["AssetRegistry (19 Registered Classes)"]
        Lighting["Photometric LightingEngine (0.80 / 0.05)"]
        Renderer["Scene Render (room_updated_locked.png)"]
    end

    subgraph GatewayLayer ["WhatsApp Gateway Microservice (:5174)"]
        HttpRouter["REST IPC Router (http_routes.mjs)"]
        RBAC["PolicyEngine (config/organization.json)"]
        BaileysSock["Baileys Multi-Device Socket"]
    end

    subgraph Community ["WhatsApp Perpetua Community (:120363431006794900@g.us)"]
        G1["🏬 Floor Operations ('perpetua')<br/>Raw Telemetry, Station Handoffs, !paid, !pack, !dispatch, !add"]
        G2["💼 Executive Oversight ('Admin Oversight')<br/>Minimal Alerts, Hourly P&L, !summary, !pulse, !details"]
        G3["🛡️ IT Helpdesk ('IT Helpdesk')<br/>Lease Timeouts, Errors, !ticket, !resolve, !health"]
    end

    WebStore & RoomUI & ExternalPOS & DriveIngest --> CorePlatform
    CorePlatform <--> DB
    CorePlatform --> EventBus
    EventBus -->|INSTANTIATE_ASSET| SpatialEngine
    SpatialEngine --> Renderer
    EventBus -->|HTTP IPC /api/notify-group| GatewayLayer
    GatewayLayer --> Community
    Community -.->|Two-Way Commands| GatewayLayer
```

---

## 2. Domain Data Architecture & 3NF Schema

Perpetual One is backed by a thread-safe SQLite database configured in **Write-Ahead Logging (WAL)** mode with a 5000ms busy timeout, guaranteeing zero read contention during high-velocity writes.

### A. The Database Tables ([`room_server/db.py`](file:///c:/Users/user/Documents/Perpetual/room_server/db.py))

```mermaid
erDiagram
    TASKS {
        string task_id PK
        string title
        string task_type
        string state
        int priority
        string claimed_by
        real claimed_at
        int claim_timeout_seconds
        string payload
        string result
        real created_at
        real updated_at
    }

    ORDERS {
        string order_id PK
        string customer_name
        string customer_phone
        string items
        real total_amount
        string currency
        string station
        string payment_ref
        string courier_name
        string notes
        real created_at
        real updated_at
    }

    TICKETS {
        string ticket_id PK
        string title
        string description
        string reported_by
        string severity
        string status
        string associated_task_id
        string resolution_notes
        real created_at
        real updated_at
    }

    MESSAGES {
        string message_id PK
        string sender
        string target
        string topic
        string payload
        real timestamp
    }

    AGENTS {
        string agent_id PK
        string name
        string status
        string current_task_id
        real last_heartbeat
        string metadata
    }

    DRIVE_ASSETS {
        string asset_id PK
        string file_id
        string file_name
        string file_path
        string mime_type
        int file_size
        string associated_task_id
        real ingested_at
    }

    TASKS ||--o{ TICKETS : "associates"
    TASKS ||--o{ DRIVE_ASSETS : "ingests"
```

---

## 3. The 5-Stage ASADF Task Finite State Machine

Tasks move through a strict, deterministic lifecycle:

$$\text{PENDING} \xrightarrow{\text{claim}} \text{CLAIMED} \xrightarrow{\text{start}} \text{IN\_PROGRESS} \xrightarrow{\text{verify}} \text{VERIFIED} \xrightarrow{\text{complete}} \text{DONE}$$

* **`PENDING`:** Task sits in the global pool. Visible to all workers via `!pool`.
* **`CLAIMED`:** A worker or agent locks the task with a 60-second lease window.
* **`IN_PROGRESS`:** The worker is actively computing or assembling.
* **`VERIFIED`:** Quality checks or barcode scans pass.
* **`DONE`:** Result payload is persisted; metrics are archived.

---

## 4. The "Dustman" Autonomous Reconciler Protocol

Located in [`room_server/services/reconciler.py`](file:///c:/Users/user/Documents/Perpetual/room_server/services/reconciler.py), the **"Dustman"** runs as an uninterrupted daemon thread every 5 seconds:

$$\text{Trigger Condition: } \text{now}() - \text{claimed\_at} > \text{claim\_timeout\_seconds (60s)}$$

When triggered, the dustman executes an atomic 4-step recovery:
1. **Atomic State Rollback:** Resets task state back to `PENDING` and purges `claimed_by`. The task is saved from deletion and returns to the pool.
2. **Zombie Lock Cleanup:** Resets the crashed agent's status to `IDLE` and clears `current_task_id`.
3. **Incident Ticket Creation:** Registers a formal incident ticket (`TICK-xxx`) in the database with `severity="HIGH"`.
4. **Targeted Escalation:** Emits a `TASK_TIMEOUT_ROLLBACK` event, alerting **`Perpetua - IT Helpdesk`** without bothering floor operations or executives.

---

## 5. Deterministic 3D Scene Topology & Matrix Locking

Located in [`room_assets/`](file:///c:/Users/user/Documents/Perpetual/room_assets/), the spatial pipeline solves camera drift across re-renders:

### Mathematical Invariant:
Rather than using volatile viewport pixel coordinates, every physical asset is pinned to a surface transformation matrix:

$$P_{\text{world}} = M_{\text{surface}} \times M_{\text{local}} \times \begin{bmatrix} u \\ v \\ w \\ 1 \end{bmatrix}$$

When `locking=True` is asserted, the object locks its local affine transformation matrix, ensuring identical spatial positioning across camera movements:

$$\text{Measured Spatial Drift: } \Delta = 0.00000000$$

### Asset Registry:
The system dynamically resolves 19 asset classes and natural language aliases via [`AssetRegistry.create()`](file:///c:/Users/user/Documents/Perpetual/room_assets/registry.py):
* **Luminaires:** `Sconce`, `light`, `lamp` (Photometric throw: 0.80 on, 0.05 off).
* **Furniture:** `Shelf`, `BlueVelvetSofa` (`sofa`, `couch`), `SwivelBracketTVMount` (`tv`).
* **Decor:** `Books` (`book`), `Flowers` (`flower`), `TrailingPlants` (`plants`, `plant`), `Vase`, `Candle`, `PerfumeBottle`, `Tin`, `WallHanging`, `Macrame`, `JuteRunner` (`runner`).

---

## 6. The 3-Tier WhatsApp Community & Command Center

The WhatsApp gateway ([`whatsapp_gateway/`](file:///c:/Users/user/Documents/Perpetual/whatsapp_gateway/)) provisions a parent **Perpetua Community** (`120363431006794900@g.us`) with 3 specialized departmental groups:

```mermaid
graph TD
    subgraph G1 ["🏬 Group 1: perpetua (Floor Operations)"]
        F1["Information: RAW_TELEMETRY<br/>Commands: !paid, !pack, !verify, !dispatch, !orders, !add, !remove, !turn"]
    end

    subgraph G2 ["💼 Group 2: Perpetua - Admin Oversight (Executive)"]
        F2["Information: AGGREGATED_PULSE<br/>Commands: !summary, !pulse, !details <id>, !pool, !assign"]
    end

    subgraph G3 ["🛡️ Group 3: Perpetua - IT Helpdesk (Quality Desk)"]
        F3["Information: EXCEPTION_ONLY<br/>Commands: !ticket, !resolve, !health"]
    end

    subgraph DM ["📱 Any Group or 1-on-1 Private Direct Message"]
        F4["Universal Execution: All commands accepted with or without '!' prefix"]
    end
```

### Complete Departmental Command Reference

| Command | Department / Channel | Authorized Roles | Function & Parameters |
| :--- | :--- | :--- | :--- |
| **`!paid <order_id> <ref>`** | Floor Operations | `CASHIER`, `EXECUTIVE` | Confirms M-Pesa / Card receipt; advances order to `PAID`. |
| **`!pack <order_id>`** | Floor Operations | `PACKAGER`, `EXECUTIVE` | Marks goods as boxed; notifies QA expediter and couriers. |
| **`!verify <order_id>`** | Floor Operations | `QA_INSPECTOR`, `EXECUTIVE` | Verifies tamper seals and checklists; advances to `VERIFIED`. |
| **`!dispatch <order_id> [rider]`**| Floor Operations | `COURIER`, `EXECUTIVE` | Hands parcel to delivery rider; marks order `DISPATCHED` ✅. |
| **`!orders`** | Floor Operations | All Roles | Lists active in-flight store orders. |
| **`!add <item> to <target>`** | Floor Operations | `SPATIAL_ARTIST`, `EXECUTIVE`| Places 3D asset with matrix lock (`!add books to shelf`). |
| **`!remove <item> from <target>`**| Floor Operations | `SPATIAL_ARTIST`, `EXECUTIVE`| Detaches 3D asset and re-renders room geometry. |
| **`!turn on/off light`** | Floor Operations | `SPATIAL_ARTIST`, `EXECUTIVE`| Toggles warm ambient illumination (0.80 on / 0.05 off). |
| **`!summary`** | Executive Oversight | `EXECUTIVE` | Instant P&L rollup: total revenue, completed vs. in-flight orders. |
| **`!pulse`** | Executive Oversight | `EXECUTIVE` | Dispatches on-demand formatted Executive Pulse Card. |
| **`!details <id>`**<br>*(or `!task`, `!order`)* | Executive Oversight | `EXECUTIVE`, `SUPPORT_ENGINEER`| **On-Demand Drill-Down:** View full audit telemetry, timestamps, and parameters for any task or order. |
| **`!pool`** | Executive Oversight | `EXECUTIVE` | Inspects the active 5-stage ASADF task pipeline. |
| **`!assign <task> to <agent>`**| Executive Oversight | `EXECUTIVE` | Reallocates task lease to a specific agent. |
| **`!ticket <issue>`** | IT Helpdesk | All Roles | Logs technical incident ticket to desk engineers. |
| **`!resolve <ticket_id> [notes]`**| IT Helpdesk | `SUPPORT_ENGINEER`, `EXECUTIVE`| Marks incident resolved; purges from active desk. |
| **`!status`** / **`!health`** | All Channels | All Roles | Queries HTTP microservice vitals and error counters. |

---

## 7. Role-Based Access Control (RBAC) & Organization Configuration

All operational policies are defined in [`config/organization.json`](file:///c:/Users/user/Documents/Perpetual/config/organization.json):

```json
{
  "organization": {
    "org_id": "org_perpetua_001",
    "name": "Perpetua Artisanal & Decor Hub",
    "currency": "USD"
  },
  "roles": {
    "EXECUTIVE": { "allowed_commands": ["*"] },
    "CASHIER": { "allowed_commands": ["!paid", "!orders", "!status", "!help"] },
    "PACKAGER": { "allowed_commands": ["!pack", "!orders", "!status", "!help"] },
    "QA_INSPECTOR": { "allowed_commands": ["!verify", "!ticket", "!orders", "!status"] },
    "COURIER": { "allowed_commands": ["!dispatch", "!orders", "!help"] },
    "SPATIAL_ARTIST": { "allowed_commands": ["!add", "!remove", "!turn", "!light", "!orders"] },
    "SUPPORT_ENGINEER": { "allowed_commands": ["!ticket", "!resolve", "!health", "!details"] }
  },
  "members": [
    { "name": "Lead Owner", "phone": "+254710720949", "role": "EXECUTIVE" },
    { "name": "Jane Cashier", "phone": "+254700000001", "role": "CASHIER" }
  ]
}
```

* **Automated Gatekeeper:** When a user sends a command, [`command_handler.mjs`](file:///c:/Users/user/Documents/Perpetual/whatsapp_gateway/command_handler.mjs) queries `GET /api/organization/rbac/check`. If unauthorized, the bot politely responds:
  > `🚫 Permission Denied: Role 'CASHIER' is not authorized to execute '!summary'.`

---

## 8. The 5-Station Business Process & SLAs

Orders advance through 5 operational stations with strict Service Level Agreements:

$$\text{PENDING} \xrightarrow[10\text{m SLA}]{\text{!paid}} \text{PAID} \xrightarrow[20\text{m SLA}]{\text{!pack}} \text{PACKAGING} \xrightarrow[15\text{m SLA}]{\text{!verify}} \text{VERIFIED} \xrightarrow[30\text{m SLA}]{\text{!dispatch}} \text{DISPATCHED}$$

* **SLA Breach Monitoring:** If an order exceeds its station threshold, the reconciler automatically logs a `SLA_BREACH_ALERT` ticket in **`Perpetua - IT Helpdesk`**.

---

## 9. Live Multi-Tenant Storefront Gateway (`/storefront`)

Accessible live at **[http://localhost:5050/storefront](http://localhost:5050/storefront)**:

1. **Brand Switcher:**
   * **🎨 Creative Gales:** Midnight Blue Velvet Sofa ($450), Amber Sconce ($85), Ceramic Vase ($38), Macrame ($48).
   * **🧵 Digital Nairobi Haberdashery:** Dutch Wax Hollandais ($48), Maasai Shúkà ($22), Lamu Kikoy ($18), Brass Shears ($34).
   * **🍳 Leah's Kitchen:** Swahili Coconut Chicken Stew (KES 850), Coastal Beef Pilau (KES 750), Samosa Trio (KES 400), Spring Rolls (KES 350).
2. **Pre-Order Cutoff & Pickup Logic (Leah's Kitchen):**
   * Pre-order cutoff warning at **17:00 (5:00 PM)** with 15-minute grace window.
   * Pickup Point dropdown (`Gate A (Security Desk)`, `Gate B (Cafeteria Point)`, `Main Kitchen Counter`).
3. **Live 5-Station Visual Stepper:**
   * Stepper reflects state transitions in real time as workers type `!paid`, `!pack`, `!verify`, `!dispatch` in WhatsApp.

---

## 10. Automated Test Verification & Audit Record

| Test Suite | File | Tests Run | Result | Execution Time |
| :--- | :--- | :--- | :--- | :--- |
| **Room Server Microservice** | [`test_room_service.py`](file:///c:/Users/user/Documents/Perpetual/test_room_service.py) | 7 of 7 | **100% Pass** | 0.570s |
| **Enterprise Event Bus** | [`test_enterprise_event_bus.py`](file:///c:/Users/user/Documents/Perpetual/test_enterprise_event_bus.py) | 4 of 4 | **100% Pass** | 0.060s |
| **Leah's Kitchen Checkout** | [`test_leahs_kitchen_checkout.py`](file:///c:/Users/user/Documents/Perpetual/test_leahs_kitchen_checkout.py) | End-to-End | **100% Pass** | 2.100s |
| **3D Dynamic Instantiation** | `test_dynamic_instantiation.py` | 3 of 3 | **100% Pass** | 0.120s |
| **Camera Zero-Drift Matrix** | `test_scene_setup.py` | Matrix Math | **$\Delta = 0.00000000$** | 0.090s |

---

## 11. Quick Start & Production Runbook

To start all Perpetual One services:
```powershell
# 1. Start the Shared Agent Room (Port 5050)
python room_server.py --port 5050

# 2. Start the WhatsApp Gateway (Port 5174)
cd whatsapp_gateway
node whatsapp_service.mjs

# 3. Start the Spatial 3D Asset Listener Daemon
python asset_listener.py --loop --interval 2.0
```

* **Room Dashboard:** [http://localhost:5050/room](http://localhost:5050/room)
* **Storefront Portal:** [http://localhost:5050/storefront](http://localhost:5050/storefront)
* **WhatsApp Community:** `Perpetua Community` (`120363431006794900@g.us`)

*Certified & Released: Lead Systems & Architecture Engineering*

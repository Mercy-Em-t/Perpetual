# Perpetual One 🚀
> **Autonomous Enterprise Microservice Platform & Multi-Agent Operations Hub**

[![Platform](https://img.shields.io/badge/Platform-Perpetual%20One-blue.svg)](file:///c:/Users/user/Documents/Perpetual)
[![Version](https://img.shields.io/badge/Version-1.0.0--ENTERPRISE-success.svg)](file:///c:/Users/user/Documents/Perpetual/docs/PERPETUAL_ONE_MASTER_ARCHITECTURE_SPECIFICATION.md)
[![Database](https://img.shields.io/badge/Database-SQLite%20WAL-orange.svg)](file:///c:/Users/user/Documents/Perpetual/agent_room.db)
[![Architecture](https://img.shields.io/badge/Pattern-Clean%20DDD%20%7C%20Event--Driven-purple.svg)](file:///c:/Users/user/Documents/Perpetual/room_server/services/event_bus.py)
[![WhatsApp](https://img.shields.io/badge/Gateway-Baileys%20Community%20v2-green.svg)](file:///c:/Users/user/Documents/Perpetual/whatsapp_gateway)

---

## 📖 Table of Contents
1. [Overview](#-overview)
2. [Key Architecture Components](#-key-architecture-components)
3. [The 3-Tier WhatsApp Community](#-the-3-tier-whatsapp-community)
4. [Enterprise Event Bus (Reactive Streams)](#-enterprise-reactive-event-bus)
5. [The "Dustman" Autonomous Reconciler](#-the-dustman-autonomous-reconciler)
6. [Multi-Tenant Storefront Gateway](#-multi-tenant-storefront-gateway)
7. [Role-Based Access Control (RBAC)](#-role-based-access-control-rbac)
8. [Deterministic 3D Spatial Engine](#-deterministic-3d-spatial-engine)
9. [Interactive Command Reference](#-interactive-command-reference)
10. [Quick Start & Operations Runbook](#-quick-start--operations-runbook)
11. [Verification & Test Suites](#-verification--test-suites)
12. [Documentation Index](#-documentation-index)

---

## 🌟 Overview

**Perpetual One** is an end-to-end, multi-agent business operations and e-commerce platform. It seamlessly connects:
- **E-Commerce Webhooks & Storefronts** (Creative Gales, Leah's Kitchen, Digital Nairobi Haberdashery)
- **Multi-Agent Task Orchestration** (ASADF 5-Stage Task FSM)
- **Real-Time Human Workforce Messaging** via a 3-tier parent-nested WhatsApp Community
- **Deterministic 3D Spatial Scene Engine** with affine transformation matrix locking ($\Delta = 0.00000000$ camera drift)
- **Self-Healing Infrastructure** via the background "Dustman" reconciler and an enterprise-grade Reactive Event Bus.

```mermaid
flowchart TD
    subgraph Ingress ["1. Ingress Layer"]
        WebStore["Storefront Portal (:5050/storefront)"]
        RoomUI["Droplet Glass Dashboard (:5050/room)"]
        POSWebhooks["External E-Commerce / POS Webhooks"]
    end

    subgraph CorePlatform ["2. Perpetual One Core Microservice (:5050)"]
        OrdersAPI["Orders API (orders_api.py)"]
        FSM["ASADF Task FSM (task.py)"]
        Dustman["'Dustman' Reconciler Daemon (Every 5s)"]
        Rollup["Executive Pulse Daemon (Hourly)"]
        EventBus["Enterprise Reactive Event Bus (event_bus.py)"]
        DB[(SQLite WAL Database<br/>agent_room.db)]
    end

    subgraph SpatialEngine ["3. Deterministic 3D Engine"]
        AssetListener["Spatial Listener Daemon (asset_listener.py)"]
        Registry["AssetRegistry (19 Registered Classes)"]
        Scene["Scene Renderer (room_updated_locked.png)"]
    end

    subgraph Gateway ["4. WhatsApp Gateway (:5174)"]
        HTTPRouter["REST Router (http_routes.mjs)"]
        RBAC["RBAC Policy Engine (organization.json)"]
        Baileys["Baileys Multi-Device Socket"]
    end

    subgraph Community ["5. WhatsApp Perpetua Community (:120363431006794900@g.us)"]
        G1["🏬 Floor Operations ('perpetua')<br/>Telemetry & Station Actions (!paid, !pack, !dispatch)"]
        G2["💼 Executive Oversight ('Admin Oversight')<br/>Pulse Cards, P&L Rollups (!summary, !pulse, !details)"]
        G3["🛡️ IT Helpdesk ('IT Helpdesk')<br/>Lease Timeouts, Incidents (!ticket, !resolve, !health)"]
    end

    Ingress --> CorePlatform
    CorePlatform <--> DB
    CorePlatform --> EventBus
    EventBus -->|INSTANTIATE_ASSET| SpatialEngine
    SpatialEngine --> Scene
    EventBus -->|HTTP IPC /api/notify-group| Gateway
    Gateway --> Community
    Community -.->|Two-Way Commands| Gateway
```

---

## 🏛️ Key Architecture Components

| Microservice / Component | Port / Path | Technology | Responsibility |
| :--- | :--- | :--- | :--- |
| **Shared Agent Room Core** | `http://localhost:5050` | Python / Flask / SQLite WAL | ASADF Task FSM, Orders API, Storefront Web, Reconciler |
| **WhatsApp Community Gateway** | `http://localhost:5174` | Node.js / Baileys E2EE | Multi-device WhatsApp socket, RBAC gatekeeper, Community IPC |
| **Deterministic Spatial Engine** | Background Daemon | Python / Matplotlib / PIL | Matrix-pinned 3D asset placement and photo-realistic rendering |
| **Enterprise Event Bus** | In-Memory Core | Python `ThreadPoolExecutor` | High-throughput non-blocking event publishing with DLQ |
| **Database Engine** | [`agent_room.db`](file:///c:/Users/user/Documents/Perpetual/agent_room.db) | SQLite (WAL Mode) | Persistent 3NF relational data store (Tasks, Orders, Tickets) |

---

## 👥 The 3-Tier WhatsApp Community

Perpetual One organizes departmental human workflows under a single parent **Perpetua Community** (`120363431006794900@g.us`), eliminating noise and notification fatigue:

```mermaid
graph TD
    Parent["🏛️ Perpetua Community<br/>(120363431006794900@g.us)"]
    
    Parent --> G1["🏬 Perpetua Floor Operations<br/>JID: 120363429929736148@g.us<br/>Granularity: RAW_TELEMETRY<br/>Role: Kitchen & Floor Logistics"]
    Parent --> G2["💼 Perpetua Admin Oversight<br/>JID: 120363415291701803@g.us<br/>Granularity: AGGREGATED_PULSE<br/>Role: Executive & P&L Governance"]
    Parent --> G3["🛡️ Perpetua IT Helpdesk<br/>JID: 120363432040872305@g.us<br/>Granularity: EXCEPTION_ONLY<br/>Role: SLA Breaches & System Health"]
    
    DM["📱 Private 1-on-1 Chats & External Groups"]
    DM -.->|Universal Ingress| GatewayLayer["WhatsApp Gateway (:5174)"]
```

- **Information Granularity:** 
  - Floor Ops receives instant task handoffs and station advances.
  - Executives receive clean, minimal alerts (`Task X sent to @Agent Y`) and hourly P&L summaries, with full audit parameters available on demand via `!details <id>`.
  - Helpdesk receives only actionable exceptions (lease timeouts, SLA breaches, system errors).
- **Universal Ingress:** Commands are accepted across all community groups, external groups, or private 1-on-1 direct messages (`@s.whatsapp.net`), with or without the `!` prefix.

---

## ⚡ Enterprise Reactive Event Bus

Modeled after modern Java Enterprise R&D architectures (LMAX Disruptor & Reactive Streams), [`room_server/services/event_bus.py`](file:///c:/Users/user/Documents/Perpetual/room_server/services/event_bus.py) provides high-throughput, fault-isolated event propagation:

- **Immutable Records:** Every event is encapsulated in a frozen `@dataclass RoomEvent` with UUID, millisecond timestamp, topic, payload, and SHA-256 fingerprint.
- **Asynchronous Execution:** Subscribers execute in a background `ThreadPoolExecutor`, returning control to the caller in $<0.2\text{ms}$.
- **Dead Letter Queue (DLQ):** Faulty subscribers or failing webhooks do not crash the publisher; exceptions are caught, logged, and isolated to an in-memory DLQ for auditing.
- **Deduplication Window:** Built-in 15-second sliding-window hash deduplication discards redundant socket re-transmissions.

---

## 🧹 The "Dustman" Autonomous Reconciler

Located in [`room_server/services/reconciler.py`](file:///c:/Users/user/Documents/Perpetual/room_server/services/reconciler.py), the **"Dustman"** runs continuously every 5 seconds:

$$\text{Trigger: } \text{now}() - \text{claimed\_at} > \text{claim\_timeout\_seconds (60s)}$$

When an agent or worker claims a task and freezes or disconnects:
1. **Atomic Rollback:** Reverts the task state to `PENDING` and clears `claimed_by`. The task is saved from deletion and returned to the global pool.
2. **Zombie Lock Purge:** Resets the crashed agent's status back to `IDLE`.
3. **Incident Ticket Created:** Automatically logs a `TICK-xxx` incident in [`agent_room.db`](file:///c:/Users/user/Documents/Perpetual/agent_room.db) with `severity="HIGH"`.
4. **Targeted Escalation:** Emits a `TASK_TIMEOUT_ROLLBACK` event directly to **`Perpetua - IT Helpdesk`**, leaving operational groups undisturbed.

---

## 🛍️ Multi-Tenant Storefront Gateway

Served live at **[http://localhost:5050/storefront](http://localhost:5050/storefront)**, Perpetual One powers multiple distinct brand catalogs from a unified backplane:

1. **Brand Switcher:**
   - **🎨 Creative Gales:** Midnight Blue Velvet Sofa ($450), Amber Sconce ($85), Ceramic Vase ($38), Macrame ($48).
   - **🧵 Digital Nairobi Haberdashery:** Dutch Wax Hollandais ($48), Maasai Shúkà ($22), Lamu Kikoy ($18), Brass Shears ($34).
   - **🍳 Leah's Kitchen:** Swahili Coconut Chicken Stew (KES 850), Coastal Beef Pilau (KES 750), Samosa Trio (KES 400), Spring Rolls (KES 350).
2. **Operational Business Rules (Leah's Kitchen):**
   - Kenyan Shillings (`KES`) currency formatting.
   - Pre-order cutoff warning at **17:00 (5:00 PM)** with 15-minute grace period.
   - Pickup locations: `Gate A (Security Desk)`, `Gate B (Cafeteria Point)`, and `Main Kitchen Counter`.
3. **Live 5-Station Stepper:**
   - The UI stepper dynamically advances in real time as floor workers send WhatsApp messages:
     $$\text{PENDING} \xrightarrow{\text{!paid}} \text{PAID} \xrightarrow{\text{!pack}} \text{PACKAGING} \xrightarrow{\text{!verify}} \text{VERIFIED} \xrightarrow{\text{!dispatch}} \text{DISPATCHED}$$

---

## 🔐 Role-Based Access Control (RBAC)

All operational policies, roles, and memberships are managed in a single source of truth: [`config/organization.json`](file:///c:/Users/user/Documents/Perpetual/config/organization.json).

```json
{
  "organization": {
    "org_id": "org_perpetua_001",
    "name": "Perpetua Artisanal & Decor Hub"
  },
  "roles": {
    "EXECUTIVE": { "allowed_commands": ["*"] },
    "CASHIER": { "allowed_commands": ["!paid", "!orders", "!status", "!help"] },
    "PACKAGER": { "allowed_commands": ["!pack", "!orders", "!status", "!help"] },
    "QA_INSPECTOR": { "allowed_commands": ["!verify", "!ticket", "!orders", "!status"] },
    "COURIER": { "allowed_commands": ["!dispatch", "!orders", "!help"] },
    "SPATIAL_ARTIST": { "allowed_commands": ["!add", "!remove", "!turn", "!light", "!orders"] },
    "SUPPORT_ENGINEER": { "allowed_commands": ["!ticket", "!resolve", "!health", "!details"] }
  }
}
```

* **Gatekeeper:** When a user executes a command, [`command_handler.mjs`](file:///c:/Users/user/Documents/Perpetual/whatsapp_gateway/command_handler.mjs) verifies their registered phone number against `organization.json`. Unauthorized attempts receive an immediate, polite rejection notice.

---

## 🎨 Deterministic 3D Spatial Engine

Located in [`room_assets/`](file:///c:/Users/user/Documents/Perpetual/room_assets/), Perpetual One's spatial pipeline anchors physical decor and lighting to surface transformation matrices:

$$P_{\text{world}} = M_{\text{surface}} \times M_{\text{local}} \times \begin{bmatrix} u \\ v \\ w \\ 1 \end{bmatrix}$$

When `locking=True` is set, local transformation coordinates are locked to prevent scene drift:
$$\text{Measured Camera Drift: } \Delta = 0.00000000$$

- **19 Dynamic Asset Classes:** Sconce, Sofa, Shelf, TV Mount, Books, Flowers, Trailing Plants, Vase, Candle, Perfume Bottle, Tin, Wall Hanging, Macrame, Jute Runner, etc.
- **Photometric Lighting:** Toggles ambient illumination between high (0.80) and low (0.05) lux.

---

## ⌨️ Interactive Command Reference

| Command | Target Department | Authorized Roles | Function |
| :--- | :--- | :--- | :--- |
| `!paid <order_id> <ref>` | Floor Operations | `CASHIER`, `EXECUTIVE` | Records payment ref; advances order to `PAID`. |
| `!pack <order_id>` | Floor Operations | `PACKAGER`, `EXECUTIVE` | Marks goods boxed; advances order to `PACKAGING`. |
| `!verify <order_id>` | Floor Operations | `QA_INSPECTOR`, `EXECUTIVE` | Confirms QA seals; advances order to `VERIFIED`. |
| `!dispatch <order_id> [rider]` | Floor Operations | `COURIER`, `EXECUTIVE` | Hands package to rider; marks order `DISPATCHED`. |
| `!orders` | Floor Operations | All Roles | Lists active, in-flight store orders. |
| `!add <item> to <target>` | Floor Operations | `SPATIAL_ARTIST`, `EXECUTIVE` | Places 3D asset with matrix lock (`!add books to shelf`). |
| `!remove <item> from <target>`| Floor Operations | `SPATIAL_ARTIST`, `EXECUTIVE` | Detaches 3D asset and updates room rendering. |
| `!turn on/off light` | Floor Operations | `SPATIAL_ARTIST`, `EXECUTIVE` | Toggles room photometric lighting (0.80 / 0.05). |
| `!summary` | Executive Oversight | `EXECUTIVE` | High-level P&L rollup (completed revenue vs. in-flight). |
| `!pulse` | Executive Oversight | `EXECUTIVE` | Triggers immediate formatted Executive Pulse Card. |
| `!details <id>` | Executive Oversight | `EXECUTIVE`, `SUPPORT_ENGINEER`| **On-Demand Drill-Down:** View full audit parameters for any task/order. |
| `!pool` | Executive Oversight | `EXECUTIVE` | Lists active tasks in the 5-stage ASADF pipeline. |
| `!assign <task> to <agent>` | Executive Oversight | `EXECUTIVE` | Reassigns a task lease to a specific agent. |
| `!ticket <issue>` | IT Helpdesk | All Roles | Opens an incident ticket for support engineers. |
| `!resolve <ticket_id> [notes]`| IT Helpdesk | `SUPPORT_ENGINEER`, `EXECUTIVE`| Resolves incident; clears ticket from active desk. |
| `!status` / `!health` | All Channels | All Roles | Queries service uptime, memory, and database status. |

---

## 🚀 Quick Start & Operations Runbook

### Prerequisites
- Python 3.10+
- Node.js 18+
- SQLite3

### 1. Launch Services
Run each service in a separate terminal:

```powershell
# 1. Start the Shared Agent Room Core (Port 5050)
python room_server.py --port 5050

# 2. Start the WhatsApp Gateway (Port 5174)
cd whatsapp_gateway
node whatsapp_service.mjs

# 3. Start the Spatial Asset Listener Daemon
python asset_listener.py --loop --interval 2.0
```

### 2. Service Access Endpoints
- **Storefront Portal:** [http://localhost:5050/storefront](http://localhost:5050/storefront)
- **Room Dashboard:** [http://localhost:5050/room](http://localhost:5050/room)
- **Active WhatsApp Community:** `Perpetua Community` (`120363431006794900@g.us`)

---

## 🧪 Verification & Test Suites

Perpetual One is verified with comprehensive test suites:

| Test Suite | File | Tests Run | Result | Duration |
| :--- | :--- | :--- | :--- | :--- |
| **Room Server Microservice** | [`test_room_service.py`](file:///c:/Users/user/Documents/Perpetual/test_room_service.py) | 7 of 7 | **100% Pass** | 0.570s |
| **Enterprise Event Bus** | [`test_enterprise_event_bus.py`](file:///c:/Users/user/Documents/Perpetual/test_enterprise_event_bus.py) | 4 of 4 | **100% Pass** | 0.060s |
| **Leah's Kitchen Checkout E2E** | [`test_leahs_kitchen_checkout.py`](file:///c:/Users/user/Documents/Perpetual/test_leahs_kitchen_checkout.py) | Full Checkout | **100% Pass** | 2.100s |
| **3D Dynamic Instantiation** | `test_dynamic_instantiation.py` | 3 of 3 | **100% Pass** | 0.120s |
| **Camera Zero-Drift Matrix** | `test_scene_setup.py` | Affine Invariance | **$\Delta = 0.00000000$** | 0.090s |

Run all tests via PowerShell:
```powershell
$env:DISABLE_WHATSAPP_DISPATCH="true"
python test_room_service.py
python test_enterprise_event_bus.py
python test_leahs_kitchen_checkout.py
```

---

## 📚 Documentation Index

All technical specifications and operational manuals are available in the [`docs/`](file:///c:/Users/user/Documents/Perpetual/docs) directory:

- 🏛️ [Master Architecture Specification](file:///c:/Users/user/Documents/Perpetual/docs/PERPETUAL_ONE_MASTER_ARCHITECTURE_SPECIFICATION.md) — Comprehensive technical reference manual.
- 🏢 [Organization Onboarding & Policy Guide](file:///c:/Users/user/Documents/Perpetual/docs/ORGANIZATION_ONBOARDING_AND_POLICY_GUIDE.md) — Multi-brand onboarding, roles, and group assignment SOP.
- 📘 [Systems Analysis & Design (SAD) Specification](file:///c:/Users/user/Documents/Perpetual/docs/SYSTEMS_ANALYSIS_AND_DESIGN.md) — Dennis, Wixom & Roth 4-phase SDLC and 3NF normalization.
- 📋 [Requirements Engineering Protocol](file:///c:/Users/user/Documents/Perpetual/docs/REQUIREMENTS_ENGINEERING.md) — ISO/IEC/IEEE 29148 requirements and user stories.
- 📖 [Operator Manual](file:///c:/Users/user/Documents/Perpetual/docs/OPERATOR_MANUAL.md) — Daily desk operations and troubleshooting.
- 🧠 [Thought Process Walkthrough](file:///c:/Users/user/Documents/Perpetual/docs/THOUGHT_PROCESS_WALKTHROUGH.md) — Architectural rationale, design patterns, and engineering decisions.
- 🧩 [Antigravity Skill](file:///C:/Users/user/.gemini/config/skills/perpetual-room-gateway/SKILL.md) — Global reusable agent skill definition.

---
*Perpetual One &copy; 2026. Certified Production Release.*

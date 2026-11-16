# Perpetual & TMS Platform: System Changelog & Master Architecture Index
**Authoritative Operational State, Codebase Index & Comprehensive Evolution Diff**
*Document Version: 2.5.0 | Date: November 16, 2026 | Target Node: Pavilion (`100.73.175.118:8085`)*

---

## 1. Executive Summary

This document serves as the **official single source of truth** for the TMS Whitelabel Core platform and the Perpetual WhatsApp Gateway. It catalogs:
1. **The Current System Architecture**: All active microservices, ports, databases, and cron schedules.
2. **Master Documentation Directory**: An indexed guide to all 8 core governance specifications in `docs/`.
3. **The Systematic Evolution Changelog**: Exactly what was changed, in which file, and to what behavior.
4. **The Operational Invariant Matrix**: Enforced rules in code that cannot be violated.
5. **Command Reference**: The complete cheat sheet for platform management and merchant desk commands.

---

## 2. Master Architecture & Directory Index

```
Perpetual/
├── docs/                                          # Official System Documentation & Policies
│   ├── SYSTEM_CHANGELOG_AND_MASTER_INDEX.md       # [THIS FILE] Master Index & Changelog
│   ├── MERCHANT_OPERATIONS_AND_PLATFORM_GOVERNANCE_SPECIFICATION.md # Handbook & Commercial Models
│   ├── FULFILLMENT_AND_DELIVERY_PROTOCOL.md       # Station FSM, PIN Handover & Dispatch
│   ├── PLATFORM_TREASURY_AND_SETTLEMENT_POLICIES.md # KES 500 Floor, Money In/Out & Reserves
│   ├── MERCHANT_SUSPENSION_AND_REMEDIATION_PROTOCOL.md # Blast Radius, Remediation & Reinstatement
│   ├── TENANT_CUSTOMIZATION_AND_RESTYLING_POLICY.md # Pattern A Scoped CSS & 8-Token Design System
│   ├── CODE_FREEZE_AND_ARCHIVING_SOP.md           # Git Hygiene, Branch Pruning & Archiving
│   ├── TERMS_OF_SERVICE_AND_COMMERCIAL_RESPONSIBILITY.md # Legal Safe-Harbor, Warranty & KDPA
│   └── PLATFORM_MARKETING_AND_ONBOARDING_PAGE.md  # Go-To-Market Pitch, ROI Calculator & Onboarding
├── whatsapp_gateway/                              # Core WhatsApp & Storefront Microservice
│   ├── server.mjs                                 # Main Daemon Entrypoint (Port 8085 / 5174)
│   ├── config.mjs                                 # Supabase Keys, Ports & Departmental JIDs
│   ├── command_handler.mjs                        # Command Router (Shop, System, DM, Remediation)
│   ├── tenant_resolver.mjs                        # Multi-Tenant Resolver & Shop Cache
│   ├── order_guard.mjs                            # Blind Checkout Inspector & Buyable Pools
│   ├── platform_cadence_daemon.mjs                # 24/7 Zero-Drift EAT Scheduler
│   ├── operating_dockets.mjs                      # Real-time Dynamic Action Dockets Engine
│   ├── merchant_infraction_sentinel.mjs           # Autonomous SLA Auditor, Suspend & Reinstate
│   ├── database_backup_sentinel.mjs               # 03:00 AM Automated Snapshot (.json.gz)
│   ├── eod_reconciler.mjs                         # 22:00 PM Dual Register & EAT Utilities
│   └── routes/                                    # Modular HTTP IPC Sub-Routers
│       ├── storefront.mjs                         # Catalog & Blind Checkout (with Suspension Barrier)
│       ├── orders.mjs                             # Order Placement & Webhooks
│       ├── till_finance.mjs                       # Till Reconciliation & Acoustic Modem
│       └── ops_groups_and_support.mjs             # Group Management & Telemetry
├── deploy_pavilion.ps1                            # 1-Tap Instant Hot-Reload Deployment Script
├── sync_gateway.sh                                # Pavilion 5-Minute Continuous Sync Cron
└── .gitignore                                     # Enforces Zero Git Bloat (Backups & Auth Ignored)
```

---

## 3. Systematic Changelog: What Was Changed & To What

### A. Dynamic Zero-Mock Action Dockets Engine
* **File Added**: `whatsapp_gateway/operating_dockets.mjs`
* **Test Suite**: `whatsapp_gateway/operating_dockets.test.mjs`
* **Before**: Manager messages contained hardcoded dummy templates (e.g., `#832F1B75`, mock M-Pesa `QK78912345`, `Botanica`).
* **After**: 100% dynamic. Every line is queried in real time from Supabase (`orders`, `payments`, `shops`). If no exceptions exist, renders clean *"ALL CLEAR"* status cards.
* **Key Dockets**:
  - `06:30 AM`: Overnight Orders, Unseconded Payments, SLA Infractions, Daily Renewals.
  - `09:15 AM`: T+1 B2C Net Settlements (filtered by KES 500 minimum floor).
  - `12:00 PM`: Mid-Day Lunch Rush & Kitchen Bottleneck Telemetry.
  - `22:00 PM`: Dual Register Store Closure & Daily Scorecards.
  - `Tuesday 07:00 AM`: 14-Day Rolling Reserve Releases.
  - `1st of Month 08:00 AM`: Monthly Plan A Invoicing & Consolidated Statements.

---

### B. Autonomous 24/7 Platform Cadence Daemon
* **File Added**: `whatsapp_gateway/platform_cadence_daemon.mjs`
* **Test Suite**: `whatsapp_gateway/cadence_daemon.test.mjs`
* **Before**: Action dockets required manual developer/manager prompting to run.
* **After**: Continuously active background daemon anchored strictly to `Africa/Nairobi` (UTC+3) wall-clock time with memory and lock-key idempotency. Fires autonomous alerts to WhatsApp Management Desk.
* **Calendar Alert Integration**: Added automated 2-day prior WhatsApp alerts for Monthly Platform Review (dispatches Nov 29 for Dec 1) and Annual Strategic Review (dispatches Dec 13 for Dec 15).

---

### C. Automated 03:00 AM Database Backup Sentinel
* **File Added**: `whatsapp_gateway/database_backup_sentinel.mjs`
* **Test Suite**: `whatsapp_gateway/database_backup.test.mjs`
* **Before**: Database backups were performed manually or risked causing large git repository bloat.
* **After**: Autonomous daily snapshot at 03:00 AM EAT. Dumps all 6 primary commerce tables (`shops`, `products`, `orders`, `order_items`, `payments`, `promotions`), compresses to `.json.gz` with gzip, enforces 30-day automatic retention pruning, and guarantees zero git bloat (`backups/` ignored in `.gitignore`).

---

### D. Treasury Economics: KES 500 Minimum B2C Settlement Floor
* **File Modified**: `whatsapp_gateway/operating_dockets.mjs`
* **Before**: Daily net settlements scheduled payouts of any tiny amount (e.g. KES 50), which lost up to 23% in Safaricom M-Pesa B2C tariffs.
* **After**: Enforces the **KES 500 Disbursement Floor**. Shops with net payout `< KES 500` are flagged as `ROLLED_OVER_BELOW_MINIMUM` and accumulate until reaching KES 500, preserving merchant revenue from tariff drag.

---

### E. Doorstep 4-Digit Delivery Verification PIN & Customer Alerts
* **File Modified**: `whatsapp_gateway/command_handler.mjs`
* **Specification**: [FULFILLMENT_AND_DELIVERY_PROTOCOL.md](file:///C:/Users/user/Documents/Perpetual/docs/FULFILLMENT_AND_DELIVERY_PROTOCOL.md)
* **Before**: Customers received no automated WhatsApp notification when an order was dispatched, risking delivery fraud.
* **After**: On `!dispatch <order_id> [rider]`, the system immediately sends a 1-on-1 WhatsApp message to the customer containing the courier name and their private **4-Digit Delivery Verification PIN** (`pickup_pin`). Handover is confirmed when the customer provides the PIN.

---

### F. Merchant Suspension Blast Radius & Remediation Workflow
* **Files Modified**: 
  - `whatsapp_gateway/routes/storefront.mjs`
  - `whatsapp_gateway/tenant_resolver.mjs`
  - `whatsapp_gateway/merchant_infraction_sentinel.mjs`
  - `whatsapp_gateway/command_handler.mjs`
* **Test Suite**: `whatsapp_gateway/shop_suspension_remediation.test.mjs`
* **Specification**: [MERCHANT_SUSPENSION_AND_REMEDIATION_PROTOCOL.md](file:///C:/Users/user/Documents/Perpetual/docs/MERCHANT_SUSPENSION_AND_REMEDIATION_PROTOCOL.md)
* **Before**: Suspending a shop only changed an admin flag; the storefront still loaded and allowed checkout.
* **After**:
  1. **Airtight Blast Radius**: Suspended shops return `is_suspended: true` and 0 available stock on catalog requests, and Order Guard rejects checkouts with **HTTP 403 `SHOP_SUSPENDED`**.
  2. **Automated Suspension Notice**: Sends formal notice to merchant WhatsApp group with the 3-point remediation checklist.
  3. **Merchant Remediation Command**: Merchants submit corrective plans via `!remediation submit <notes>`, which alerts management.
  4. **Reinstatement Gate**: Managers run `!reinstate <slug> [notes]`, which re-opens the storefront and sends a Welcome Back alert.
  5. **Executive DM Passthrough**: Platform admins can execute `!suspend` and `!reinstate` directly from their personal 1-on-1 private WhatsApp DM with the bot.

---

### G. Production Continuous Sync & Pavilion Option C Deployment
* **Files Added**: 
  - `deploy_pavilion.ps1` (1-Tap PowerShell Hot-Reload)
  - `sync_gateway.sh` (Pavilion 5-minute auto-sync cron)
* **Before**: Container updates required risky manual rebuilds or file streaming that could overwrite `.auth_whatsapp_baileys` credentials.
* **After**: Pavilion (`100.73.175.118`) maintains a clean git clone tracking `origin/main`. Container mounts live code while session keys remain protected on disk. Updates hot-reload in 3 seconds flat.

---

## 4. Operational Invariant Matrix

| Invariant | Implementation Mechanism | Enforcement Guarantee |
| :--- | :--- | :--- |
| **Zero-Mock Data** | `operating_dockets.mjs` | No hardcoded order IDs, dummy phone numbers, or fake shops. All data is dynamically pulled from Supabase. |
| **Zero-Oversell** | `order_guard.mjs` | Atomic buyable pool reservations (`available = daily_cap - held - sold`). Short 10m+3m grace TTL. |
| **Zero-Ghost Payments** | `command_handler.mjs` | Unseconded Till claims require automated Safaricom webhook confirmation or manager `!second`. |
| **Zero-Tariff Drag** | `operating_dockets.mjs` | Net B2C disbursements under KES 500 automatically roll over to prevent M-Pesa fee erosion. |
| **Airtight Suspension** | `storefront.mjs` | Suspended shops cannot accept checkouts; Order Guard returns HTTP 403 `SHOP_SUSPENDED`. |
| **Session Preservation** | `deploy_pavilion.ps1` | Continuous sync never touches `.auth_whatsapp_baileys`; zero QR code re-scans required on deployment. |
| **Zero Git Bloat** | `.gitignore` | Automated `.json.gz` database backups are strictly excluded from git tracking. |

---

## 5. Management & Merchant Command Reference

### Platform Executive Commands (Management Group or Personal DM)
* `!status` — View platform-wide health, connected WhatsApp user, and live vitals.
* `!docket [morning | settle | lunch | weekly | monthly]` — Generate any live operational action docket on-demand.
* `!second <order_id> <mpesa_code>` — Confirm and pair an unseconded Till payment.
* `!cancel <order_id> [reason]` — Reject a fraudulent or invalid payment claim.
* `!suspend <shop_slug> [reason]` — Suspend store catalog and block checkouts.
* `!reinstate <shop_slug> [reason]` — Re-activate store catalog and restore checkouts.
* `!infractions [all | <shop_slug>]` — Run real-time SLA infraction audit.
* `!settle approve all` — Authorize all pre-computed T+1 B2C net disbursements.
* `!settle hold <shop_slug> [reason]` — Freeze settlement payout for a specific merchant under review.
* `!backup` — Trigger an immediate encrypted database snapshot.

### Merchant Desk Commands (Store Operations Channel)
* `!prep <order_id>` — Acknowledge order and start kitchen preparation (25-min SLA).
* `!ready <order_id>` — Mark order packaged and ready for courier pickup.
* `!dispatch <order_id> [courier]` — Dispatch order; triggers customer 1-on-1 alert with 4-digit PIN.
* `!delivered <order_id>` — Confirm delivery after verifying 4-digit PIN at doorstep.
* `!voucher <order_id> [amount] [reason]` — Issue replacement store credit for damaged/missing items.
* `!remediation submit <notes>` — Submit corrective action plan following a catalog suspension.
* `!remediation status` — Check current remediation review status.
* `!product stock` — View current physical inventory levels and daily caps.
* `!product price <name> <price>` — Safely update an item price with ambiguity protection.

---

## 6. Verification Test Suite Status

The platform maintains a comprehensive test suite across all subsystems:

```bash
# Gateway & Routing Suite (42 tests pass)
node --test order_guard.test.mjs http_routes.test.mjs order_lifecycle_7x1000.test.mjs

# Operational Governance & Cadence Suite (10 tests pass)
node --test cadence_daemon.test.mjs operating_dockets.test.mjs infraction_sentinel.test.mjs database_backup.test.mjs shop_suspension_remediation.test.mjs
```
* **Total Passing Tests**: **52 / 52 Tests Passing Cleanly**.
* **Live Pavilion Container Health**: `UP` on port `8085` (authenticated as `254710720949@s.whatsapp.net`).

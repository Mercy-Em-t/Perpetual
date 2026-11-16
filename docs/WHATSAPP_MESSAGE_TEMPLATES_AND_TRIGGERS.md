# Perpetual WhatsApp Messaging Templates, Triggers & Orchestration Guide

**Generated:** 2026-11-16  
**Scope:** Covers both the **Pavilion Live Daemon** (`Savannah_Secure_Home_Server/server.mjs` on `http://100.73.175.118:8085`) and the **Modular Gateway** (`whatsapp_gateway/`).

---

## 1. Active Runtime Note (Why DMs behaved the way they did)

- **Pavilion (`100.73.175.118:8085`)** is running `Savannah_Secure_Home_Server/server.mjs` (`savannah-whatsapp-daemon`) connected as `254710720949@s.whatsapp.net`.
- **Why `"help"` in a group did not reply:** Both `Savannah_Secure_Home_Server/server.mjs` (`if (text.startsWith("!"))`) and `whatsapp_gateway/whatsapp_service.mjs` enforce a **Group Privacy Rule**: bare words like `help` are ignored in `@g.us` groups so staff can chat normally. In groups, you must use **`!help`** (or `/help` / `@mention` in `whatsapp_gateway`).
- **Why Haron's DM at 20:39–20:40 triggered `"WELCOME TO CREATIVE GALORE"` twice and `"PAYMENT CODE RECORDED"`:**
  1. `isExplicitShopTrigger` (`/^(?:!|#)?(?:menu|catalog|shop|products|order|items|help|hi shop|hello shop)\b/i`) matches any 1-on-1 DM starting with words like `help`, `order`, `shop`, `items`, etc. — with **no per-chat cooldown**, so a follow-up message starting with one of those words resends the entire welcome card.
  2. Line 378 (`trimmed.match(/\b([A-Z0-9]{10})\b/i)`) matches **any 10-letter English word** (e.g., `everything`, `appreciate`, `understand`, `interested`) because of `/i` and no digit requirement, immediately firing `⏳ *PAYMENT CODE RECORDED — CREATIVE GALORE* ⏳`.
- **Why some links show `tmsavannah.com` vs `shop.tmsavannah.com`:**
  - `WELCOME TO CREATIVE GALORE` (`server.mjs:563`) uses `https://shop.tmsavannah.com/s/creative-galore`.
  - Older order/tracking helpers (`server.mjs:856, 2012`) still hardcode `https://tmsavannah.com/...`.

---

## 2. Modular Gateway (`whatsapp_gateway/`) — Automated Messages

### A. Order & Payment Lifecycle
| Template / Card Header | Trigger & Timing | Target Chat(s) | Source |
| :--- | :--- | :--- | :--- |
| `🛍️ *[NEW STOREFRONT ORDER]* <orderId>` | Immediate on `POST /order` when unpaid | `GROUPS.general` + shop `operations_jid` | `routes/orders.mjs` |
| `💰 *[ORDER PAID & VERIFIED (INSTANT POOL)]* <orderId>` | Immediate on `POST /order` if matching Till receipt is already in pool | `GROUPS.general` + shop `operations_jid` | `routes/orders.mjs` |
| `⏳ *[UNVERIFIED PAYMENT CLAIM — DO NOT DISPATCH YET!]*` | Immediate on `POST /api/order/verify-payment` when customer-submitted code is not in Till Pool | `operations_jid`, `management_jid`, `GROUPS.general`, `GROUPS.adminOversight` | `routes/orders.mjs` |
| `💰 *[ORDER PAID & TILL-POOL VERIFIED]*` | Immediate on `POST /api/order/verify-payment` when verified in Till Pool / 3-factor SMS | Same verification targets | `routes/orders.mjs` |
| `⚠️ *[LATE PAYMENT — REFUND REQUIRED]*` | Immediate on `POST /api/order/verify-payment` if Order Guard hold expired & item sold out | Same verification targets | `routes/orders.mjs` |
| `💳 *[TILL SIM AUTO-SETTLED — <SHOP>]*` | Immediate on `POST /api/till/receipt` when Till SMS matches pending order | `operations_jid`, `management_jid`, `GROUPS.general` | `routes/till_finance.mjs` |
| `📥 *[TILL SMS IN POOL — AWAITING ORDER]*` / `⚠️ *[TILL SMS — AMBIGUOUS MATCH]*` | Immediate on `POST /api/till/receipt` when 0 or >1 pending orders match | `GROUPS.general` | `routes/till_finance.mjs` |
| `📤 *[TILL OUTFLOW / WITHDRAWAL LOGGED]*` | Immediate on `POST /api/till/receipt` for Till withdrawal/send-money SMS | `management_jid` or `GROUPS.general` | `routes/till_finance.mjs` |
| `Hi <FirstName>! 🎉 Payment *KES <amt>* received...` | Immediate when an order is marked `paid` (deduplicated per order ID) | Customer personal WhatsApp DM | `customer_notifier.mjs` |
| `🛡️ *[ORDER GUARD: APPROVAL REQUIRED]* <order_id>` | Immediate when checkout hold returns `NEEDS_APPROVAL` | `management_jid` + `GROUPS.adminOversight` | `routes/storefront.mjs` |
| `🔄 *[ORDER STATION ADVANCED — <SHOP>]*` | Immediate when KDS/storefront advances station (`packed`, `dispatched`, `completed`, `cancelled`) | `GROUPS.general` + `operations_jid` (+ oversight/mgmt on final states) | `routes/storefront.mjs` |

### B. Operations, Support, EOD & Scaling
| Template / Card Header | Trigger & Timing | Target Chat(s) | Source |
| :--- | :--- | :--- | :--- |
| `🏬 *Welcome to <Shop> — Operations Hub!*` & `💼 *Welcome to <Shop> — Management Oversight!*` | Once on shop WhatsApp group provisioning | Newly created Operations & Management groups | `routes/ops_groups_and_support.mjs` |
| Support Ticket Card | Immediate on `POST /api/support/tickets` (unless `silent` probe) | `GROUPS.itHelpdesk` | `routes/ops_groups_and_support.mjs` |
| `✅/🟣/🔵/🟡 *[TASK UPDATE]* <task_id>` | Immediate on `POST /api/broadcast-task` | `GROUPS.general` | `routes/ops_groups_and_support.mjs` |
| `🚨 *[IT INCIDENT ALERT]*` | Immediate on `POST /api/broadcast-error` | `GROUPS.itHelpdesk` | `routes/ops_groups_and_support.mjs` |
| `📊 *[ADMIN AUDIT]*` | Immediate on `POST /api/broadcast-admin` | `GROUPS.adminOversight` | `routes/ops_groups_and_support.mjs` |
| `📊 *DAILY CLOSURE REPORT — <SHOP>*` + Platform Rollup | On EOD trigger / `!eod` / `!reconcile` / `!closure` | Platform Oversight + each active shop's management/owner | `eod_reconciler.mjs` |
| `⚠️ *SCALING ADVISORY*` / `🚨 *DANGEROUS TERRITORY*` | Periodic `scaling_sentinel.mjs` check (every 300s, cooldown-gated) | `GROUPS.adminOversight` + `GROUPS.itHelpdesk` | `scaling_sentinel.mjs` |

### C. Passive Listener (`passive_listener.mjs`)
Runs on non-`!` messages in groups or DMs:
- **Forwarded M-Pesa SMS**: Auto-settles 1:1 pending order (`💳`), flags duplicate (`⚠️`), or flags ambiguous (`❓`).
- **Product Photo + Caption (`<Name> <Price>`)** *(Management/Owner only)*: Uploads image, creates product, reacts `📸`/`⏳`, and broadcasts if live.
- **Order Notes (`#orderId` + logistics/dispatch keyword)**: Appends audit note, updates station if authorized, reacts `📦`/`🚚`/`📝`.

### D. Interactive Commands (`command_handler.mjs`)
- **In Groups:** Requires `!` (or `/`) prefix or `@mention`.
- **In DMs:** Accepts `!` prefix or bare command keywords.
- **Commands:** `!help`, `!shops`, `!shop`/`!bind`, `!orders`, `!order`/`!track`, `!paid`/`!clear`, `!pack`, `!verify`, `!dispatch`, `!delivered`/`!confirm`, `!approve-order`, `!decline-order`, `!resurrect`, `!reorder`, `!product`/`!catalog`/`!items`, `!approve`/`!hide`/`!drafts`/`!policy`, `!pool`, `!tier`, `!status`/`!health`, `!summary`/`!pulse`, `!eod`/`!reconcile`, `!ticket`/`!tickets`/`!claim`/`!resolve`, `!sentinel`.

---

## 3. Recommended Orchestration Fixes (For Quiet, Intentional DMs)
1. **Strict M-Pesa Code Regex:** Require 10-char codes to contain **both letters and digits** (e.g. `/\b(?=[A-Z0-9]{10}\b)(?=.*\d)(?=.*[A-Z])[A-Z0-9]{10}\b/`) or appear inside a `"Confirmed"` M-Pesa SMS — eliminating false triggers on 10-letter English words.
2. **Per-Chat Welcome Cooldown (e.g. 12–24 hours):** Track `lastWelcomeSentAt` per customer JID so the catalog welcome card is never sent repeatedly in the same conversation.
3. **Explicit DM Opt-In:** In 1-on-1 DMs, only reply when the user sends a `!` command, a product number (`buy 1`), or an exact store phrase (instead of any sentence starting with `help` or `order`).
4. **Normalize Domain Links:** Replace remaining `https://tmsavannah.com/...` strings with `https://shop.tmsavannah.com/...`.

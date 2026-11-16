# Platform Treasury & Settlement Policies
**Financial Invariants, Money In/Out Guards & M-Pesa Tariff Optimization**
*Document Version: 1.0.0 | Author: Platform Treasury & Finance Sentinel*

---

## 1. Executive Summary

This policy governs all monetary flows across the platform, including consumer checkout collections (Money In), merchant net disbursements (Money Out), reserve holdbacks, and transaction fee economics.

The core objective is **Zero Loss from Tariff Erosion** while guaranteeing transparent, predictable payouts for merchants.

---

## 2. Inbound Money Flow (Money In / Collections)

```
[Customer Checkout] ──> [Safaricom M-Pesa Till / Paybill] ──> [Platform Holding Account]
                             │
                             └── Direct STK Push / C2B Validation Webhook
```

1. **Minimum Checkout Transaction**:
   - The minimum cart total for online checkout is **KES 50.00**.
   - Carts below KES 50.00 are rejected at Order Guard validation.
2. **Collection Verification (Zero-Ghost Invariant)**:
   - No order is marked `PAID` without either:
     a) A verified Safaricom C2B/STK confirmation webhook matching the exact transaction amount and reference.
     b) An explicit administrative manual seconding command (`!second <order_id> <mpesa_code>`).

---

## 3. Outbound Money Flow (Money Out / Disbursements)

```
[Platform Holding Account] ──> [B2C Net Settlement] ──> [Merchant M-Pesa / Till]
                                    │
                                    ├── Less: Platform Commission (1%–12%)
                                    ├── Less: Rolling Security Reserve (5%)
                                    └── Less: Plan A SaaS Fees (if due)
```

### 3.1. The KES 500 Minimum Payout Floor

Safaricom charges tiered tariffs on M-Pesa B2C disbursements:
- Payouts under KES 100 incur fixed fees up to KES 15.30 (15.3% drag).
- Payouts between KES 100 and KES 500 incur KES 15.30 to KES 23.00 (up to 23% drag).
- Payouts above KES 500 incur an effective fee of $\le 3.0\%$.

> [!IMPORTANT]
> **The KES 500 Disbursement Invariant**:
> Any merchant whose daily net payout is **less than KES 500.00** will have their balance automatically **ROLLED OVER** to the subsequent day's settlement docket.
> Payouts are only scheduled when accumulated net funds reach or exceed **KES 500.00**.
> This prevents merchant revenue from being devoured by Safaricom B2C transfer tariffs.

### 3.2. Rolling Security Reserve (Chargeback & Refund Buffer)

1. **Reserve Rate**: 5.0% of gross daily settled sales.
2. **Holding Duration**: Rolling 14-day maturity.
3. **Weekly Reserve Release**:
   - Every **Tuesday at 07:00 AM EAT**, mature reserves older than 14 days with zero open customer disputes are automatically released and added to the Tuesday morning settlement batch.
4. **Dispute Clamping**: If a customer files an unresolved claim (e.g. food poisoning, undelivered order), the dispute amount is frozen from the merchant's reserve until resolved.

---

## 4. Fee Schedules & Plan Comparison

| Parameter | Plan A (SaaS Multi-Store) | Plan B (Turnkey Rev-Share) |
| :--- | :--- | :--- |
| **Monthly Fixed Platform Fee** | KES 3,500 / store / month | **KES 0.00** |
| **Transaction Processing Commission** | 1.0% – 5.0% on gross GMV | **10.0% – 12.0%** on gross GMV |
| **Settlement Cadence** | Daily T+1 (09:15 AM EAT) | Daily T+1 (09:15 AM EAT) |
| **Minimum Disbursement Threshold** | KES 500.00 | KES 500.00 |
| **Rolling Security Reserve** | 5.0% (14-day release) | 5.0% (14-day release) |
| **Custom Domain & Branding** | Included | Add-on option |
| **Target Merchant Profile** | High-volume established brands (> KES 150k/mo) | Launching shops, seasonal vendors, low initial volume |

---

## 5. Settlement Approval & Execution Workflow

1. **Daily 09:15 AM Pre-Computed Docket**:
   The Platform Cadence Daemon generates the pre-computed schedule:
   ```text
   💰 [PLATFORM DOCKET: 09:15 AM B2C NET SETTLEMENTS]
   • Settlement Cycle: T+1 (Sales Date: 2026-11-15)
   • Total Net Payout Pool: KES 42,150.00
   • Merchants Ready (>= KES 500): 3
   • Rolled Over (< KES 500 Floor): 1 Merchants
   ```
2. **Manager Dual-Control Execution**:
   - Platform manager reviews the docket and executes:
     ```text
     !settle approve all
     ```
   - Or holds a specific merchant if under review:
     ```text
     !settle hold botanica Awaiting customer dispute resolution
     ```
3. **Audit Trail**: Every disbursement records `payout_reference`, `bank_batch_id`, and `net_amount` into the Supabase `settlements` audit table.

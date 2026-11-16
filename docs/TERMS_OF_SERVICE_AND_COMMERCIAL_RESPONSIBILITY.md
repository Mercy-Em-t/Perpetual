# Customer Terms of Service & Commercial Responsibility
**Legal Framework, Merchant Warranties & Platform Safe-Harbor Contract**
*Document Version: 1.0.0 | Author: Platform Governance & Legal Sentinel*

---

## 1. Executive Summary & Legal Separation

The TMS Whitelabel Core platform and Perpetual WhatsApp Gateway operate as a **technology service provider and neutral communications facilitator** ("Platform Provider"). 

The Platform Provider connects independent commercial merchants ("Merchants") with consumers ("Customers"). The Platform Provider is **not a merchant, restaurant, manufacturer, or delivery courier**.

---

## 2. Division of Commercial Responsibility & Liability Matrix

| Domain | Platform Responsibility | Merchant Responsibility | Customer Responsibility |
| :--- | :--- | :--- | :--- |
| **Catalog & Pricing** | Provide accurate real-time inventory locking via Order Guard. | Ensure listed prices, descriptions, allergen warnings, and photos are lawful and accurate. | Review cart items and quantities prior to initiating M-Pesa payment. |
| **Product Quality & Safety** | N/A (Safe-harbor facilitator). | **100% Sole Warranty**: Freshness, preparation hygiene, food safety licenses, non-expired goods. | Inspect tamper-evident seal upon delivery. |
| **Delivery & Courier** | Provide automated tracking, 4-digit verification PIN, and dispatch alerts. | Assign reputable couriers, provide tamper-evident packaging, meet transit SLAs. | Provide accurate delivery location/phone and share PIN only upon physical receipt. |
| **Payment & Billing** | Provide secure M-Pesa STK/Till verification and automated ledger accounting. | Receive net settled funds; honor agreed refund and replacement voucher policies. | Authorize Safaricom M-Pesa PIN prompt only for orders actively initiated. |
| **Disputes & Refunds** | Facilitate mediation, freeze disputed reserves, emit store vouchers. | Respond to dispute within 24 hours; provide immediate replacement or credit. | File dispute with photo evidence within 12 hours of delivery receipt. |

---

## 3. Customer Protection & Fair Dealing Covenants

1. **Price Transparency**:
   - The price displayed at checkout is the **final price**. 
   - No hidden platform surcharges or unauthorized checkout fees may be levied on the customer without explicit line-item disclosure.
2. **Order Cancellation Rights**:
   - Customers may cancel an order free of charge prior to the merchant moving the order to `PREPARING` (`!prep`).
   - Once preparation has commenced, perishable food items cannot be cancelled for full refund unless an SLA breach occurs (> 45 min delay).
3. **Replacement Voucher Guarantee**:
   - If an item is delivered spoiled, missing, or materially damaged, the merchant is required to issue a replacement voucher matching the item value within 4 hours.

---

## 4. Merchant Indemnification & Food Safety Warranty

By connecting to the platform, every Merchant explicitly covenants:
1. **Public Health Compliance**: The Merchant holds all valid County Health Inspections, Food Handling Medical Certificates, and Single Business Permits required under the laws of Kenya.
2. **Indemnification**: The Merchant agrees to defend, indemnify, and hold harmless the Platform Provider, its directors, and infrastructure hosts from any and all third-party claims, illnesses, allergic reactions, property damage, or consumer disputes arising from the Merchant's products.

---

## 5. Privacy & Kenya Data Protection Act (KDPA 2019) Compliance

1. **Minimal Data Collection**: The platform processes only necessary transactional metadata: customer name, delivery phone number, and physical delivery address.
2. **Cryptographic Blindness**: Under Order Guard invariants, internal microservices decrypt only line items and quantities for kitchen routing, keeping customer PII partitioned.
3. **No Commercial Data Resale**: Customer phone numbers and order histories are never sold, rented, or shared with third-party advertisers.

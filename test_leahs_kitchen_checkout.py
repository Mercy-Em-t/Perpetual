"""
End-to-End Checkout Test for Leah's Kitchen
Validates:
1. Ingesting pre-order with cutoff window & pickup point into Perpetual
2. Auto-dispatching the order card to Floor Operations
3. Advancing the order through the 5 operational stations:
   PENDING -> PAID -> PACKAGING -> VERIFIED -> DISPATCHED
4. Generating transaction audit report
"""

import os
import sys
import json
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_URL = "http://127.0.0.1:5050"


def run_test():
    print("=================================================================")
    print("      LEAH'S KITCHEN — END-TO-END CHECKOUT & DISPATCH PIPELINE    ")
    print("=================================================================")

    # 1. Customer Order Payload (configured according to LeahsKitchenGateway)
    order_data = {
        "customer_name": "Dr. Amani Mwangi",
        "customer_phone": "+254710720949",
        "items": [
            {"name": "Swahili Coconut Chicken Stew with Jeera Rice", "qty": 2, "price": 850.0},
            {"name": "Samosa Trio (Beef, Herb & Cheese)", "qty": 1, "price": 400.0},
            {"name": "Crispy Veggie Spring Rolls (Pack of 4)", "qty": 1, "price": 350.0}
        ],
        "total_amount": 2450.0,
        "currency": "KES",
        "notes": "[Leah's Kitchen Pre-Order] Pickup: Gate A (Security Desk) | Cutoff Window: Compliant (< 17:00 Cutoff) | Dietary: No chili on samosas"
    }

    # Step 1: Ingest via Webhook
    req = urllib.request.Request(
        f"{BASE_URL}/api/orders/webhook",
        data=json.dumps(order_data).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        order = res["order"]
        order_id = order["order_id"]

    print(f"\n[STEP 1: ORDER INGESTED VIA WEBHOOK]")
    print(f"  • Order ID:     {order_id}")
    print(f"  • Customer:     {order['customer_name']} ({order['customer_phone']})")
    print(f"  • Initial State: {order['station']} (Awaiting Cashier)")
    print(f"  • Items Count:  {len(order['items'])} items")
    print(f"  • Total Amount: KES {order['total_amount']:,.2f}")
    print(f"  • Notes:        {order['notes']}")

    def advance_station(station, actor, payment_ref=None, courier_name=None, notes=None):
        payload = {
            "station": station,
            "actor": actor,
            "payment_ref": payment_ref,
            "courier_name": courier_name,
            "notes": notes
        }
        r = urllib.request.Request(
            f"{BASE_URL}/api/orders/{order_id}/station",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(r) as response:
            return json.loads(response.read().decode("utf-8"))["order"]

    # Step 2: Cashier verifies M-Pesa Payment
    time.sleep(0.5)
    ord_paid = advance_station(
        station="PAID",
        actor="Cashier_Jane",
        payment_ref="MPESA-QA88921L",
        notes="Confirmed KES 2,450 on Till #89210"
    )
    print(f"\n[STEP 2: CASHIER VERIFIED PAYMENT]")
    print(f"  • Station:      💳 {ord_paid['station']}")
    print(f"  • Payment Ref:  {ord_paid['payment_ref']}")
    print(f"  • Verified By:  Cashier_Jane")

    # Step 3: Kitchen line starts cooking / boxing
    time.sleep(0.5)
    ord_pack = advance_station(
        station="PACKAGING",
        actor="Chef_Leah",
        notes="Coconut Chicken simmered; Spring rolls freshly fried and boxed."
    )
    print(f"\n[STEP 3: KITCHEN PREP & BOXING]")
    print(f"  • Station:      📦 {ord_pack['station']}")
    print(f"  • Handled By:   Chef_Leah (Head Cook)")

    # Step 4: Quality & Tamper Seal Verification
    time.sleep(0.5)
    ord_verify = advance_station(
        station="VERIFIED",
        actor="Expediter_David",
        notes="Pre-order checklist verified: 2 stews, 1 samosa trio, 1 spring rolls. Tamper seal applied."
    )
    print(f"\n[STEP 4: QA EXPEDITER CHECKLIST]")
    print(f"  • Station:      🔍 {ord_verify['station']}")
    print(f"  • Verified By:  Expediter_David")

    # Step 5: Hand-off to Gate A Courier / Runner
    time.sleep(0.5)
    ord_dispatch = advance_station(
        station="DISPATCHED",
        actor="Kitchen_Runner",
        courier_name="Dennis Runner (Gate A Delivery)",
        notes="Delivered to Gate A Security Desk for Dr. Amani Mwangi."
    )
    print(f"\n[STEP 5: ORDER DISPATCHED & FULFILLED]")
    print(f"  • Station:      🚚 {ord_dispatch['station']} ✅")
    print(f"  • Courier:      {ord_dispatch['courier_name']}")
    print(f"  • Destination:  Gate A (Security Desk)")

    # Step 6: Pull Executive Rollup Summary
    req_summary = urllib.request.Request(f"{BASE_URL}/api/orders/summary")
    with urllib.request.urlopen(req_summary) as resp:
        summary = json.loads(resp.read().decode("utf-8"))["summary"]

    print("\n=================================================================")
    print("                    EXECUTIVE SUMMARY ROLLUP                     ")
    print("=================================================================")
    print(f"  • Total Orders Handled: {summary['total_orders']}")
    print(f"  • Completed Today:      {summary['completed']}")
    print(f"  • In-Flight Queue:      {summary['in_flight']}")
    print(f"  • Total Revenue:        ${summary['total_revenue']:,.2f}")
    print("=================================================================")


if __name__ == "__main__":
    run_test()

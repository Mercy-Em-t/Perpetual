"""
Dynamic Per-Shop Pipeline Test Suite
Tests:
1. Pipeline schema resolution for Leah's Kitchen
2. Ingesting order with shop_slug='leahs-kitchen'
3. Advancing through Leah's Kitchen stations: PENDING -> COOKING -> PACKAGING -> READY -> COMPLETED
4. Role authorization & invalid transition rejection
"""

import unittest
import os
import json
os.environ["DISABLE_WHATSAPP_DISPATCH"] = "true"

from room_server import create_app, db
from room_server.models.order import OrderManager
from room_server.models.pipeline import PipelineManager


class DynamicPipelineTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app(start_background_reconciler=False)
        cls.client = cls.app.test_client()

    def test_01_get_pipeline_definition(self):
        resp = self.client.get("/api/orders/pipeline/leahs-kitchen")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["shop_slug"], "leahs-kitchen")
        self.assertEqual(data["currency"], "KES")

        stations = data["pipeline"]["stations"]
        station_ids = [s["id"] for s in stations]
        self.assertEqual(station_ids, ["PENDING", "COOKING", "PACKAGING", "READY", "IN_TRANSIT", "DELIVERED"])

    def test_02_leahs_kitchen_order_lifecycle(self):
        # 1. Ingest order
        order_payload = {
            "shop_slug": "leahs-kitchen",
            "customer_name": "Dr. Amani Mwangi",
            "customer_phone": "+254710720949",
            "items": [
                {"name": "Swahili Coconut Chicken Stew", "qty": 1, "price": 850.0}
            ],
            "total_amount": 850.0,
            "currency": "KES",
            "notes": "Pickup at Gate A"
        }
        res = self.client.post("/api/orders/webhook", json=order_payload)
        self.assertEqual(res.status_code, 201)
        order = res.get_json()["order"]
        order_id = order["order_id"]
        self.assertEqual(order["station"], "PENDING")
        self.assertEqual(order["shop_slug"], "leahs-kitchen")

        # 2. Advance to COOKING (!paid by Cashier)
        res_cook = self.client.post(f"/api/orders/{order_id}/station", json={
            "station": "COOKING",
            "actor": "Cashier_Jane",
            "payment_ref": "MPESA-TEST123"
        })
        self.assertEqual(res_cook.status_code, 200)
        ord_cooking = res_cook.get_json()["order"]
        self.assertEqual(ord_cooking["station"], "COOKING")
        self.assertEqual(ord_cooking["payment_ref"], "MPESA-TEST123")

        # 3. Advance to PACKAGING (!cook by Chef Leah)
        res_pack = self.client.post(f"/api/orders/{order_id}/station", json={
            "station": "PACKAGING",
            "actor": "Chef_Leah"
        })
        self.assertEqual(res_pack.status_code, 200)
        ord_pack = res_pack.get_json()["order"]
        self.assertEqual(ord_pack["station"], "PACKAGING")

        # 4. Advance to READY (!pack by Packager)
        res_ready = self.client.post(f"/api/orders/{order_id}/station", json={
            "station": "READY",
            "actor": "Packer_Sam"
        })
        self.assertEqual(res_ready.status_code, 200)
        ord_ready = res_ready.get_json()["order"]
        self.assertEqual(ord_ready["station"], "READY")

        # 5. Hand off to Courier -> IN_TRANSIT (!dispatch by Counter)
        res_transit = self.client.post(f"/api/orders/{order_id}/station", json={
            "station": "IN_TRANSIT",
            "actor": "Gate_Attendant",
            "courier_name": "Dennis Rider"
        })
        self.assertEqual(res_transit.status_code, 200)
        ord_transit = res_transit.get_json()["order"]
        self.assertEqual(ord_transit["station"], "IN_TRANSIT")
        self.assertEqual(ord_transit["courier_name"], "Dennis Rider")

        # 6. Rider Confirms Delivery -> DELIVERED (!delivered by Rider)
        res_deliv = self.client.post(f"/api/orders/{order_id}/station", json={
            "station": "DELIVERED",
            "actor": "Dennis_Rider",
            "notes": "Arrived at Gate A. Handed parcel to customer."
        })
        self.assertEqual(res_deliv.status_code, 200)
        ord_deliv = res_deliv.get_json()["order"]
        self.assertEqual(ord_deliv["station"], "DELIVERED")

        # 7. Customer Confirms Receipt -> COMPLETED (via web storefront button /api/orders/<id>/confirm-receipt)
        res_confirm = self.client.post(f"/api/orders/{order_id}/confirm-receipt", json={
            "notes": "Customer confirmed hot meal received in good condition."
        })
        self.assertEqual(res_confirm.status_code, 200)
        ord_done = res_confirm.get_json()["order"]
        self.assertEqual(ord_done["station"], "COMPLETED")
        self.assertIn("CUSTOMER", ord_done.get("notes", ""))

    def test_03_invalid_station_rejection(self):
        # Create an order
        order = OrderManager.create_order(
            customer_name="Test Customer",
            items=[{"name": "Item", "qty": 1, "price": 100}],
            total_amount=100,
            shop_slug="leahs-kitchen"
        )
        # Attempt to jump to an invalid / nonexistent station
        res = self.client.post(f"/api/orders/{order['order_id']}/station", json={
            "station": "NON_EXISTENT_STATION",
            "actor": "Hacker"
        })
        self.assertEqual(res.status_code, 400)

    def test_04_multi_shop_pipelines_and_whatsapp_routing(self):
        expected_shops = {
            "creative-galore": "120363429060534928@g.us",
            "leahs-kitchen": "120363431292803284@g.us",
            "haberdashery": "120363431571554014@g.us",
            "brunchbox": "120363432072091775@g.us",
            "thehobby": "120363420879526788@g.us"
        }
        for slug, expected_ops_jid in expected_shops.items():
            resp = self.client.get(f"/api/orders/pipeline/{slug}")
            self.assertEqual(resp.status_code, 200, f"Failed for {slug}")
            data = resp.get_json()
            self.assertEqual(data["shop_slug"], slug)
            self.assertIn("pipeline", data)
            self.assertTrue(len(data["pipeline"]["stations"]) >= 4)
            self.assertEqual(data["whatsapp_groups"]["operations_jid"], expected_ops_jid)

        # Verify /api/orders/shops directory endpoint
        shops_resp = self.client.get("/api/orders/shops")
        self.assertEqual(shops_resp.status_code, 200)
        shops_data = shops_resp.get_json()
        self.assertGreaterEqual(shops_data["count"], 5)

        # Verify /api/orders/validate-cutoff endpoint
        cutoff_resp = self.client.get("/api/orders/validate-cutoff")
        self.assertEqual(cutoff_resp.status_code, 200)
        cutoff_data = cutoff_resp.get_json()
        self.assertIn("batch_day", cutoff_data)
        self.assertIn("is_scheduled_for_today", cutoff_data)


if __name__ == "__main__":
    unittest.main()

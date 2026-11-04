"""
Test Executive Pulse & Order Rollup Metrics
Verifies that OrderManager.get_executive_summary isolates today's activity (EAT),
dynamically resolves currency (KES), supports tenant scoping, and accurately computes
in-flight vs completed orders.
"""

import time
import unittest
from datetime import datetime, timezone, timedelta
from room_server.db import db
from room_server.models.order import OrderManager


class TestExecutivePulse(unittest.TestCase):
    def setUp(self):
        self.conn = db.get_connection()
        self.cursor = self.conn.cursor()

    def tearDown(self):
        # Clean up test orders created during tests
        self.cursor.execute("DELETE FROM orders WHERE order_id LIKE 'TEST-PULSE-%'")
        self.conn.commit()
        self.conn.close()

    def test_executive_summary_today_isolation_and_currency(self):
        eat_tz = timezone(timedelta(hours=3))
        now_eat = datetime.now(eat_tz)
        today_start_ts = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

        # Insert 1 historical order from 3 days ago (1000 KES, PAID)
        three_days_ago = today_start_ts - (3 * 86400)
        self.cursor.execute(
            """
            INSERT INTO orders (order_id, shop_slug, customer_name, customer_phone, items, total_amount, currency, station, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("TEST-PULSE-HIST", "test-shop", "Test Customer", "+254700000001", "[]", 1000.0, "KES", "PAID", three_days_ago, three_days_ago)
        )

        # Insert 1 order created today (2500 KES, PENDING)
        today_order_ts = today_start_ts + 3600
        self.cursor.execute(
            """
            INSERT INTO orders (order_id, shop_slug, customer_name, customer_phone, items, total_amount, currency, station, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("TEST-PULSE-TODAY", "test-shop", "Test Customer 2", "+254700000002", "[]", 2500.0, "KES", "PENDING", today_order_ts, today_order_ts)
        )
        self.conn.commit()

        # Test shop-scoped summary
        summary = OrderManager.get_executive_summary(shop_slug="test-shop")

        self.assertEqual(summary["currency"], "KES")
        self.assertEqual(summary["today_orders"], 1)
        self.assertEqual(summary["today_revenue"], 2500.0)
        self.assertEqual(summary["total_orders"], 2)
        self.assertEqual(summary["total_revenue"], 3500.0)
        self.assertEqual(summary["in_flight"], 2)  # 1 PENDING + 1 PAID
        self.assertEqual(summary["completed"], 0)

    def test_executive_summary_status_breakdown(self):
        eat_tz = timezone(timedelta(hours=3))
        now_eat = datetime.now(eat_tz)
        today_start_ts = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

        # Insert 1 completed order today (500 KES, DISPATCHED)
        self.cursor.execute(
            """
            INSERT INTO orders (order_id, shop_slug, customer_name, customer_phone, items, total_amount, currency, station, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("TEST-PULSE-DISP", "test-shop-2", "Test Customer 3", "+254700000003", "[]", 500.0, "KES", "DISPATCHED", today_start_ts + 7200, today_start_ts + 7200)
        )
        self.conn.commit()

        summary = OrderManager.get_executive_summary(shop_slug="test-shop-2")
        self.assertEqual(summary["today_orders"], 1)
        self.assertEqual(summary["today_revenue"], 500.0)
        self.assertEqual(summary["today_completed"], 1)
        self.assertEqual(summary["in_flight"], 0)
        self.assertEqual(summary["completed"], 1)
        self.assertEqual(summary["station_counts"]["DISPATCHED"], 1)


if __name__ == "__main__":
    unittest.main()

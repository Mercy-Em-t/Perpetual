"""
Backend adapters: the only place Nova touches Perpetual One.

- LivePerpetualBackend wraps room_server models (OrderManager, TicketManager,
  WhatsApp notifier). Imported lazily because importing `room_server` boots
  the Perpetual app and its background daemons.
- InMemoryBackend is a seeded fake for tests, evals and offline demos.
"""

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional

from nova_perpetual.config import PACKAGE_DIR

HR_DIRECTORY_PATH = os.path.join(PACKAGE_DIR, "data", "hr_directory.json")


def _digits(phone: str) -> str:
    return "".join(ch for ch in (phone or "") if ch.isdigit())[-9:]


class PerpetualBackend:
    def get_order(self, order_id: str) -> Optional[Dict[str, Any]]: ...
    def list_orders_for_phone(self, phone: str) -> List[Dict[str, Any]]: ...
    def create_ticket(self, title: str, description: str, reported_by: str, severity: str) -> Dict[str, Any]: ...
    def notify(self, department: str, message: str) -> bool: ...

    def hr_directory(self) -> List[Dict[str, Any]]:
        if not os.path.exists(HR_DIRECTORY_PATH):
            return []
        with open(HR_DIRECTORY_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("employees", [])


class LivePerpetualBackend(PerpetualBackend):
    def get_order(self, order_id):
        from room_server.models.order import OrderManager
        return OrderManager.get_order(order_id)

    def list_orders_for_phone(self, phone):
        from room_server.db import db
        conn = db.get_connection()
        try:
            rows = conn.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200").fetchall()
        finally:
            conn.close()
        target = _digits(phone)
        return [dict(r) for r in rows if target and _digits(r["customer_phone"]) == target]

    def create_ticket(self, title, description, reported_by, severity):
        from room_server.models.ticket import TicketManager
        return TicketManager.create_ticket(title=title, description=description,
                                           reported_by=reported_by, severity=severity)

    def notify(self, department, message):
        from room_server.services import whatsapp_notifier as wa
        if department == "executive_oversight":
            wa.dispatch_to_whatsapp_admin(f"[Nova] {message}")
        elif department == "quality_desk":
            wa.dispatch_to_whatsapp_error(error_type="NOVA_ESCALATION", title="Nova escalation",
                                          error_details=message)
        else:
            wa.dispatch_to_whatsapp_general(f"[Nova] {message}")
        return True


class InMemoryBackend(PerpetualBackend):
    def __init__(self, orders: Optional[List[Dict[str, Any]]] = None):
        self.orders = {o["order_id"]: o for o in (orders or SEED_ORDERS)}
        self.tickets: List[Dict[str, Any]] = []
        self.notifications: List[Dict[str, str]] = []

    def get_order(self, order_id):
        return self.orders.get(order_id.upper())

    def list_orders_for_phone(self, phone):
        t = _digits(phone)
        return [o for o in self.orders.values() if t and _digits(o.get("customer_phone")) == t]

    def create_ticket(self, title, description, reported_by, severity):
        t = {"ticket_id": f"TICK-{uuid.uuid4().hex[:6].upper()}", "title": title, "description": description,
             "reported_by": reported_by, "severity": severity, "status": "OPEN", "created_at": time.time()}
        self.tickets.append(t)
        return t

    def notify(self, department, message):
        self.notifications.append({"department": department, "message": message})
        return True


SEED_ORDERS = [
    {"order_id": "ORD-1001", "customer_name": "Amina Otieno", "customer_phone": "+254722000111",
     "total_amount": 42.0, "currency": "USD", "station": "DISPATCHED", "courier_name": "Perpetua Express",
     "shop_slug": "leahs-kitchen"},
    {"order_id": "ORD-1002", "customer_name": "Amina Otieno", "customer_phone": "+254722000111",
     "total_amount": 180.0, "currency": "USD", "station": "PACKAGING", "courier_name": "",
     "shop_slug": "creative-gales"},
    {"order_id": "ORD-2001", "customer_name": "Brian Kamau", "customer_phone": "+254733000222",
     "total_amount": 65.0, "currency": "USD", "station": "PAID", "courier_name": "",
     "shop_slug": "haberdashery"},
]

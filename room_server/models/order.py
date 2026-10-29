"""
Order Data Model & Operational Station Transitions
Handles order creation, 5-station operational handoffs, and executive KPI rollups.
Stations: PENDING -> PAID -> PACKAGING -> VERIFIED -> DISPATCHED
"""

import time
import json
import uuid
from typing import Dict, Any, List, Optional
from room_server.db import db
from room_server.models.message import MessageBroker
from room_server.models.pipeline import PipelineManager
from room_server.services.whatsapp_notifier import (
    dispatch_to_whatsapp_general,
    dispatch_to_whatsapp_admin,
    dispatch_to_whatsapp_jid
)


class OrderManager:
    VALID_STATIONS = ("PENDING", "PAID", "PACKAGING", "VERIFIED", "DISPATCHED", "CANCELLED")

    STATION_EMOJIS = {
        "PENDING": "🟡",
        "PAID": "💳",
        "PACKAGING": "📦",
        "VERIFIED": "🔍",
        "DISPATCHED": "🚚",
        "CANCELLED": "❌"
    }

    STATION_NEXT_ACTIONS = {
        "PENDING": "Cashier: verify payment with '!paid <order_id> <ref>'",
        "PAID": "Warehouse: start boxing with '!pack <order_id>'",
        "PACKAGING": "QA Floor: verify contents with '!verify <order_id>'",
        "VERIFIED": "Dispatch: hand off to rider with '!dispatch <order_id> <courier>'",
        "DISPATCHED": "Order fulfilled. Archived to executive pulse.",
        "CANCELLED": "Order voided."
    }

    @staticmethod
    def create_order(
        customer_name: str,
        items: List[Dict[str, Any]],
        total_amount: float,
        customer_phone: str = "",
        currency: str = "KES",
        notes: str = "",
        shop_slug: str = "leahs-kitchen",
        order_id: Optional[str] = None,
        skip_whatsapp_notify: bool = False
    ) -> Dict[str, Any]:
        """Creates a new incoming order in the initial station and notifies Floor Ops."""
        order_id = order_id or f"ORD-{uuid.uuid4().hex[:6].upper()}"
        now = time.time()
        items_json = json.dumps(items)
        initial_station = PipelineManager.get_initial_station(shop_slug)

        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO orders (
                    order_id, shop_slug, customer_name, customer_phone, items,
                    total_amount, currency, station, payment_ref, courier_name,
                    notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)
            """, (order_id, shop_slug, customer_name, customer_phone, items_json, total_amount, currency, initial_station, notes, now, now))
            conn.commit()
            conn.close()

        # Publish room message
        MessageBroker.publish(
            sender="STOREFRONT_INGRESS",
            target="OPERATIONS",
            topic="ORDER_CREATED",
            payload={
                "order_id": order_id,
                "shop_slug": shop_slug,
                "customer_name": customer_name,
                "total_amount": total_amount,
                "currency": currency,
                "items_count": len(items)
            }
        )

        # Notify Floor Operations Group
        item_summary = ", ".join([f"{i.get('name', 'Item')} (x{i.get('qty', 1)})" for i in items[:3]])
        if len(items) > 3:
            item_summary += f" +{len(items)-3} more"

        st_info = PipelineManager.get_station_info(shop_slug, initial_station) or {}
        st_emoji = st_info.get("emoji", "🟡")
        st_label = st_info.get("label", "PENDING PAYMENT")
        st_cmd = st_info.get("action_command", "!paid")

        ops_card = (
            f"🛒 *[NEW ORDER]* `{order_id}` ({shop_slug})\n"
            f"╭────────────────────────────────╮\n"
            f"  • Customer: {customer_name}\n"
            f"  • Items: {item_summary}\n"
            f"  • Total: {currency} {total_amount:,.2f}\n"
            f"  • Station: {st_emoji} {st_label}\n"
            f"  • Next Step: Action via `{st_cmd}`\n"
            f"╰────────────────────────────────╯\n"
            f"_Reply:_ `{st_cmd} {order_id} <reference>`"
        )
        if not skip_whatsapp_notify:
            dispatch_to_whatsapp_general(ops_card)

            # Also route to the shop-specific Operations WhatsApp Group
            shop_groups = PipelineManager.get_shop_whatsapp_groups(shop_slug)
            shop_ops_jid = shop_groups.get("operations_jid")
            if shop_ops_jid and shop_ops_jid != "120363429929736148@g.us":
                dispatch_to_whatsapp_jid(shop_ops_jid, ops_card)

        return OrderManager.get_order(order_id)

    @staticmethod
    def get_order(order_id: str) -> Optional[Dict[str, Any]]:
        """Fetches single order by ID."""
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM orders WHERE order_id = ?", (order_id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            return None
        d = dict(row)
        try:
            d["items"] = json.loads(d["items"])
        except Exception:
            d["items"] = []
        return d

    @staticmethod
    def advance_station(
        order_id: str,
        new_station: str,
        actor: str = "SYSTEM",
        notes: str = "",
        payment_ref: Optional[str] = None,
        courier_name: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Advances an order through the 5-station operational line."""
        current = OrderManager.get_order(order_id)
        if not current:
            return None

        new_station = new_station.upper()
        shop_slug = current.get("shop_slug", "leahs-kitchen")
        station_info = PipelineManager.get_station_info(shop_slug, new_station)

        # Allow if registered in tenant pipeline or in fallback VALID_STATIONS
        if not station_info and new_station not in OrderManager.VALID_STATIONS and new_station != "COMPLETED":
            raise ValueError(f"Invalid station '{new_station}' for shop '{shop_slug}'.")

        now = time.time()
        updates = ["station = ?", "updated_at = ?"]
        params = [new_station, now]

        if notes:
            updated_notes = f"{current.get('notes', '')}\n[{new_station} by {actor}]: {notes}".strip()
            updates.append("notes = ?")
            params.append(updated_notes)

        if payment_ref:
            updates.append("payment_ref = ?")
            params.append(payment_ref)

        if courier_name:
            updates.append("courier_name = ?")
            params.append(courier_name)

        params.append(order_id)

        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute(f"UPDATE orders SET {', '.join(updates)} WHERE order_id = ?", params)
            conn.commit()
            conn.close()

        # Publish room message
        MessageBroker.publish(
            sender="OPERATIONS_STATION",
            target="ALL",
            topic="ORDER_STATION_CHANGED",
            payload={
                "order_id": order_id,
                "from_station": current["station"],
                "to_station": new_station,
                "actor": actor,
                "payment_ref": payment_ref,
                "courier_name": courier_name
            }
        )

        if station_info:
            emoji = station_info.get("emoji", "🔹")
            cmd = station_info.get("action_command", "!action")
            next_st = station_info.get("next")
            next_step = f"Advance to {next_st} via '{cmd}'" if next_st else "Order fulfilled."
        else:
            emoji = OrderManager.STATION_EMOJIS.get(new_station, "🔹")
            next_step = OrderManager.STATION_NEXT_ACTIONS.get(new_station, "Proceed with pipeline.")

        # Dispatch station handoff card to Operations Group
        ops_msg = (
            f"{emoji} *[STATION HANDOFF]* `{order_id}`\n"
            f"╭────────────────────────────────╮\n"
            f"  • New Station: *{new_station}*\n"
            f"  • Handled By: @{actor}\n"
        )
        if payment_ref:
            ops_msg += f"  • Payment Ref: `{payment_ref}`\n"
        if courier_name:
            ops_msg += f"  • Courier/Rider: *{courier_name}*\n"
        ops_msg += (
            f"  • Next Action: {next_step}\n"
            f"╰────────────────────────────────╯"
        )
        dispatch_to_whatsapp_general(ops_msg)

        # Also route to the shop-specific Operations & Management WhatsApp Groups + Perpetual Admin Oversight
        shop_groups = PipelineManager.get_shop_whatsapp_groups(shop_slug)
        shop_ops_jid = shop_groups.get("operations_jid")
        shop_mgmt_jid = shop_groups.get("management_jid")

        if shop_ops_jid and shop_ops_jid != "120363429929736148@g.us":
            dispatch_to_whatsapp_jid(shop_ops_jid, ops_msg)

        if new_station in ("PAID", "DELIVERED", "COMPLETED", "DISPATCHED", "CANCELLED"):
            dispatch_to_whatsapp_admin(ops_msg)
            if shop_mgmt_jid and shop_mgmt_jid not in (shop_ops_jid, "120363415291701803@g.us"):
                dispatch_to_whatsapp_jid(shop_mgmt_jid, ops_msg)

        return OrderManager.get_order(order_id)

    @staticmethod
    def list_orders(station: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        """Lists recent orders, optionally filtered by station."""
        conn = db.get_connection()
        cursor = conn.cursor()
        if station:
            cursor.execute("SELECT * FROM orders WHERE station = ? ORDER BY created_at DESC LIMIT ?", (station.upper(), limit))
        else:
            cursor.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?", (limit,))
        rows = cursor.fetchall()
        conn.close()

        results = []
        for r in rows:
            d = dict(r)
            try:
                d["items"] = json.loads(d["items"])
            except Exception:
                d["items"] = []
            results.append(d)
        return results

    @staticmethod
    def get_executive_summary() -> Dict[str, Any]:
        """Calculates executive KPI rollups for the shop."""
        conn = db.get_connection()
        cursor = conn.cursor()

        # Total counts by station
        cursor.execute("SELECT station, COUNT(*), SUM(total_amount) FROM orders GROUP BY station")
        rows = cursor.fetchall()

        station_counts = {s: 0 for s in OrderManager.VALID_STATIONS}
        station_revenue = {s: 0.0 for s in OrderManager.VALID_STATIONS}
        total_orders = 0
        total_revenue = 0.0

        for r in rows:
            st = r[0]
            cnt = r[1]
            rev = r[2] or 0.0
            if st in station_counts:
                station_counts[st] = cnt
                station_revenue[st] = rev
            total_orders += cnt
            if st != "CANCELLED":
                total_revenue += rev

        # Fetch recent completed
        cursor.execute("SELECT order_id, customer_name, total_amount, updated_at FROM orders WHERE station = 'DISPATCHED' ORDER BY updated_at DESC LIMIT 5")
        recent_dispatched = [dict(r) for r in cursor.fetchall()]

        conn.close()

        return {
            "total_orders": total_orders,
            "total_revenue": round(total_revenue, 2),
            "station_counts": station_counts,
            "station_revenue": station_revenue,
            "in_flight": station_counts["PENDING"] + station_counts["PAID"] + station_counts["PACKAGING"] + station_counts["VERIFIED"],
            "completed": station_counts["DISPATCHED"],
            "recent_dispatched": recent_dispatched
        }

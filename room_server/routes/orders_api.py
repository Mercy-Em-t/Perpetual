"""
Orders & Operational Station API Blueprint
Ingests store webhooks, coordinates 5-station operational handoffs, and computes rollups.
"""

from datetime import datetime, timezone, timedelta
from flask import Blueprint, request, jsonify
from room_server.models.order import OrderManager
from room_server.models.pipeline import PipelineManager
from room_server.services.whatsapp_notifier import dispatch_to_whatsapp_admin

orders_bp = Blueprint("orders_api", __name__, url_prefix="/api/orders")

EAT_TZ = timezone(timedelta(hours=3))


@orders_bp.route("/shops", methods=["GET"])
def list_configured_shops():
    """Lists all active shops, their currencies, WhatsApp groups, and pipeline stations."""
    shops = PipelineManager.list_all_shops()
    return jsonify({"shops": shops, "count": len(shops)})


@orders_bp.route("/validate-cutoff", methods=["POST", "GET"])
def validate_kitchen_cutoff():
    """Evaluates whether the current EAT time is within the 17:00 + 15m grace window."""
    now_eat = datetime.now(EAT_TZ)
    hour = now_eat.hour
    minute = now_eat.minute
    is_past_cutoff = (hour > 17) or (hour == 17 and minute > 15)
    return jsonify({
        "current_time_eat": now_eat.strftime("%H:%M:%S"),
        "is_scheduled_for_today": not is_past_cutoff,
        "batch_day": "TODAY" if not is_past_cutoff else "TOMORROW",
        "warning": "Order placed after 17:00 EAT. Scheduled for tomorrow's batch." if is_past_cutoff else None
    })


@orders_bp.route("/pipeline/<shop_slug>", methods=["GET"])
def get_shop_pipeline(shop_slug):
    """Returns the dynamic station pipeline definition for a specific shop."""
    pipeline = PipelineManager.get_shop_pipeline(shop_slug)
    if not pipeline:
        return jsonify({"error": f"Pipeline configuration for '{shop_slug}' not found"}), 404
    return jsonify(pipeline)


@orders_bp.route("/webhook", methods=["POST"])
def ingest_order_webhook():
    """
    Webhook receiver for incoming orders from Storefront / POS.
    """
    data = request.get_json(silent=True) or {}
    customer_name = data.get("customer_name")
    if not customer_name:
        return jsonify({"error": "Missing required field 'customer_name'"}), 400

    items = data.get("items", [])
    total_amount = float(data.get("total_amount", 0.0))
    customer_phone = data.get("customer_phone", "")
    currency = data.get("currency", "KES")
    notes = data.get("notes", "")
    shop_slug = data.get("shop_slug", "leahs-kitchen")

    order = OrderManager.create_order(
        customer_name=customer_name,
        customer_phone=customer_phone,
        items=items,
        total_amount=total_amount,
        currency=currency,
        notes=notes,
        shop_slug=shop_slug
    )

    return jsonify({"status": "success", "order": order}), 201


@orders_bp.route("/<order_id>/station", methods=["POST"])
def advance_order_station(order_id):
    """
    Advances order station (PENDING -> PAID -> PACKAGING -> VERIFIED -> DISPATCHED).
    Payload:
    {
        "station": "PAID",
        "actor": "Cashier_John",
        "payment_ref": "MPESA-XYZ123",
        "courier_name": "Dennis Rider",
        "notes": "Payment confirmed via M-Pesa"
    }
    """
    data = request.get_json(silent=True) or {}
    new_station = data.get("station")
    if not new_station:
        return jsonify({"error": "Missing required field 'station'"}), 400

    actor = data.get("actor", "OPERATOR")
    notes = data.get("notes", "")
    payment_ref = data.get("payment_ref")
    courier_name = data.get("courier_name")

    try:
        updated = OrderManager.advance_station(
            order_id=order_id,
            new_station=new_station,
            actor=actor,
            notes=notes,
            payment_ref=payment_ref,
            courier_name=courier_name
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if not updated:
        return jsonify({"error": f"Order '{order_id}' not found"}), 404

    return jsonify({"status": "success", "order": updated}), 200


@orders_bp.route("/<order_id>/confirm-receipt", methods=["POST"])
def customer_confirm_receipt(order_id):
    """
    Called by the customer from the web storefront or WhatsApp to confirm receipt of the delivery.
    Advances order from DELIVERED to COMPLETED.
    """
    order = OrderManager.get_order(order_id)
    if not order:
        return jsonify({"error": "Order not found"}), 404

    data = request.get_json(silent=True) or {}
    notes = data.get("notes", "Customer confirmed receipt via Storefront tracker")

    try:
        updated = OrderManager.advance_station(
            order_id=order_id,
            new_station="COMPLETED",
            actor="CUSTOMER",
            notes=notes
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"status": "success", "order": updated, "message": "Delivery confirmed and completed!"}), 200


@orders_bp.route("", methods=["GET"])
def list_orders():
    """Lists orders with optional station query param."""
    station = request.args.get("station")
    limit = int(request.args.get("limit", 50))
    orders = OrderManager.list_orders(station=station, limit=limit)
    return jsonify({"orders": orders, "count": len(orders)})


@orders_bp.route("/<order_id>", methods=["GET"])
def get_order(order_id):
    """Retrieves order detail."""
    order = OrderManager.get_order(order_id)
    if not order:
        return jsonify({"error": "Order not found"}), 404
    return jsonify({"order": order})


@orders_bp.route("/summary", methods=["GET"])
def get_summary():
    """Returns real-time executive KPI rollups."""
    summary = OrderManager.get_executive_summary()
    return jsonify({"summary": summary})


@orders_bp.route("/pulse", methods=["POST"])
def trigger_executive_pulse():
    """Dispatches on-demand executive pulse card to the Admin Oversight Group."""
    summary = OrderManager.get_executive_summary()
    st = summary["station_counts"]

    pulse_card = (
        f"📊 *Executive Shop Pulse — Real-Time Rollup*\n"
        f"╭────────────────────────────────────────╮\n"
        f"  • Total Revenue: ${summary['total_revenue']:,.2f}\n"
        f"  • Total Orders Today: {summary['total_orders']}\n"
        f"  • Active In-Flight: {summary['in_flight']} orders\n"
        f"    ├─ 🟡 Pending Pay: {st['PENDING']}\n"
        f"    ├─ 💳 Paid/Intake: {st['PAID']}\n"
        f"    ├─ 📦 Packaging:   {st['PACKAGING']}\n"
        f"    └─ 🔍 Quality QA:  {st['VERIFIED']}\n"
        f"  • Completed/Dispatched: {summary['completed']}\n"
        f"╰────────────────────────────────────────╯\n"
        f"_Floor stations operating with 0 dropped frames._"
    )
    dispatch_to_whatsapp_admin(pulse_card)

    return jsonify({"status": "success", "dispatched_to": "adminOversight", "summary": summary})

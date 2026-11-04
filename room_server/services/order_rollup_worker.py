"""
Executive Order Rollup Worker
Periodically computes shop metrics and posts aggregated pulse cards to Executive Oversight.
Decouples high-volume floor transactions from executive communication.
"""

import sys
import time
import threading
from room_server.models.order import OrderManager
from room_server.services.whatsapp_notifier import dispatch_to_whatsapp_admin

_rollup_thread = None
_running = False


def _rollup_loop(interval_seconds=3600):
    """Executes periodic rollup and dispatches to Executive Oversight group."""
    from datetime import datetime, timezone, timedelta
    eat_tz = timezone(timedelta(hours=3))

    while _running:
        try:
            summary = OrderManager.get_executive_summary()
            today_orders = summary.get("today_orders", 0)
            in_flight = summary.get("in_flight", 0)
            currency = summary.get("currency", "KES")

            # Only dispatch pulse if there are active in-flight orders or orders today
            if today_orders > 0 or in_flight > 0:
                st = summary["station_counts"]
                now_str = datetime.now(eat_tz).strftime("%H:%M")
                pulse_card = (
                    f"📊 *Executive Shop Pulse — {now_str} Scheduled Rollup*\n"
                    f"╭────────────────────────────────────────╮\n"
                    f"  • Today's Revenue: {currency} {summary['today_revenue']:,.2f}\n"
                    f"  • Today's Orders:  {today_orders}\n"
                    f"  • In-Flight: {in_flight} | Today Completed: {summary['today_completed']}\n"
                    f"  • Stations Breakdown:\n"
                    f"    ├─ 🟡 Pending:   {st.get('PENDING', 0)}\n"
                    f"    ├─ 💳 Paid:      {st.get('PAID', 0)}\n"
                    f"    ├─ 📦 Packing:   {st.get('PACKAGING', 0)}\n"
                    f"    └─ 🔍 QA Floor:  {st.get('VERIFIED', 0)}\n"
                    f"  • Cumulative Volume: {currency} {summary['total_revenue']:,.2f} ({summary['total_orders']} orders)\n"
                    f"╰────────────────────────────────────────╯\n"
                    f"_Automated container aggregation daemon._"
                )
                dispatch_to_whatsapp_admin(pulse_card)
        except Exception as e:
            sys.stderr.write(f"[Order Rollup Worker Error] {e}\n")

        # Sleep in chunks to allow fast clean shutdown
        slept = 0
        while _running and slept < interval_seconds:
            time.sleep(min(5, interval_seconds - slept))
            slept += 5


def start_order_rollup(interval_seconds=3600):
    global _rollup_thread, _running
    if _rollup_thread is not None and _rollup_thread.is_alive():
        return _rollup_thread

    _running = True
    _rollup_thread = threading.Thread(
        target=_rollup_loop,
        args=(interval_seconds,),
        daemon=True,
        name="OrderRollupWorkerThread"
    )
    _rollup_thread.start()
    return _rollup_thread


def stop_order_rollup():
    global _running
    _running = False

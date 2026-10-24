"""
WhatsApp Notifier Service
Asynchronously dispatches events to the Baileys WhatsApp Gateway on port 5174:
- dispatch_to_whatsapp_task -> 'perpetua' (General Feed)
- dispatch_to_whatsapp_error -> 'Perpetua - IT Helpdesk' (Incident/Rollback alerts)
- dispatch_to_whatsapp_admin -> 'Perpetua - Admin Oversight' (Audit logs)
"""

import json
import os
import threading
import time
import urllib.request

GATEWAY_BASE_URL = "http://127.0.0.1:5174"
_recent_dispatches = {}
_lock = threading.Lock()


def _is_throttled(key, window_seconds=15):
    now = time.time()
    with _lock:
        last = _recent_dispatches.get(key, 0)
        if now - last < window_seconds:
            return True
        _recent_dispatches[key] = now
        return False


def _async_post(url_path, payload):
    # Check if disabled during tests
    if os.environ.get("DISABLE_WHATSAPP_DISPATCH", "").lower() in ("true", "1", "yes"):
        return

    # De-duplicate identical alerts within 15 seconds
    throttle_key = f"{url_path}:{payload.get('task_id')}:{payload.get('status') or payload.get('title')}"
    if _is_throttled(throttle_key):
        return

    def _worker():
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{GATEWAY_BASE_URL}{url_path}",
                data=data,
                headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass
    threading.Thread(target=_worker, daemon=True).start()


def dispatch_to_whatsapp_task(title, status, task_id=None, details=None):
    """Dispatches general task updates to group 'perpetua'"""
    _async_post("/api/broadcast-task", {
        "title": title,
        "status": status,
        "task_id": task_id,
        "ambient_context": details or {}
    })


def dispatch_to_whatsapp_error(error_type, title, task_id=None, error_details=None):
    """Dispatches error traces & timeout rollbacks to 'Perpetua - IT Helpdesk'"""
    _async_post("/api/broadcast-error", {
        "error_type": error_type,
        "title": title,
        "task_id": task_id,
        "error_details": error_details or ""
    })


def dispatch_to_whatsapp_admin(action, actor="SYSTEM", task_id=None, details=None):
    """Dispatches audit logs & executive actions to 'Perpetua - Admin Oversight'"""
    if isinstance(action, str) and not task_id and not details:
        # Direct text message card format
        _async_post("/api/notify-group", {
            "group": "adminOversight",
            "message": action
        })
        return

    _async_post("/api/broadcast-admin", {
        "action": action,
        "actor": actor,
        "task_id": task_id,
        "details": details or ""
    })


def dispatch_to_whatsapp_general(message_text):
    """Directly dispatches formatted message card to operations group 'perpetua'"""
    _async_post("/api/notify-group", {
        "group": "general",
        "message": message_text
    })


# Backwards compatibility alias
dispatch_to_whatsapp_async = dispatch_to_whatsapp_task

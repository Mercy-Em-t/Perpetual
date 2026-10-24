"""
Background Lease Timeout Reconciler Service
Runs a periodic daemon thread ensuring expired task claims roll back to PENDING.
"""

import sys
import time
import threading

_monitor_thread = None
_running = False


def _background_worker(interval_seconds=5):
    from room_server.models.task import TaskManager
    while _running:
        try:
            TaskManager.reconcile_timeouts()
        except Exception as e:
            sys.stderr.write(f"[Timeout Reconciler Error] {e}\n")
        time.sleep(interval_seconds)


def start_reconciler(interval_seconds=5):
    global _monitor_thread, _running
    if _monitor_thread is not None and _monitor_thread.is_alive():
        return _monitor_thread

    _running = True
    _monitor_thread = threading.Thread(
        target=_background_worker,
        args=(interval_seconds,),
        daemon=True,
        name="TaskTimeoutReconcilerThread"
    )
    _monitor_thread.start()
    return _monitor_thread


def stop_reconciler():
    global _running
    _running = False

"""
Enterprise Event Bus & WhatsApp Microservice Bridge (Python Port)
Directly adapted from the Java Enterprise Systems Architecture & R&D Suite.
Features:
- Immutable RoomEvent dataclass
- Non-blocking ThreadPoolExecutor dispatch
- Dead Letter Queue (DLQ) for network resilience
- Idempotent deduplication cache (15s sliding TTL)
- Ant/glob wildcard topic subscription matcher
- Automatic triggers for TASK, DRIVE, TIMEOUT, and ORDER events
"""

import os
import sys
import time
import json
import uuid
import fnmatch
import threading
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, List, Optional, Callable


@dataclass(frozen=True)
class RoomEvent:
    """Immutable Event Record mirroring com.perpetual.eventbus.model.RoomEvent"""
    topic: str
    sender: str
    target: str = "ALL"
    payload: Dict[str, Any] = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: f"evt_{uuid.uuid4().hex[:12]}")
    epoch_millis: int = field(default_factory=lambda: int(time.time() * 1000))
    trace_id: str = field(default_factory=lambda: f"trc_{uuid.uuid4().hex[:8]}")


@dataclass
class DeadLetterRecord:
    """Dead Letter Queue Record for unhandled or failed dispatches"""
    event: RoomEvent
    subscriber_id: str
    error: str
    timestamp: float


class EventSubscriber:
    """Abstract Event Subscriber Contract mirroring Java EventSubscriber"""
    def __init__(self, subscriber_id: str, topic_pattern: str = "*"):
        self.subscriber_id = subscriber_id
        self.topic_pattern = topic_pattern

    def matches(self, topic: str) -> bool:
        if self.topic_pattern in ("*", "**", "ALL"):
            return True
        return fnmatch.fnmatchcase(topic.upper(), self.topic_pattern.upper())

    def on_event(self, event: RoomEvent) -> None:
        raise NotImplementedError

    def on_error(self, event: RoomEvent, error: Exception) -> None:
        sys.stderr.write(f"[Subscriber {self.subscriber_id} Error] Failed on {event.event_id}: {error}\n")


class EnterpriseEventBus:
    """
    Enterprise In-Memory Reactive Event Bus.
    Python equivalent of Java ReactorEventBus.
    """
    def __init__(self, max_workers: int = 4, dedup_window_seconds: float = 15.0):
        self._subscribers: List[EventSubscriber] = []
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="EventBusWorker")
        self._dlq = deque(maxlen=1000)
        self._dedup_cache: Dict[str, float] = {}
        self._dedup_window = dedup_window_seconds

    def register(self, subscriber: EventSubscriber) -> None:
        with self._lock:
            if subscriber not in self._subscribers:
                self._subscribers.append(subscriber)

    def unregister(self, subscriber: EventSubscriber) -> None:
        with self._lock:
            if subscriber in self._subscribers:
                self._subscribers.remove(subscriber)

    def publish_async(self, event: RoomEvent):
        """Asynchronous non-blocking publish returning immediately."""
        return self._executor.submit(self.publish_sync, event)

    def publish_sync(self, event: RoomEvent) -> None:
        """Synchronous publish executing subscribers."""
        # 1. Deduplication / throttling check
        now = time.time()
        dedup_key = f"{event.topic}:{event.sender}:{hash(str(event.payload))}"
        with self._lock:
            last_seen = self._dedup_cache.get(dedup_key, 0)
            if now - last_seen < self._dedup_window:
                # Suppress duplicate event within window
                return
            self._dedup_cache[dedup_key] = now

            # Clean old dedup keys periodically
            if len(self._dedup_cache) > 200:
                self._dedup_cache = {k: v for k, v in self._dedup_cache.items() if now - v < self._dedup_window}

            matched_subs = [s for s in self._subscribers if s.matches(event.topic)]

        # 2. Dispatch to subscribers
        for sub in matched_subs:
            try:
                sub.on_event(event)
            except Exception as e:
                with self._lock:
                    self._dlq.append(DeadLetterRecord(event, sub.subscriber_id, str(e), now))
                sub.on_error(event, e)

    @property
    def dead_letter_queue(self) -> List[DeadLetterRecord]:
        with self._lock:
            return list(self._dlq)

    def clear_dlq(self) -> None:
        with self._lock:
            self._dlq.clear()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False)


class WhatsAppBridgeSubscriber(EventSubscriber):
    """
    Automatic Room Trigger Subscriber.
    Forwards TASK_*, DRIVE_*, TIMEOUT_*, ORDER_*, and TICKET_* events
    directly to the appropriate WhatsApp Departmental Group.
    """
    def __init__(self, gateway_url: str = "http://127.0.0.1:5174"):
        super().__init__(subscriber_id="WHATSAPP_DEPARTMENT_BRIDGE", topic_pattern="*")
        self.gateway_url = gateway_url.rstrip("/")

    def on_event(self, event: RoomEvent) -> None:
        if os.environ.get("DISABLE_WHATSAPP_DISPATCH", "").lower() in ("true", "1", "yes"):
            return

        topic = event.topic
        payload = event.payload

        # -------------------------------------------------------------------
        # 1. Operational Department: Floor Operations ('perpetua')
        # Receives RAW, low-level telemetry with all parameters & context
        # -------------------------------------------------------------------
        if topic in ("TASK_CREATED", "TASK_STATE_CHANGED", "DRIVE_IMAGE_INGEST", "DRIVE_IMAGE_RECEIVED", "ASSET_INSTANTIATED"):
            state = payload.get("new_state") or payload.get("status") or topic.replace("TASK_", "")
            title = payload.get("title") or f"Room Event: {topic}"
            task_id = payload.get("task_id") or payload.get("asset_id") or event.event_id
            claimed_by = payload.get("claimed_by") or payload.get("assigned_to") or "Unassigned"

            icon = "✅" if state == "DONE" else "🟣" if state == "IN_PROGRESS" else "🔵" if state == "CLAIMED" else "🟡"
            raw_ops_card = (
                f"{icon} *[FLOOR TELEMETRY: RAW]* `{task_id}`\n"
                f"╭────────────────────────────────╮\n"
                f"  • Event: *{topic}*\n"
                f"  • Title: {title}\n"
                f"  • State: *{state}*\n"
                f"  • Worker/Agent: @{claimed_by}\n"
                f"  • Sender: {event.sender}\n"
                f"  • Raw Payload: {json.dumps(payload)[:160]}\n"
                f"╰────────────────────────────────╯\n"
                f"_Trace: {event.trace_id}_"
            )
            self._dispatch_http("general", raw_ops_card)

            # -------------------------------------------------------------------
            # Also dispatch MINIMAL task assignment alert to Admin Oversight
            # Admin only needs: Tasks sent & To who (clean, no clutter)
            # -------------------------------------------------------------------
            if topic in ("TASK_CREATED", "TASK_STATE_CHANGED") and state in ("CLAIMED", "IN_PROGRESS", "PENDING"):
                admin_task_card = (
                    f"📌 *Task Dispatched*\n"
                    f"• *Task:* `{task_id}`\n"
                    f"• *Sent To:* @{claimed_by}\n"
                    f"• *Title:* {title}\n"
                    f"• *State:* {state}\n\n"
                    f"_For full details, reply:_ `!details {task_id}`"
                )
                self._dispatch_http("adminOversight", admin_task_card)

        # -------------------------------------------------------------------
        # 2. Quality Desk: IT Helpdesk ('Perpetua - IT Helpdesk')
        # -------------------------------------------------------------------
        elif topic in ("TIMEOUT_ROLLBACK", "TASK_TIMEOUT_ROLLBACK", "LEASE_EXPIRED", "SERVER_ERROR", "TICKET_CREATED"):
            title = payload.get("title") or f"Incident: {topic}"
            task_id = payload.get("task_id", "N/A")
            card = (
                f"🚨 *[AUTOMATIC IT TRIGGER]*\n"
                f"╭────────────────────────────────╮\n"
                f"  • Incident: *{topic}*\n"
                f"  • Details: {title}\n"
                f"  • Task: `{task_id}`\n"
                f"  • Sender: {event.sender}\n"
                f"╰────────────────────────────────╯\n"
                f"_Auto-escalated to IT Helpdesk._"
            )
            self._dispatch_http("itHelpdesk", card)

        # -------------------------------------------------------------------
        # 3. Executive Oversight ('Perpetua - Admin Oversight')
        # -------------------------------------------------------------------
        elif topic in ("EXECUTIVE_PULSE", "HOURLY_ROLLUP", "TICKET_RESOLVED", "ADMIN_AUDIT"):
            card = (
                f"📊 *[EXECUTIVE TRIGGER]*\n"
                f"╭────────────────────────────────╮\n"
                f"  • Audit: *{topic}*\n"
                f"  • Actor: {payload.get('actor') or event.sender}\n"
                f"  • Timestamp: {event.epoch_millis}\n"
                f"╰────────────────────────────────╯\n"
                f"_Trace: {event.trace_id}_"
            )
            self._dispatch_http("adminOversight", card)

    def _dispatch_http(self, group_key: str, message_text: str) -> None:
        url = f"{self.gateway_url}/api/notify-group"
        body = json.dumps({"group": group_key, "message": message_text}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                pass
        except Exception as e:
            # Re-raise to trigger DLQ handling in EnterpriseEventBus
            raise RuntimeError(f"HTTP dispatch to {group_key} failed: {e}")


# Initialize global enterprise event bus and attach WhatsApp bridge
event_bus = EnterpriseEventBus(max_workers=4, dedup_window_seconds=15.0)
whatsapp_bridge = WhatsAppBridgeSubscriber()
event_bus.register(whatsapp_bridge)

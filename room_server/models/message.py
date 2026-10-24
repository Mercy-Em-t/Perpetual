"""
Pub/Sub Message Broker Model
Manages inter-agent message logs and broadcast forwarders.
"""

import time
import uuid
import json
from datetime import datetime
from room_server.db import db
from room_server.services.event_bus import event_bus, RoomEvent


class MessageBroker:
    @staticmethod
    def publish(sender, target="ALL", topic="GENERAL", payload=None):
        msg_id = f"msg_{uuid.uuid4().hex[:10]}"
        now = time.time()
        payload_data = payload or {}
        payload_json = json.dumps(payload_data)

        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO messages (message_id, sender, target, topic, payload, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (msg_id, sender, target, topic, payload_json, now))
            conn.commit()
            conn.close()

        # Non-blocking reactive dispatch via Enterprise Event Bus
        # Triggers: TASK_CREATED, TASK_STATE_CHANGED, DRIVE_IMAGE_INGEST, TIMEOUT_ROLLBACK
        event = RoomEvent(
            topic=topic,
            sender=sender,
            target=target,
            payload=payload_data,
            event_id=msg_id,
            epoch_millis=int(now * 1000)
        )
        event_bus.publish_async(event)

        return {
            "message_id": msg_id,
            "sender": sender,
            "target": target,
            "topic": topic,
            "payload": payload_data,
            "timestamp": now,
            "formatted_time": datetime.fromtimestamp(now).strftime("%H:%M:%S")
        }

    @staticmethod
    def get_messages(target=None, sender=None, topic=None, since=None, limit=50):
        conn = db.get_connection()
        cursor = conn.cursor()
        query = "SELECT * FROM messages WHERE 1=1"
        params = []

        if target:
            query += " AND (target = ? OR target = 'ALL')"
            params.append(target)
        if sender:
            query += " AND sender = ?"
            params.append(sender)
        if topic:
            query += " AND topic = ?"
            params.append(topic)
        if since:
            query += " AND timestamp > ?"
            params.append(float(since))

        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()

        result = []
        for r in reversed(rows):  # Chronological order
            d = dict(r)
            try:
                d["payload"] = json.loads(d["payload"])
            except Exception:
                pass
            d["formatted_time"] = datetime.fromtimestamp(d["timestamp"]).strftime("%H:%M:%S")
            result.append(d)
        return result

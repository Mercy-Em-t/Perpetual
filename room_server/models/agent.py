"""
Agent Registry Model
Tracks active agent heartbeats, status, and active tasks.
"""

import time
import json
from datetime import datetime
from room_server.db import db, AGENT_OFFLINE_THRESHOLD_SECONDS


class AgentRegistry:
    @staticmethod
    def heartbeat(agent_id, name=None, status=None, metadata=None):
        now = time.time()
        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM agents WHERE agent_id = ?", (agent_id,))
            existing = cursor.fetchone()

            agent_name = name or (existing["name"] if existing else agent_id)
            agent_status = status or (existing["status"] if existing else "IDLE")
            meta_json = json.dumps(metadata) if metadata else (existing["metadata"] if existing else "{}")

            cursor.execute("""
                INSERT INTO agents (agent_id, name, status, current_task_id, last_heartbeat, metadata)
                VALUES (?, ?, ?, NULL, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                    name = excluded.name,
                    status = excluded.status,
                    last_heartbeat = excluded.last_heartbeat,
                    metadata = excluded.metadata
            """, (agent_id, agent_name, agent_status, now, meta_json))
            conn.commit()
            conn.close()

    @staticmethod
    def list_agents():
        now = time.time()
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM agents ORDER BY last_heartbeat DESC")
        rows = cursor.fetchall()
        conn.close()

        agents = []
        for r in rows:
            d = dict(r)
            try:
                d["metadata"] = json.loads(d["metadata"])
            except Exception:
                pass
            seconds_inactive = now - d["last_heartbeat"]
            d["is_online"] = seconds_inactive <= AGENT_OFFLINE_THRESHOLD_SECONDS
            d["seconds_since_heartbeat"] = int(seconds_inactive)
            d["formatted_last_seen"] = datetime.fromtimestamp(d["last_heartbeat"]).strftime("%H:%M:%S")
            agents.append(d)
        return agents

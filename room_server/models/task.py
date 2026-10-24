"""
ASADF Task State Machine Model
Implements 5-stage lifecycle:
PENDING -> CLAIMED -> IN_PROGRESS -> VERIFIED -> DONE
with 60-second claim leases, automatic timeout rollbacks, and Helpdesk notifications.
"""

import time
import uuid
import json
from room_server.db import db, CLAIM_TIMEOUT_SECONDS
from room_server.models.message import MessageBroker
from room_server.models.ticket import TicketManager
from room_server.services.whatsapp_notifier import dispatch_to_whatsapp_error, dispatch_to_whatsapp_admin


class TaskManager:
    VALID_STATES = ("PENDING", "CLAIMED", "IN_PROGRESS", "VERIFIED", "DONE")

    @staticmethod
    def reconcile_timeouts():
        """Roll back expired CLAIMED or IN_PROGRESS tasks whose lease exceeded claim_timeout_seconds."""
        now = time.time()
        rolled_back_tasks = []

        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()

            cursor.execute("""
                SELECT task_id, title, claimed_by, claimed_at, claim_timeout_seconds, state
                FROM tasks
                WHERE state IN ('CLAIMED', 'IN_PROGRESS')
            """)
            rows = cursor.fetchall()

            for row in rows:
                elapsed = now - (row["claimed_at"] or now)
                timeout_limit = row["claim_timeout_seconds"] or CLAIM_TIMEOUT_SECONDS
                if elapsed > timeout_limit:
                    cursor.execute("""
                        UPDATE tasks
                        SET state = 'PENDING',
                            claimed_by = NULL,
                            claimed_at = NULL,
                            updated_at = ?
                        WHERE task_id = ?
                    """, (now, row["task_id"]))

                    # Reset agent current task if needed
                    if row["claimed_by"]:
                        cursor.execute("""
                            UPDATE agents
                            SET status = 'IDLE', current_task_id = NULL
                            WHERE agent_id = ? AND current_task_id = ?
                        """, (row["claimed_by"], row["task_id"]))

                    rolled_back_tasks.append((row["task_id"], row["title"], row["claimed_by"], row["state"]))

            conn.commit()
            conn.close()

        for tid, title, agent, old_state in rolled_back_tasks:
            MessageBroker.publish(
                sender="SYSTEM_ASADF",
                target="ALL",
                topic="TASK_TIMEOUT_ROLLBACK",
                payload={
                    "task_id": tid,
                    "title": title,
                    "abandoned_by": agent,
                    "previous_state": old_state,
                    "new_state": "PENDING",
                    "reason": f"Claim lease timed out (> {CLAIM_TIMEOUT_SECONDS}s)"
                }
            )

            # Alert IT Helpdesk group
            dispatch_to_whatsapp_error(
                error_type="LEASE_TIMEOUT_ROLLBACK",
                title=f"Claim Lease Timed Out: {title}",
                task_id=tid,
                error_details=f"Agent '{agent}' abandoned task after {CLAIM_TIMEOUT_SECONDS}s lease. Reverted from {old_state} -> PENDING."
            )

            # Auto-register an Incident Ticket in IT Helpdesk
            TicketManager.create_ticket(
                title=f"Lease Timeout: {title}",
                description=f"Task {tid} ({title}) timed out while claimed by agent '{agent}'. State reset to PENDING.",
                reported_by="SYSTEM_ASADF",
                severity="HIGH",
                associated_task_id=tid
            )

    @staticmethod
    def create_task(title, task_type="GENERAL", priority=2, payload=None):
        TaskManager.reconcile_timeouts()
        task_id = f"task_{uuid.uuid4().hex[:8]}"
        now = time.time()
        payload_json = json.dumps(payload or {})

        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO tasks (
                    task_id, title, task_type, state, priority,
                    claimed_by, claimed_at, claim_timeout_seconds,
                    payload, result, created_at, updated_at
                ) VALUES (?, ?, ?, 'PENDING', ?, NULL, NULL, ?, ?, '{}', ?, ?)
            """, (task_id, title, task_type, priority, CLAIM_TIMEOUT_SECONDS, payload_json, now, now))
            conn.commit()
            conn.close()

        MessageBroker.publish(
            sender="SYSTEM_ASADF",
            target="ALL",
            topic="TASK_CREATED",
            payload={"task_id": task_id, "title": title, "task_type": task_type, "priority": priority}
        )
        return TaskManager.get_task(task_id)

    @staticmethod
    def get_task(task_id):
        TaskManager.reconcile_timeouts()
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            return None
        return TaskManager._row_to_dict(row)

    @staticmethod
    def list_tasks(state=None, agent_id=None, limit=100):
        TaskManager.reconcile_timeouts()
        conn = db.get_connection()
        cursor = conn.cursor()
        query = "SELECT * FROM tasks WHERE 1=1"
        params = []
        if state:
            query += " AND state = ?"
            params.append(state.upper())
        if agent_id:
            query += " AND claimed_by = ?"
            params.append(agent_id)
        query += " ORDER BY priority DESC, created_at DESC LIMIT ?"
        params.append(limit)

        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        return [TaskManager._row_to_dict(r) for r in rows]

    @staticmethod
    def transition(task_id, action, agent_id=None, result=None, notes=None):
        """
        Executes ASADF state transition:
        - action='claim'    : PENDING -> CLAIMED (agent_id required)
        - action='start'    : CLAIMED -> IN_PROGRESS (agent_id required)
        - action='heartbeat': Keep CLAIMED or IN_PROGRESS alive, reset claimed_at to now
        - action='verify'   : IN_PROGRESS -> VERIFIED (agent_id required, result optional)
        - action='complete' : VERIFIED -> DONE (or direct from IN_PROGRESS)
        - action='release'  : CLAIMED/IN_PROGRESS -> PENDING
        - action='reject'   : VERIFIED -> PENDING or IN_PROGRESS
        """
        TaskManager.reconcile_timeouts()
        now = time.time()

        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,))
            row = cursor.fetchone()
            if not row:
                conn.close()
                return False, f"Task {task_id} not found."

            current_state = row["state"]
            current_claimer = row["claimed_by"]

            new_state = current_state
            new_claimed_by = current_claimer
            new_claimed_at = row["claimed_at"]
            task_result = json.loads(row["result"] or "{}")

            if result is not None:
                if isinstance(result, dict):
                    task_result.update(result)
                else:
                    task_result["value"] = result

            if action == "claim":
                if current_state != "PENDING":
                    conn.close()
                    return False, f"Cannot claim task in '{current_state}' state. Must be 'PENDING'."
                if not agent_id:
                    conn.close()
                    return False, "agent_id is required to claim a task."
                new_state = "CLAIMED"
                new_claimed_by = agent_id
                new_claimed_at = now

            elif action == "start":
                if current_state != "CLAIMED":
                    conn.close()
                    return False, f"Cannot start task in '{current_state}' state. Must be 'CLAIMED'."
                if agent_id and current_claimer and agent_id != current_claimer:
                    conn.close()
                    return False, f"Task claimed by {current_claimer}, not {agent_id}."
                new_state = "IN_PROGRESS"
                new_claimed_at = now

            elif action == "heartbeat":
                if current_state not in ("CLAIMED", "IN_PROGRESS"):
                    conn.close()
                    return False, f"Heartbeat only valid for CLAIMED or IN_PROGRESS tasks."
                new_claimed_at = now

            elif action == "verify":
                if current_state != "IN_PROGRESS":
                    conn.close()
                    return False, f"Cannot verify task in '{current_state}' state. Must be 'IN_PROGRESS'."
                new_state = "VERIFIED"

            elif action == "complete":
                if current_state not in ("VERIFIED", "IN_PROGRESS"):
                    conn.close()
                    return False, f"Cannot complete task from '{current_state}' state."
                new_state = "DONE"

            elif action == "release":
                if current_state not in ("CLAIMED", "IN_PROGRESS"):
                    conn.close()
                    return False, f"Cannot release task from '{current_state}' state."
                new_state = "PENDING"
                new_claimed_by = None
                new_claimed_at = None

            elif action == "reject":
                new_state = "PENDING"
                new_claimed_by = None
                new_claimed_at = None

            else:
                conn.close()
                return False, f"Unknown action '{action}'."

            # Update DB
            cursor.execute("""
                UPDATE tasks
                SET state = ?,
                    claimed_by = ?,
                    claimed_at = ?,
                    result = ?,
                    updated_at = ?
                WHERE task_id = ?
            """, (new_state, new_claimed_by, new_claimed_at, json.dumps(task_result), now, task_id))

            # Keep agent table in sync
            if new_claimed_by:
                agent_status = "BUSY" if new_state in ("CLAIMED", "IN_PROGRESS") else "IDLE"
                cursor.execute("""
                    INSERT INTO agents (agent_id, name, status, current_task_id, last_heartbeat, metadata)
                    VALUES (?, ?, ?, ?, ?, '{}')
                    ON CONFLICT(agent_id) DO UPDATE SET
                        status = excluded.status,
                        current_task_id = excluded.current_task_id,
                        last_heartbeat = excluded.last_heartbeat
                """, (new_claimed_by, new_claimed_by, agent_status, task_id if agent_status == "BUSY" else None, now))
            elif current_claimer:
                cursor.execute("""
                    UPDATE agents
                    SET status = 'IDLE', current_task_id = NULL
                    WHERE agent_id = ? AND current_task_id = ?
                """, (current_claimer, task_id))

            conn.commit()
            conn.close()

        # Broadcast state transition
        MessageBroker.publish(
            sender=agent_id or "SYSTEM_ASADF",
            target="ALL",
            topic="TASK_STATE_CHANGED",
            payload={
                "task_id": task_id,
                "action": action,
                "previous_state": current_state,
                "new_state": new_state,
                "agent_id": new_claimed_by,
                "notes": notes
            }
        )

        if action in ("complete", "release"):
            dispatch_to_whatsapp_admin(
                action=f"TASK_{action.upper()}",
                actor=agent_id or "SYSTEM",
                task_id=task_id,
                details=f"Task transitioned from {current_state} -> {new_state}"
            )

        return True, TaskManager.get_task(task_id)

    @staticmethod
    def _row_to_dict(row):
        d = dict(row)
        try:
            d["payload"] = json.loads(d["payload"]) if d["payload"] else {}
        except Exception:
            pass
        try:
            d["result"] = json.loads(d["result"]) if d["result"] else {}
        except Exception:
            pass
        # Calculate remaining claim lease time in seconds
        if d["state"] in ("CLAIMED", "IN_PROGRESS") and d.get("claimed_at"):
            elapsed = time.time() - d["claimed_at"]
            timeout_limit = d.get("claim_timeout_seconds", CLAIM_TIMEOUT_SECONDS)
            d["lease_remaining_seconds"] = max(0, int(timeout_limit - elapsed))
        else:
            d["lease_remaining_seconds"] = None
        return d

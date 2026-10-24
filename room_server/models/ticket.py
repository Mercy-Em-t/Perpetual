"""
IT Helpdesk Incident Ticket Model
Handles incident lifecycle, auto-generation from timeout rollbacks, and WhatsApp dispatch.
"""

import time
import uuid
from datetime import datetime
from room_server.db import db
from room_server.models.message import MessageBroker
from room_server.services.whatsapp_notifier import dispatch_to_whatsapp_error, dispatch_to_whatsapp_admin


class TicketManager:
    VALID_SEVERITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
    VALID_STATUSES = ("OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED")

    @staticmethod
    def create_ticket(title, description="", reported_by="SYSTEM", severity="MEDIUM", associated_task_id=None):
        ticket_id = f"TICK-{uuid.uuid4().hex[:6].upper()}"
        now = time.time()
        severity = severity.upper() if severity and severity.upper() in TicketManager.VALID_SEVERITIES else "MEDIUM"

        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO tickets (
                    ticket_id, title, description, reported_by, severity,
                    status, associated_task_id, resolution_notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, '', ?, ?)
            """, (ticket_id, title, description, reported_by, severity, associated_task_id, now, now))
            conn.commit()
            conn.close()

        # Publish room message
        MessageBroker.publish(
            sender="IT_HELPDESK",
            target="ALL",
            topic="TICKET_CREATED",
            payload={
                "ticket_id": ticket_id,
                "title": title,
                "severity": severity,
                "reported_by": reported_by,
                "associated_task_id": associated_task_id
            }
        )

        return TicketManager.get_ticket(ticket_id)

    @staticmethod
    def get_ticket(ticket_id):
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            return None
        return TicketManager._row_to_dict(row)

    @staticmethod
    def list_tickets(status=None, severity=None, limit=50):
        conn = db.get_connection()
        cursor = conn.cursor()
        query = "SELECT * FROM tickets WHERE 1=1"
        params = []
        if status:
            query += " AND status = ?"
            params.append(status.upper())
        if severity:
            query += " AND severity = ?"
            params.append(severity.upper())
        query += " ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, created_at DESC LIMIT ?"
        params.append(limit)

        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        return [TicketManager._row_to_dict(r) for r in rows]

    @staticmethod
    def resolve_ticket(ticket_id, resolved_by="ADMIN", resolution_notes=""):
        now = time.time()
        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
            row = cursor.fetchone()
            if not row:
                conn.close()
                return False, f"Ticket '{ticket_id}' not found."

            cursor.execute("""
                UPDATE tickets
                SET status = 'RESOLVED',
                    resolution_notes = ?,
                    updated_at = ?
                WHERE ticket_id = ?
            """, (resolution_notes, now, ticket_id))
            conn.commit()
            conn.close()

        # Publish room message
        MessageBroker.publish(
            sender="IT_HELPDESK",
            target="ALL",
            topic="TICKET_RESOLVED",
            payload={
                "ticket_id": ticket_id,
                "resolved_by": resolved_by,
                "resolution_notes": resolution_notes
            }
        )

        dispatch_to_whatsapp_admin(
            action="TICKET_RESOLVED",
            actor=resolved_by,
            task_id=ticket_id,
            details=f"Ticket {ticket_id} marked RESOLVED: {resolution_notes}"
        )

        return True, TicketManager.get_ticket(ticket_id)

    @staticmethod
    def update_ticket(ticket_id, status=None, severity=None, notes=None):
        now = time.time()
        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
            row = cursor.fetchone()
            if not row:
                conn.close()
                return False, f"Ticket '{ticket_id}' not found."

            new_status = status.upper() if status and status.upper() in TicketManager.VALID_STATUSES else row["status"]
            new_severity = severity.upper() if severity and severity.upper() in TicketManager.VALID_SEVERITIES else row["severity"]
            new_notes = notes if notes is not None else row["resolution_notes"]

            cursor.execute("""
                UPDATE tickets
                SET status = ?,
                    severity = ?,
                    resolution_notes = ?,
                    updated_at = ?
                WHERE ticket_id = ?
            """, (new_status, new_severity, new_notes, now, ticket_id))
            conn.commit()
            conn.close()

        return True, TicketManager.get_ticket(ticket_id)

    @staticmethod
    def _row_to_dict(row):
        d = dict(row)
        d["created_at_fmt"] = datetime.fromtimestamp(d["created_at"]).strftime("%Y-%m-%d %H:%M:%S")
        d["updated_at_fmt"] = datetime.fromtimestamp(d["updated_at"]).strftime("%Y-%m-%d %H:%M:%S")
        return d

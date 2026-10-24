"""
IT Helpdesk Incident Tickets API Blueprint
Routes:
- GET, POST /api/tickets
- GET, PUT /api/tickets/<ticket_id>
- POST /api/tickets/<ticket_id>/resolve
"""

from flask import Blueprint, request, jsonify
from room_server.models.ticket import TicketManager
from room_server.services.whatsapp_notifier import dispatch_to_whatsapp_error

tickets_bp = Blueprint("tickets_bp", __name__)


@tickets_bp.route("/api/tickets", methods=["GET", "POST"])
def api_tickets():
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        title = data.get("title")
        if not title:
            return jsonify({"error": "'title' field is required"}), 400

        description = data.get("description", "")
        reported_by = data.get("reported_by", "SYSTEM")
        severity = data.get("severity", "MEDIUM")
        associated_task_id = data.get("associated_task_id")

        ticket = TicketManager.create_ticket(
            title=title,
            description=description,
            reported_by=reported_by,
            severity=severity,
            associated_task_id=associated_task_id
        )

        # Notify IT Helpdesk via targeted webhook
        dispatch_to_whatsapp_error(
            error_type="NEW_INCIDENT_TICKET",
            title=f"New Ticket: {title} [{severity}]",
            task_id=associated_task_id or ticket["ticket_id"],
            error_details=f"Ticket: {ticket['ticket_id']} | Reporter: {reported_by}\n{description}"
        )

        return jsonify({"status": "success", "ticket": ticket}), 201
    else:
        status = request.args.get("status")
        severity = request.args.get("severity")
        limit = int(request.args.get("limit", 50))
        tickets = TicketManager.list_tickets(status=status, severity=severity, limit=limit)
        return jsonify({"tickets": tickets, "count": len(tickets)}), 200


@tickets_bp.route("/api/tickets/<ticket_id>", methods=["GET", "PUT"])
def api_ticket_detail(ticket_id):
    if request.method == "GET":
        ticket = TicketManager.get_ticket(ticket_id)
        if not ticket:
            return jsonify({"error": f"Ticket '{ticket_id}' not found"}), 404
        return jsonify({"ticket": ticket}), 200
    else:
        data = request.get_json(force=True, silent=True) or {}
        success, res = TicketManager.update_ticket(
            ticket_id,
            status=data.get("status"),
            severity=data.get("severity"),
            notes=data.get("notes") or data.get("resolution_notes")
        )
        if not success:
            return jsonify({"error": res}), 400
        return jsonify({"status": "success", "ticket": res}), 200


@tickets_bp.route("/api/tickets/<ticket_id>/resolve", methods=["POST"])
def api_ticket_resolve(ticket_id):
    data = request.get_json(force=True, silent=True) or {}
    resolved_by = data.get("resolved_by", "ADMIN")
    notes = data.get("resolution_notes") or data.get("notes") or "Issue resolved"
    success, res = TicketManager.resolve_ticket(ticket_id, resolved_by=resolved_by, resolution_notes=notes)
    if not success:
        return jsonify({"error": res}), 400
    return jsonify({"status": "success", "ticket": res}), 200

"""
Room Dashboard & Telemetry Blueprint
Routes:
- GET /room: Real-time visual DOM workspace
- GET /room/state: Consolidated JSON telemetry for dynamic poller
"""

import time
from flask import Blueprint, render_template, jsonify
from room_server.models.task import TaskManager
from room_server.models.message import MessageBroker
from room_server.models.agent import AgentRegistry
from room_server.models.drive import DriveManager
from room_server.models.ticket import TicketManager

dashboard_bp = Blueprint("dashboard_bp", __name__)


@dashboard_bp.route("/room", methods=["GET"])
def room_dashboard():
    return render_template("room.html")


@dashboard_bp.route("/storefront", methods=["GET"])
def storefront_portal():
    return render_template("storefront.html")


@dashboard_bp.route("/room/state", methods=["GET"])
def room_state():
    """Consolidated state payload for visual DOM dynamic polling."""
    TaskManager.reconcile_timeouts()
    tasks = TaskManager.list_tasks(limit=100)
    messages = MessageBroker.get_messages(limit=50)
    agents = AgentRegistry.list_agents()
    assets = DriveManager.list_assets(limit=20)
    tickets = TicketManager.list_tickets(limit=30)

    # Group tasks by 5 ASADF stages
    task_pipeline = {
        "PENDING": [t for t in tasks if t["state"] == "PENDING"],
        "CLAIMED": [t for t in tasks if t["state"] == "CLAIMED"],
        "IN_PROGRESS": [t for t in tasks if t["state"] == "IN_PROGRESS"],
        "VERIFIED": [t for t in tasks if t["state"] == "VERIFIED"],
        "DONE": [t for t in tasks if t["state"] == "DONE"]
    }

    open_tickets = len([t for t in tickets if t["status"] in ("OPEN", "IN_PROGRESS")])

    return jsonify({
        "timestamp": time.time(),
        "task_pipeline": task_pipeline,
        "tasks": tasks,
        "messages": messages,
        "agents": agents,
        "assets": assets,
        "tickets": tickets,
        "tickets_open": open_tickets
    }), 200

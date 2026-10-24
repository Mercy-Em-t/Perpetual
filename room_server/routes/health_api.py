"""
Health & Agent Registry API Blueprint
Routes:
- GET /health: Microservice vitals & counters
- GET /api/agents: Active agent roster
- POST /api/agents/heartbeat: Agent registration and keep-alive
"""

import time
from flask import Blueprint, request, jsonify
from room_server.db import db
from room_server.models.task import TaskManager
from room_server.models.agent import AgentRegistry

health_bp = Blueprint("health_bp", __name__)


@health_bp.route("/health", methods=["GET"])
def health_check():
    TaskManager.reconcile_timeouts()
    conn = db.get_connection()
    c = conn.cursor()
    c.execute("SELECT count(*) as total_tasks FROM tasks")
    tasks_count = c.fetchone()["total_tasks"]
    c.execute("SELECT count(*) as total_msgs FROM messages")
    msgs_count = c.fetchone()["total_msgs"]
    c.execute("SELECT count(*) as total_assets FROM drive_assets")
    assets_count = c.fetchone()["total_assets"]
    c.execute("SELECT count(*) as open_tickets FROM tickets WHERE status NOT IN ('RESOLVED', 'CLOSED')")
    open_tickets = c.fetchone()["open_tickets"]
    conn.close()

    return jsonify({
        "status": "healthy",
        "service": "Shared Agent Room Microservice",
        "port": 5050,
        "timestamp": time.time(),
        "stats": {
            "tasks_count": tasks_count,
            "messages_count": msgs_count,
            "assets_count": assets_count,
            "tickets_open": open_tickets
        }
    }), 200


@health_bp.route("/api/agents/heartbeat", methods=["POST"])
def api_agent_heartbeat():
    data = request.get_json(force=True, silent=True) or {}
    agent_id = data.get("agent_id")
    if not agent_id:
        return jsonify({"error": "'agent_id' required"}), 400
    name = data.get("name")
    status = data.get("status")
    metadata = data.get("metadata")
    AgentRegistry.heartbeat(agent_id=agent_id, name=name, status=status, metadata=metadata)
    return jsonify({"status": "success", "agent_id": agent_id}), 200


@health_bp.route("/api/agents", methods=["GET"])
def api_get_agents():
    agents = AgentRegistry.list_agents()
    return jsonify({"agents": agents, "count": len(agents)}), 200

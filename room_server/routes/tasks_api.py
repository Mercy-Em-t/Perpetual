"""
ASADF Tasks API Blueprint
Routes:
- GET, POST /api/tasks
- GET /api/tasks/<task_id>
- POST /api/tasks/<task_id>/claim
- POST /api/tasks/<task_id>/start
- POST /api/tasks/<task_id>/verify
- POST /api/tasks/<task_id>/complete
"""

from flask import Blueprint, request, jsonify
from room_server.models.task import TaskManager

tasks_bp = Blueprint("tasks_bp", __name__)


@tasks_bp.route("/api/tasks", methods=["GET", "POST"])
def api_tasks():
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}

        # Check if action on existing task
        task_id = data.get("task_id")
        action = data.get("action")

        if task_id and action:
            agent_id = data.get("agent_id")
            result = data.get("result")
            notes = data.get("notes")
            success, res_or_err = TaskManager.transition(task_id, action, agent_id=agent_id, result=result, notes=notes)
            if not success:
                return jsonify({"error": res_or_err}), 400
            return jsonify({"status": "success", "task": res_or_err}), 200

        # Create new task
        title = data.get("title")
        if not title:
            return jsonify({"error": "'title' field is required to create a task"}), 400

        task_type = data.get("task_type", "GENERAL")
        priority = int(data.get("priority", 2))
        payload = data.get("payload", {})

        task = TaskManager.create_task(title=title, task_type=task_type, priority=priority, payload=payload)
        return jsonify({"status": "success", "task": task}), 201

    else:
        state = request.args.get("state")
        agent_id = request.args.get("agent_id")
        limit = int(request.args.get("limit", 100))
        tasks = TaskManager.list_tasks(state=state, agent_id=agent_id, limit=limit)
        return jsonify({"tasks": tasks, "count": len(tasks)}), 200


@tasks_bp.route("/api/tasks/<task_id>", methods=["GET"])
def api_get_task(task_id):
    task = TaskManager.get_task(task_id)
    if not task:
        return jsonify({"error": f"Task '{task_id}' not found"}), 404
    return jsonify({"task": task}), 200


@tasks_bp.route("/api/tasks/<task_id>/claim", methods=["POST"])
def api_claim_task(task_id):
    data = request.get_json(force=True, silent=True) or {}
    agent_id = data.get("agent_id")
    if not agent_id:
        return jsonify({"error": "'agent_id' required"}), 400
    success, res = TaskManager.transition(task_id, "claim", agent_id=agent_id)
    if not success:
        return jsonify({"error": res}), 400
    return jsonify({"status": "success", "task": res}), 200


@tasks_bp.route("/api/tasks/<task_id>/start", methods=["POST"])
def api_start_task(task_id):
    data = request.get_json(force=True, silent=True) or {}
    agent_id = data.get("agent_id")
    success, res = TaskManager.transition(task_id, "start", agent_id=agent_id)
    if not success:
        return jsonify({"error": res}), 400
    return jsonify({"status": "success", "task": res}), 200


@tasks_bp.route("/api/tasks/<task_id>/verify", methods=["POST"])
def api_verify_task(task_id):
    data = request.get_json(force=True, silent=True) or {}
    agent_id = data.get("agent_id")
    result = data.get("result")
    success, res = TaskManager.transition(task_id, "verify", agent_id=agent_id, result=result)
    if not success:
        return jsonify({"error": res}), 400
    return jsonify({"status": "success", "task": res}), 200


@tasks_bp.route("/api/tasks/<task_id>/complete", methods=["POST"])
def api_complete_task(task_id):
    data = request.get_json(force=True, silent=True) or {}
    result = data.get("result")
    success, res = TaskManager.transition(task_id, "complete", result=result)
    if not success:
        return jsonify({"error": res}), 400
    return jsonify({"status": "success", "task": res}), 200

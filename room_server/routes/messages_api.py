"""
Pub/Sub Messaging API Blueprint
Routes:
- GET, POST /api/messages
"""

from flask import Blueprint, request, jsonify
from room_server.models.message import MessageBroker

messages_bp = Blueprint("messages_bp", __name__)


@messages_bp.route("/api/messages", methods=["GET", "POST"])
def api_messages():
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        sender = data.get("sender")
        if not sender:
            return jsonify({"error": "'sender' field is required"}), 400

        target = data.get("target", "ALL")
        topic = data.get("topic", "GENERAL")
        payload = data.get("payload", {})

        msg = MessageBroker.publish(sender=sender, target=target, topic=topic, payload=payload)
        return jsonify({"status": "success", "message": msg}), 201

    else:
        target = request.args.get("target")
        sender = request.args.get("sender")
        topic = request.args.get("topic")
        since = request.args.get("since")
        limit = int(request.args.get("limit", 50))

        messages = MessageBroker.get_messages(target=target, sender=sender, topic=topic, since=since, limit=limit)
        return jsonify({"messages": messages, "count": len(messages)}), 200

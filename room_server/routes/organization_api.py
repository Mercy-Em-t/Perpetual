"""
Organization & RBAC Policy API Blueprint
Provides REST endpoints to query and update organization departments, roles, and staff directory.
"""

from flask import Blueprint, request, jsonify
from room_server.models.organization import OrganizationManager

org_bp = Blueprint("organization_api", __name__, url_prefix="/api/organization")


@org_bp.route("", methods=["GET"])
def get_organization():
    """Returns full organization structure, departments, roles, and business processes."""
    config = OrganizationManager.get_config()
    return jsonify({"status": "success", "data": config})


@org_bp.route("/rbac/check", methods=["GET"])
def check_rbac():
    """Checks if a given phone number has permission to run a command."""
    phone = request.args.get("phone", "")
    command = request.args.get("command", "")
    if not phone or not command:
        return jsonify({"error": "Query parameters 'phone' and 'command' required"}), 400

    auth_result = OrganizationManager.can_execute_command(phone, command)
    return jsonify(auth_result)


@org_bp.route("/members", methods=["GET"])
def list_members():
    """Lists all members and their roles."""
    members = OrganizationManager.get_members()
    return jsonify({"members": members, "count": len(members)})


@org_bp.route("/processes", methods=["GET"])
def get_business_processes():
    """Returns 5-station SLA thresholds and assigned roles."""
    bp = OrganizationManager.get_business_process()
    return jsonify({"business_processes": bp})

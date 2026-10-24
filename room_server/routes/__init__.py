"""
Routes package for Shared Agent Room.
Registers all blueprints with the Flask application.
"""

from room_server.routes.dashboard import dashboard_bp
from room_server.routes.tasks_api import tasks_bp
from room_server.routes.messages_api import messages_bp
from room_server.routes.tickets_api import tickets_bp
from room_server.routes.drive_api import drive_bp
from room_server.routes.health_api import health_bp
from room_server.routes.orders_api import orders_bp
from room_server.routes.organization_api import org_bp

__all__ = [
    "dashboard_bp",
    "tasks_bp",
    "messages_bp",
    "tickets_bp",
    "drive_bp",
    "health_bp",
    "orders_bp",
    "org_bp"
]

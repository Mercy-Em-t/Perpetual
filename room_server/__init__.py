"""
Shared Agent Room Package
Application Factory & Component Exposer
"""

from flask import Flask, request, jsonify
from room_server.db import db, TEMPLATES_DIR, STATIC_DIR, ASSETS_DIR
from room_server.models import (
    TaskManager,
    MessageBroker,
    TicketManager,
    DriveManager,
    DriveIngestionService,
    AgentRegistry
)
from room_server.models.order import OrderManager
from room_server.services.whatsapp_notifier import (
    dispatch_to_whatsapp_task,
    dispatch_to_whatsapp_error,
    dispatch_to_whatsapp_admin
)
from room_server.services.reconciler import start_reconciler
from room_server.services.order_rollup_worker import start_order_rollup
from room_server.routes import (
    dashboard_bp,
    tasks_bp,
    messages_bp,
    tickets_bp,
    drive_bp,
    health_bp
)
from room_server.routes.orders_api import orders_bp
from room_server.routes.organization_api import org_bp


def create_app(start_background_reconciler=True):
    """
    Application factory for the Shared Agent Room microservice.
    """
    app = Flask(__name__, template_folder=TEMPLATES_DIR, static_folder=STATIC_DIR)

    # Register all modular blueprints
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(tasks_bp)
    app.register_blueprint(messages_bp)
    app.register_blueprint(tickets_bp)
    app.register_blueprint(drive_bp)
    app.register_blueprint(health_bp)
    app.register_blueprint(orders_bp)
    app.register_blueprint(org_bp)

    # Global 500 exception handler notifying IT Helpdesk
    @app.errorhandler(500)
    def handle_500_exception(e):
        err_msg = str(e)
        dispatch_to_whatsapp_error(
            error_type="SERVER_500_EXCEPTION",
            title=f"Internal Server Error on {request.path}",
            error_details=err_msg
        )
        return jsonify({"error": "Internal server error", "details": err_msg}), 500

    if start_background_reconciler:
        start_reconciler()
        start_order_rollup(interval_seconds=3600)

    return app


# Default application instance for imports and wsgi servers
app = create_app(start_background_reconciler=True)

__all__ = [
    "create_app",
    "app",
    "db",
    "TaskManager",
    "MessageBroker",
    "TicketManager",
    "DriveManager",
    "DriveIngestionService",
    "AgentRegistry",
    "ASSETS_DIR"
]

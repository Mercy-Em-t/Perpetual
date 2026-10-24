#!/usr/bin/env python3
"""
Shared Agent Room Microservice (Root Entrypoint)
Delegates to the modular `room_server` package.
Exposes app, db, TaskManager, MessageBroker, TicketManager, and DriveIngestionService
for seamless backward compatibility with all test suites and worker scripts.
"""

import argparse
from room_server import (
    create_app,
    db,
    TaskManager,
    MessageBroker,
    TicketManager,
    DriveManager,
    DriveIngestionService,
    AgentRegistry,
    ASSETS_DIR
)

# Initialize application instance
app = create_app(start_background_reconciler=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Shared Agent Room Server")
    parser.add_argument("--port", type=int, default=5050, help="Port to listen on (default: 5050)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host address (default: 0.0.0.0)")
    parser.add_argument("--debug", action="store_true", help="Run Flask in debug mode")
    args = parser.parse_args()

    print(f"=== Shared Agent Room Microservice (Modularized) ===")
    print(f"Listening on http://{args.host}:{args.port}")
    print(f"Room Dashboard: http://localhost:{args.port}/room")
    print(f"Drive Ingest Webhook: http://localhost:{args.port}/api/drive/ingest")
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)

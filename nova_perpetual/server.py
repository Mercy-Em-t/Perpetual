"""
Standalone Nova server.
    python -m nova_perpetual.server --port 5060            # live Perpetual backend
    python -m nova_perpetual.server --backend memory       # seeded demo data
"""

import argparse
import os

from flask import Flask

from nova_perpetual.agent import NovaAgent
from nova_perpetual.api import nova_bp
from nova_perpetual.config import NovaSettings
from nova_perpetual.tools.backend import InMemoryBackend, LivePerpetualBackend


def create_nova_app(settings: NovaSettings = None, backend=None, ingest: bool = True) -> Flask:
    settings = settings or NovaSettings()
    if backend is None:
        backend = InMemoryBackend() if os.environ.get("NOVA_BACKEND") == "memory" else LivePerpetualBackend()
    agent = NovaAgent(settings, backend)
    if ingest:
        agent.kb.ingest_directory(settings.knowledge_dir)
    app = Flask("nova_perpetual")
    app.config["NOVA_AGENT"] = agent
    app.register_blueprint(nova_bp)
    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5060)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--backend", choices=["live", "memory"], default="live")
    args = ap.parse_args()
    be = InMemoryBackend() if args.backend == "memory" else LivePerpetualBackend()
    create_nova_app(backend=be).run(host=args.host, port=args.port, threaded=True)

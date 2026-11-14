"""
Nova HTTP API (Flask blueprint). Mount it in Perpetual One or run standalone
with `python -m nova_perpetual.server`.

Auth: `Authorization: Bearer <JWT>` (see security/principal.py). The identity in
the token - never a field in the request body - decides what Nova may do.
"""

from functools import wraps

from flask import Blueprint, current_app, g, jsonify, request

from nova_perpetual.agent import Attachment
from nova_perpetual.security.principal import AuthError, verify_token

nova_bp = Blueprint("nova", __name__, url_prefix="/nova")


def _agent():
    return current_app.config["NOVA_AGENT"]


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"error": "Missing bearer token"}), 401
        try:
            g.principal = verify_token(header[7:], _agent().settings.token_secret)
        except AuthError as e:
            return jsonify({"error": str(e)}), 401
        return fn(*args, **kwargs)
    return wrapper


def require_role(*roles):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if g.principal.role not in roles:
                return jsonify({"error": "Forbidden"}), 403
            return fn(*args, **kwargs)
        return wrapper
    return deco


@nova_bp.post("/chat")
@require_auth
def chat():
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        return jsonify({"error": "message is required"}), 400
    if len(message) > 4000:
        return jsonify({"error": "message too long"}), 413
    atts = [Attachment(source=str(a.get("source", "unknown")), content=str(a.get("content", ""))[:20000])
            for a in (body.get("attachments") or [])[:5]]
    reply = _agent().chat(g.principal, message, atts, channel=body.get("channel", "api"))
    return jsonify(reply.to_dict())


@nova_bp.get("/traces")
@require_auth
@require_role("EXECUTIVE", "SUPPORT_ENGINEER")
def traces():
    return jsonify({"traces": _agent().tracer.recent(int(request.args.get("limit", 50))),
                    "stats": _agent().tracer.stats()})


@nova_bp.get("/traces/<trace_id>")
@require_auth
@require_role("EXECUTIVE", "SUPPORT_ENGINEER")
def trace_detail(trace_id):
    tr = _agent().tracer.get(trace_id)
    return (jsonify(tr), 200) if tr else (jsonify({"error": "not found"}), 404)


@nova_bp.get("/approvals")
@require_auth
@require_role("EXECUTIVE")
def approvals():
    return jsonify({"approvals": _agent().approvals.list(request.args.get("status", "PENDING"))})


@nova_bp.post("/approvals/<approval_id>")
@require_auth
@require_role("EXECUTIVE")
def decide(approval_id):
    approve = bool((request.get_json(silent=True) or {}).get("approve"))
    agent = _agent()
    return jsonify(agent.approvals.decide(approval_id, approve, g.principal, executor=agent.execute_deferred))


@nova_bp.get("/health")
def health():
    agent = _agent()
    try:
        p = agent.prompts.load(enforce_gate=agent.settings.enforce_eval_gate)
        prompt = {"version": p.version, "sha256": p.sha256[:12], "gate": "open"}
    except Exception as e:  # report, don't crash
        prompt = {"gate": "closed", "error": str(e)}
    return jsonify({"service": "nova-perpetual", "provider": agent.settings.provider,
                    "kb_version": agent.kb.version(), "prompt": prompt})

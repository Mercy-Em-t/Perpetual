"""
Nova MCP server (Model Context Protocol, stdio transport, JSON-RPC 2.0).

Exposes the same RBAC-enforced tool registry to any MCP client (Claude Desktop,
IDE agents, other Nova instances). The caller's identity comes from a signed
token in NOVA_MCP_TOKEN - the client cannot choose who it is per call.

Run:
    set NOVA_MCP_TOKEN=<token from `python -m nova_perpetual.cli token ...`>
    python -m nova_perpetual.tools.mcp_server
"""

import json
import os
import sys
from typing import Any, Dict, Optional

from nova_perpetual.config import NovaSettings
from nova_perpetual.security.principal import AuthError, verify_token
from nova_perpetual.storage import NovaStore
from nova_perpetual.tools.backend import InMemoryBackend, LivePerpetualBackend
from nova_perpetual.tools.registry import ToolContext, execute_tool, to_json, tools_for

PROTOCOL_VERSION = "2024-11-05"


class MCPServer:
    def __init__(self, ctx: ToolContext):
        self.ctx = ctx

    def handle(self, req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        method, rid = req.get("method"), req.get("id")
        if rid is None:  # notification
            return None
        try:
            if method == "initialize":
                result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}},
                          "serverInfo": {"name": "nova-perpetual", "version": "0.1.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": [{"name": t.name, "description": t.description, "inputSchema": t.parameters}
                                    for t in tools_for(self.ctx.principal)]}
            elif method == "tools/call":
                params = req.get("params", {})
                out = execute_tool(self.ctx, params.get("name"), params.get("arguments") or {})
                result = {"content": [{"type": "text", "text": to_json(out)}], "isError": bool(out.get("error"))}
            else:
                return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Unknown method {method}"}}
            return {"jsonrpc": "2.0", "id": rid, "result": result}
        except Exception as e:  # never crash the transport
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": str(e)}}


def main() -> None:
    settings = NovaSettings()
    try:
        principal = verify_token(os.environ.get("NOVA_MCP_TOKEN", ""), settings.token_secret)
    except AuthError as e:
        sys.stderr.write(f"[nova-mcp] authentication failed: {e}\n")
        sys.exit(2)
    backend = InMemoryBackend() if os.environ.get("NOVA_BACKEND") == "memory" else LivePerpetualBackend()
    server = MCPServer(ToolContext(principal, backend, NovaStore(settings.db_path), settings, trace_id="mcp"))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        resp = server.handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()

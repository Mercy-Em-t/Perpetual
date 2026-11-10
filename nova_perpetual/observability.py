"""
Observability: one trace per conversation turn, one span per step
(guardrail scan, cache lookup, routing, retrieval, LLM call, tool call).
Every trace records the prompt version + hash, model, tokens, cost and
latency, so "why did Nova say that?" is answerable after the fact.
"""

import json
import time
import uuid
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from nova_perpetual.storage import NovaStore

MAX_FIELD = 4000


def _clip(v: Any) -> str:
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    return s[:MAX_FIELD]


class Trace:
    def __init__(self, tracer: "Tracer", trace_id: str):
        self.tracer, self.trace_id = tracer, trace_id
        self.tokens_in = self.tokens_out = 0
        self.cost_usd = 0.0
        self.flags: List[str] = []
        self.fields: Dict[str, Any] = {}

    @contextmanager
    def span(self, kind: str, name: str, input: Any = None, **meta):
        span_id = f"spn_{uuid.uuid4().hex[:10]}"
        start = time.time()
        record = {"output": None, "status": "ok", "meta": meta}
        try:
            yield record
        except Exception as e:
            record["status"], record["output"] = "error", repr(e)
            raise
        finally:
            self.tracer.store.execute(
                "INSERT INTO spans (span_id, trace_id, kind, name, input, output, status, latency_ms, meta, started_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (span_id, self.trace_id, kind, name, _clip(input), _clip(record["output"]), record["status"],
                 (time.time() - start) * 1000, _clip(record["meta"]), start))

    def add_usage(self, model: str, tokens_in: int, tokens_out: int, pricing: Dict[str, tuple]) -> float:
        p_in, p_out = pricing.get(model, (0.0, 0.0))
        cost = tokens_in / 1000 * p_in + tokens_out / 1000 * p_out
        self.tokens_in += tokens_in
        self.tokens_out += tokens_out
        self.cost_usd += cost
        return cost


class Tracer:
    def __init__(self, store: NovaStore):
        self.store = store

    def start(self, principal, channel: str, user_input: str) -> Trace:
        trace_id = f"trc_{uuid.uuid4().hex[:12]}"
        self.store.execute(
            "INSERT INTO traces (trace_id, user_id, role, tenant, channel, input, status, started_at)"
            " VALUES (?,?,?,?,?,?, 'running', ?)",
            (trace_id, principal.user_id, principal.role, principal.tenant, channel, _clip(user_input), time.time()))
        return Trace(self, trace_id)

    def finish(self, t: Trace, output: str, status: str = "ok") -> None:
        row = self.store.query_one("SELECT started_at FROM traces WHERE trace_id=?", (t.trace_id,))
        now = time.time()
        f = t.fields
        self.store.execute(
            "UPDATE traces SET output=?, prompt_version=?, prompt_hash=?, model=?, route=?, cache_hit=?,"
            " tokens_in=?, tokens_out=?, cost_usd=?, latency_ms=?, status=?, guardrail_flags=?, ended_at=?"
            " WHERE trace_id=?",
            (_clip(output), f.get("prompt_version"), f.get("prompt_hash"), f.get("model"), f.get("route"),
             int(bool(f.get("cache_hit"))), t.tokens_in, t.tokens_out, round(t.cost_usd, 6),
             (now - row["started_at"]) * 1000 if row else 0, status, json.dumps(t.flags), now, t.trace_id))

    def get(self, trace_id: str) -> Optional[Dict[str, Any]]:
        tr = self.store.query_one("SELECT * FROM traces WHERE trace_id=?", (trace_id,))
        if tr:
            tr["spans"] = self.store.query("SELECT * FROM spans WHERE trace_id=? ORDER BY started_at", (trace_id,))
        return tr

    def recent(self, limit: int = 50) -> List[Dict[str, Any]]:
        return self.store.query("SELECT * FROM traces ORDER BY started_at DESC LIMIT ?", (limit,))

    def stats(self) -> Dict[str, Any]:
        row = self.store.query_one(
            "SELECT COUNT(*) AS turns, SUM(cache_hit) AS cache_hits, SUM(tokens_in) AS tokens_in,"
            " SUM(tokens_out) AS tokens_out, ROUND(SUM(cost_usd), 6) AS cost_usd, ROUND(AVG(latency_ms), 1)"
            " AS avg_latency_ms FROM traces")
        row["by_route"] = self.store.query("SELECT route, COUNT(*) AS n FROM traces GROUP BY route")
        return row

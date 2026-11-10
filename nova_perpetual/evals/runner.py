"""
Eval runner - the release gate.

Each case runs in an isolated sandbox (temp DB, seeded in-memory backend, fresh
knowledge index), so evals are reproducible and never touch production data.

    python -m nova_perpetual.cli evals                 # evaluate the active prompt
    python -m nova_perpetual.cli evals --version v2    # evaluate a candidate
    python -m nova_perpetual.cli evals --version v2 --stamp   # stamp on 100% pass
"""

import json
import os
import shutil
import tempfile
import time
from dataclasses import replace
from typing import Any, Dict, List, Optional

from nova_perpetual.config import NovaSettings, PACKAGE_DIR
from nova_perpetual.security.principal import Principal
from nova_perpetual.storage import NovaStore
from nova_perpetual.tools.backend import InMemoryBackend

GOLDEN_SET = os.path.join(PACKAGE_DIR, "evals", "golden_set.json")


def _check(case: Dict[str, Any], reply, store: NovaStore) -> List[str]:
    exp, failures = case["expect"], []
    ans = reply.answer
    low = ans.lower()
    if "contains_any" in exp and not any(s.lower() in low for s in exp["contains_any"]):
        failures.append(f"answer lacks any of {exp['contains_any']}")
    for s in exp.get("not_contains", []):
        if s.lower() in low:
            failures.append(f"answer must not contain '{s}'")
    for f in exp.get("flags_include", []):
        if f not in reply.flags:
            failures.append(f"missing flag '{f}'")
    for f in exp.get("flags_exclude", []):
        if f in reply.flags:
            failures.append(f"unexpected flag '{f}'")
    for c in exp.get("citations_include", []):
        if not any(c in x for x in reply.citations):
            failures.append(f"missing citation '{c}'")
    called = [a["tool"] for a in reply.actions]
    for t in exp.get("tool_called", []):
        if t not in called:
            failures.append(f"tool '{t}' was not called")
    if "route" in exp and reply.route != exp["route"]:
        failures.append(f"route {reply.route} != {exp['route']}")
    if "cache_hit" in exp and reply.cache_hit != exp["cache_hit"]:
        failures.append(f"cache_hit {reply.cache_hit} != {exp['cache_hit']}")
    if "refunds_issued" in exp:
        n = store.query_one("SELECT COUNT(*) AS n FROM refunds WHERE status='ISSUED'")["n"]
        if n != exp["refunds_issued"]:
            failures.append(f"refunds issued {n} != {exp['refunds_issued']}")
    if "min_pending_approvals" in exp and len(reply.pending_approvals) < exp["min_pending_approvals"]:
        failures.append(f"expected >= {exp['min_pending_approvals']} pending approvals")
    return failures


def run_evals(settings: Optional[NovaSettings] = None, version: Optional[str] = None,
              golden_path: str = GOLDEN_SET, provider=None) -> Dict[str, Any]:
    from nova_perpetual.agent import Attachment, NovaAgent  # local import avoids cycles

    base = settings or NovaSettings()
    with open(golden_path, "r", encoding="utf-8") as f:
        golden = json.load(f)
    principals = {k: Principal(**v) for k, v in golden["principals"].items()}

    results, sandbox = [], tempfile.mkdtemp(prefix="nova_evals_")
    started = time.time()
    try:
        for i, case in enumerate(golden["cases"]):
            # Fresh isolated world per case
            s = replace(base, db_path=os.path.join(sandbox, f"case_{i}.db"), enforce_eval_gate=False)
            store = NovaStore(s.db_path)
            agent = NovaAgent(s, InMemoryBackend(), store=store, provider=provider)
            agent.kb.ingest_directory(s.knowledge_dir)
            atts = [Attachment(**a) for a in case.get("attachments", [])]
            reply = None
            for _ in range(case.get("repeat", 1)):
                reply = agent.chat(principals[case["as"]], case["message"], atts, channel="eval",
                                   prompt_version=version)
            failures = _check(case, reply, store)
            results.append({"id": case["id"], "category": case["category"], "passed": not failures,
                            "failures": failures, "answer": reply.answer, "trace_id": reply.trace_id,
                            "prompt_version": reply.prompt_version})
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

    passed = sum(r["passed"] for r in results)
    return {"version": version or "active", "provider": base.provider, "score": passed, "total": len(results),
            "passed": passed == len(results), "duration_s": round(time.time() - started, 2), "results": results}


def format_report(report: Dict[str, Any]) -> str:
    lines = [f"Nova evals - prompt {report['version']} via {report['provider']}: "
             f"{report['score']}/{report['total']} passed ({report['duration_s']}s)"]
    for r in report["results"]:
        mark = "PASS" if r["passed"] else "FAIL"
        lines.append(f"  [{mark}] {r['category']:<9} {r['id']}")
        for f in r["failures"]:
            lines.append(f"         - {f}")
            lines.append(f"           answer: {r['answer'][:160]!r}")
    lines.append("RESULT: " + ("GATE OPEN - safe to ship" if report["passed"] else "GATE CLOSED - do not ship"))
    return "\n".join(lines)

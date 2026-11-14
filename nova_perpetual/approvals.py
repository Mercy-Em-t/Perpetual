"""
Human-in-the-loop approvals.
Anything Nova is not allowed to do on its own (refunds over the limit, actions
proposed while untrusted content was present, bulk operations) lands here and
waits for an EXECUTIVE / HR decision.
"""

import json
import time
import uuid
from typing import Any, Dict, List, Optional

from nova_perpetual.storage import NovaStore

APPROVER_ROLES = {"EXECUTIVE"}


class ApprovalService:
    def __init__(self, store: NovaStore):
        self.store = store

    def request(self, kind: str, payload: Dict[str, Any], reason: str, requested_by: str,
                trace_id: str = "") -> str:
        approval_id = f"APR-{uuid.uuid4().hex[:6].upper()}"
        self.store.execute(
            "INSERT INTO approvals (approval_id, kind, payload, reason, status, requested_by, trace_id, created_at)"
            " VALUES (?,?,?,?, 'PENDING', ?,?,?)",
            (approval_id, kind, json.dumps(payload), reason, requested_by, trace_id, time.time()))
        return approval_id

    def list(self, status: Optional[str] = "PENDING") -> List[Dict[str, Any]]:
        sql = "SELECT * FROM approvals" + (" WHERE status=?" if status else "") + " ORDER BY created_at DESC"
        rows = self.store.query(sql, (status,) if status else ())
        for r in rows:
            r["payload"] = json.loads(r["payload"])
        return rows

    def decide(self, approval_id: str, approve: bool, decider, executor=None) -> Dict[str, Any]:
        """`decider` is a Principal. `executor(payload)` re-runs a deferred tool call when approved."""
        if decider.role not in APPROVER_ROLES:
            return {"error": "Only executives can decide approvals."}
        row = self.store.query_one("SELECT * FROM approvals WHERE approval_id=?", (approval_id,))
        if not row or row["status"] != "PENDING":
            return {"error": "Approval not found or already decided."}
        payload = json.loads(row["payload"])
        status = "APPROVED" if approve else "REJECTED"
        self.store.execute("UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE approval_id=?",
                           (status, decider.user_id, time.time(), approval_id))
        result: Dict[str, Any] = {"approval_id": approval_id, "status": status}

        if row["kind"] == "refund_over_limit":
            self.store.execute("UPDATE refunds SET status=?, approved_by=?, updated_at=? WHERE refund_id=?",
                               ("ISSUED" if approve else "REJECTED", decider.user_id, time.time(),
                                payload["refund_id"]))
        elif row["kind"] == "deferred_tool_call" and approve and executor:
            result["execution"] = executor(payload)
        return result

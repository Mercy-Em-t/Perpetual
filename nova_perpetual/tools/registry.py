"""
Nova tool registry - the single source of truth for every action Nova can take.
The same registry is exposed to the in-process agent loop and to external
agents via the MCP server (nova_perpetual/tools/mcp_server.py).

Every handler receives a ToolContext carrying the verified Principal, and
enforces its own data scope (ownership, self-only, limits).
"""

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List

from nova_perpetual.config import NovaSettings
from nova_perpetual.llm.base import ToolSpec
from nova_perpetual.security import rbac
from nova_perpetual.security.principal import Principal, _clean_phone
from nova_perpetual.storage import NovaStore
from nova_perpetual.tools.backend import PerpetualBackend

STAFF_ORDER_ROLES = {"EXECUTIVE", "CASHIER", "PACKAGER", "QA_INSPECTOR", "COURIER", "SUPPORT_ENGINEER"}


@dataclass
class ToolContext:
    principal: Principal
    backend: PerpetualBackend
    store: NovaStore
    settings: NovaSettings
    trace_id: str = ""


@dataclass
class Tool:
    name: str
    description: str
    parameters: Dict[str, Any]
    side_effect: bool
    handler: Callable[..., Dict[str, Any]]

    def spec(self) -> ToolSpec:
        return ToolSpec(self.name, self.description, self.parameters)


def _deny(msg: str = "You are not authorized to access this information.") -> Dict[str, Any]:
    return {"error": msg, "denied": True}


def _owns_order(p: Principal, order: Dict[str, Any]) -> bool:
    if p.role in STAFF_ORDER_ROLES:
        return True
    return p.is_customer and _clean_phone(p.phone) and _clean_phone(order.get("customer_phone")) == _clean_phone(p.phone)


# ---------------------------------------------------------------- handlers
def get_order_status(ctx: ToolContext, order_id: str) -> Dict[str, Any]:
    order = ctx.backend.get_order(order_id)
    # Same message for "missing" and "not yours" so ownership can't be probed
    if not order or not _owns_order(ctx.principal, order):
        return {"error": f"I couldn't find order {order_id} on your account."}
    station = order.get("station", "UNKNOWN")
    courier = order.get("courier_name") or "not yet assigned"
    return {"order_id": order["order_id"], "station": station, "courier": courier,
            "summary": f"Order {order['order_id']} is at station {station} (courier: {courier})."}


def list_my_orders(ctx: ToolContext) -> Dict[str, Any]:
    if not ctx.principal.phone:
        return {"orders": [], "summary": "No orders are linked to your account."}
    orders = ctx.backend.list_orders_for_phone(ctx.principal.phone)
    slim = [{"order_id": o["order_id"], "station": o.get("station"), "total_amount": o.get("total_amount")}
            for o in orders]
    return {"orders": slim, "summary": f"You have {len(slim)} order(s): " +
            ", ".join(f"{o['order_id']} ({o['station']})" for o in slim)}


def issue_refund(ctx: ToolContext, order_id: str, reason: str = "", amount: float = None) -> Dict[str, Any]:
    order = ctx.backend.get_order(order_id)
    if not order or not _owns_order(ctx.principal, order):
        return {"error": f"I couldn't find order {order_id} on your account."}
    total = float(order.get("total_amount") or 0)
    amount = total if amount is None else float(amount)
    if amount <= 0 or amount > total:
        return {"error": f"Refund amount must be between 0 and the order total ({total:.2f})."}
    existing = ctx.store.query_one(
        "SELECT refund_id, status FROM refunds WHERE order_id=? AND status IN ('ISSUED','PENDING_APPROVAL')",
        (order["order_id"],))
    if existing:
        return {"error": f"Order {order['order_id']} already has a refund ({existing['status']})."}

    limit = ctx.settings.refund_auto_approve_limit
    status = "ISSUED" if amount <= limit else "PENDING_APPROVAL"
    refund_id = f"RF-{uuid.uuid4().hex[:6].upper()}"
    now = time.time()
    ctx.store.execute(
        "INSERT INTO refunds (refund_id, order_id, amount, currency, reason, status, requested_by, trace_id,"
        " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (refund_id, order["order_id"], amount, order.get("currency", "USD"), reason, status,
         ctx.principal.user_id, ctx.trace_id, now, now))
    cur = order.get("currency", "USD")
    if status == "ISSUED":
        return {"refund_id": refund_id, "status": status, "amount": amount,
                "summary": f"Refund {refund_id} of {cur} {amount:.2f} for {order['order_id']} has been issued."}
    from nova_perpetual.approvals import ApprovalService
    ApprovalService(ctx.store).request(
        kind="refund_over_limit", payload={"refund_id": refund_id},
        reason=f"Refund {cur} {amount:.2f} exceeds the {cur} {limit:.2f} auto-approval limit",
        requested_by=ctx.principal.user_id, trace_id=ctx.trace_id)
    ctx.backend.notify("executive_oversight",
                       f"Refund {refund_id} ({cur} {amount:.2f}, {order['order_id']}) awaits approval.")
    return {"refund_id": refund_id, "status": status, "amount": amount,
            "summary": f"Refund {refund_id} of {cur} {amount:.2f} is above the {cur} {limit:.0f} limit, "
                       f"so it has been sent to a manager for approval."}


def open_ticket(ctx: ToolContext, title: str, description: str = "", severity: str = "MEDIUM") -> Dict[str, Any]:
    t = ctx.backend.create_ticket(title=title[:120], description=description[:2000],
                                  reported_by=f"nova:{ctx.principal.user_id}", severity=severity.upper())
    return {"ticket_id": t.get("ticket_id"), "summary": f"Ticket {t.get('ticket_id')} has been opened."}


def notify_team(ctx: ToolContext, department: str, message: str) -> Dict[str, Any]:
    allowed = {"floor_operations", "executive_oversight", "quality_desk"}
    if department not in allowed:
        return {"error": f"Unknown department. Choose one of {sorted(allowed)}."}
    ctx.backend.notify(department, f"{message} (from {ctx.principal.name})")
    return {"summary": f"The {department.replace('_', ' ')} team has been notified."}


def get_compensation(ctx: ToolContext, employee: str) -> Dict[str, Any]:
    staff = ctx.backend.hr_directory()
    me = next((e for e in staff if e["member_id"] == ctx.principal.user_id), None)
    q = (employee or "").strip().lower()
    if q in ("me", "myself", "my salary", "self", ""):
        target = me
    elif "manager" in q and me:
        target = next((e for e in staff if e["member_id"] == me.get("manager_id")), None)
    else:
        target = next((e for e in staff if q == e["member_id"] or q in e["name"].lower()
                       or e["name"].lower() in q), None)

    is_self = target is not None and me is not None and target["member_id"] == me["member_id"]
    if not is_self and ctx.principal.role not in rbac.COMPENSATION_ADMINS:
        return _deny("Compensation details are confidential. Only HR can share another employee's pay.")
    if not target:
        return {"error": "No matching employee record."}
    return {"employee": target["name"], "monthly_salary_usd": target["monthly_salary_usd"],
            "summary": f"{target['name']}'s monthly salary is USD {target['monthly_salary_usd']:,}."}


# ---------------------------------------------------------------- registry
def _obj(props: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {"type": "object", "properties": props, "required": required}


TOOLS: Dict[str, Tool] = {t.name: t for t in [
    Tool("get_order_status", "Look up the current fulfilment station of an order the caller is allowed to see.",
         _obj({"order_id": {"type": "string", "description": "Order ID, e.g. ORD-1001"}}, ["order_id"]),
         False, get_order_status),
    Tool("list_my_orders", "List the orders that belong to the calling customer.", _obj({}, []),
         False, list_my_orders),
    Tool("issue_refund", "Issue a refund for an order. Amounts above the auto-approval limit are queued for a manager.",
         _obj({"order_id": {"type": "string"}, "reason": {"type": "string"},
               "amount": {"type": "number", "description": "Defaults to the full order total"}}, ["order_id"]),
         True, issue_refund),
    Tool("open_ticket", "Open a support/incident ticket for the quality desk.",
         _obj({"title": {"type": "string"}, "description": {"type": "string"},
               "severity": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"]}}, ["title"]),
         True, open_ticket),
    Tool("notify_team", "Send a message to a Perpetua team channel (WhatsApp Community group).",
         _obj({"department": {"type": "string", "enum": ["floor_operations", "executive_oversight", "quality_desk"]},
               "message": {"type": "string"}}, ["department", "message"]),
         True, notify_team),
    Tool("get_compensation", "Get salary information. Employees may see their own; only HR/executives may see others.",
         _obj({"employee": {"type": "string", "description": "'me', 'my manager', or an employee name"}},
              ["employee"]),
         False, get_compensation),
]}


def tools_for(principal: Principal) -> List[Tool]:
    return [TOOLS[n] for n in rbac.allowed_tools(principal, list(TOOLS))]


def execute_tool(ctx: ToolContext, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """RBAC-checked execution. Called by the agent loop, approvals and the MCP server."""
    tool = TOOLS.get(name)
    if not tool:
        return {"error": f"Unknown tool {name}"}
    if not rbac.can_use_tool(ctx.principal, name):
        return _deny(f"Your role ({ctx.principal.role}) is not permitted to use {name}.")
    try:
        return tool.handler(ctx, **(arguments or {}))
    except TypeError as e:
        return {"error": f"Invalid arguments for {name}: {e}"}


def to_json(result: Dict[str, Any]) -> str:
    return json.dumps(result, default=str)

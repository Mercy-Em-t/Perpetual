"""
Role-based access control for Nova.
Two layers:
  1. Tool permissions  - which roles may even see/call a tool.
  2. Knowledge audiences - which document audiences a role may retrieve.
Data-scope checks (e.g. "customers only see their own orders") live inside the
tools themselves, because only the tool knows who owns a record.
"""

from typing import Dict, List, Set

from nova_perpetual.security.principal import Principal

ALL_STAFF = {"EXECUTIVE", "CASHIER", "PACKAGER", "QA_INSPECTOR", "COURIER",
             "SPATIAL_ARTIST", "SUPPORT_ENGINEER", "HR_MANAGER"}

TOOL_PERMISSIONS: Dict[str, Set[str]] = {
    "get_order_status": ALL_STAFF | {"CUSTOMER"},
    "list_my_orders": {"CUSTOMER", "EXECUTIVE", "CASHIER"},
    "issue_refund": {"CUSTOMER", "EXECUTIVE", "CASHIER"},
    "open_ticket": ALL_STAFF | {"CUSTOMER"},
    "notify_team": {"EXECUTIVE", "CASHIER", "PACKAGER", "QA_INSPECTOR", "COURIER", "SUPPORT_ENGINEER"},
    # Anyone may ask; the tool enforces "self only" unless HR/EXECUTIVE
    "get_compensation": ALL_STAFF,
}

AUDIENCES: Dict[str, Set[str]] = {
    "CUSTOMER": {"public"},
    "HR_MANAGER": {"public", "staff", "hr"},
    "EXECUTIVE": {"public", "staff", "hr"},
}
DEFAULT_STAFF_AUDIENCE = {"public", "staff"}

COMPENSATION_ADMINS = {"HR_MANAGER", "EXECUTIVE"}


def can_use_tool(principal: Principal, tool_name: str) -> bool:
    return principal.role in TOOL_PERMISSIONS.get(tool_name, set())


def allowed_tools(principal: Principal, tool_names: List[str]) -> List[str]:
    return [t for t in tool_names if can_use_tool(principal, t)]


def allowed_audiences(principal: Principal) -> Set[str]:
    if principal.role in AUDIENCES:
        return AUDIENCES[principal.role]
    return DEFAULT_STAFF_AUDIENCE if principal.role in ALL_STAFF else {"public"}

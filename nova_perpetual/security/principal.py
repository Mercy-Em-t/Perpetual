"""
Identity: the Principal travels with every request and into every tool call.

Tokens are standard HS256 JWTs so an external OAuth/OIDC identity provider can
replace `issue_token` later without touching tools - they only ever see a
verified Principal, never a user-supplied claim of who they are.
"""

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import asdict, dataclass, field
from typing import List, Optional

from nova_perpetual.config import PROJECT_DIR

ORG_CONFIG_PATH = os.path.join(PROJECT_DIR, "config", "organization.json")


class AuthError(Exception):
    pass


@dataclass(frozen=True)
class Principal:
    user_id: str
    name: str
    role: str                      # EXECUTIVE, CASHIER, ..., HR_MANAGER, CUSTOMER
    tenant: str = "org_perpetua_001"
    phone: str = ""
    departments: tuple = field(default_factory=tuple)
    manager_id: Optional[str] = None

    @property
    def is_customer(self) -> bool:
        return self.role == "CUSTOMER"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_token(p: Principal, secret: str, ttl_seconds: int = 3600) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    claims = {**asdict(p), "departments": list(p.departments), "sub": p.user_id, "iat": now, "exp": now + ttl_seconds}
    signing_input = f"{_b64(json.dumps(header).encode())}.{_b64(json.dumps(claims).encode())}"
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{_b64(sig)}"


def verify_token(token: str, secret: str) -> Principal:
    try:
        h, c, s = token.split(".")
    except ValueError:
        raise AuthError("Malformed token")
    expected = hmac.new(secret.encode(), f"{h}.{c}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _unb64(s)):
        raise AuthError("Invalid token signature")
    header = json.loads(_unb64(h))
    if header.get("alg") != "HS256":
        raise AuthError("Unsupported token algorithm")
    claims = json.loads(_unb64(c))
    if claims.get("exp", 0) < time.time():
        raise AuthError("Token expired")
    return Principal(user_id=claims["user_id"], name=claims["name"], role=claims["role"],
                     tenant=claims.get("tenant", "org_perpetua_001"), phone=claims.get("phone", ""),
                     departments=tuple(claims.get("departments", [])), manager_id=claims.get("manager_id"))


def _clean_phone(phone: str) -> str:
    return "".join(ch for ch in (phone or "") if ch.isdigit())[-9:]


def principal_from_org_member(phone: str, org_path: str = ORG_CONFIG_PATH) -> Optional[Principal]:
    """Resolve a WhatsApp sender to a staff Principal using config/organization.json."""
    if not os.path.exists(org_path):
        return None
    with open(org_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    target = _clean_phone(phone)
    for m in cfg.get("members", []):
        if target and _clean_phone(m.get("phone")) == target:
            return Principal(user_id=m["member_id"], name=m.get("name", ""), role=m.get("role", "CUSTOMER"),
                             tenant=cfg.get("organization", {}).get("org_id", "org_perpetua_001"),
                             phone=m.get("phone", ""), departments=tuple(m.get("assigned_departments", [])),
                             manager_id=m.get("manager_id"))
    return None


def customer_principal(phone: str, name: str = "Customer") -> Principal:
    return Principal(user_id=f"cust_{_clean_phone(phone)}", name=name, role="CUSTOMER", phone=phone)

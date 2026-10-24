"""
Organization & Policy Engine Model
Loads declarative organization business processes, departments, members, and RBAC rules.
"""

import os
import json
import time
from typing import Dict, Any, List, Optional

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config", "organization.json")


class OrganizationManager:
    _cached_config: Optional[Dict[str, Any]] = None
    _last_load_time: float = 0

    @classmethod
    def get_config(cls, force_reload=False) -> Dict[str, Any]:
        """Loads and caches organization.json, reloading on change."""
        now = time.time()
        if not force_reload and cls._cached_config and (now - cls._last_load_time < 30):
            return cls._cached_config

        if not os.path.exists(CONFIG_PATH):
            return {}

        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cls._cached_config = json.load(f)
                cls._last_load_time = now
                return cls._cached_config
        except Exception as e:
            print(f"[!] Error loading organization config: {e}")
            return cls._cached_config or {}

    @classmethod
    def get_organization_info(cls) -> Dict[str, Any]:
        return cls.get_config().get("organization", {})

    @classmethod
    def get_departments(cls) -> Dict[str, Any]:
        return cls.get_config().get("departments", {})

    @classmethod
    def get_roles(cls) -> Dict[str, Any]:
        return cls.get_config().get("roles", {})

    @classmethod
    def get_members(cls) -> List[Dict[str, Any]]:
        return cls.get_config().get("members", [])

    @classmethod
    def get_business_process(cls) -> Dict[str, Any]:
        return cls.get_config().get("business_process", {})

    @classmethod
    def find_member_by_phone(cls, phone: str) -> Optional[Dict[str, Any]]:
        """Matches international or local phone numbers."""
        clean_target = phone.replace("+", "").replace("@s.whatsapp.net", "").strip()
        for m in cls.get_members():
            clean_member = m.get("phone", "").replace("+", "").strip()
            if clean_member and (clean_target.endswith(clean_member) or clean_member.endswith(clean_target)):
                return m
        return None

    @classmethod
    def can_execute_command(cls, phone: str, command: str) -> Dict[str, Any]:
        """
        Enforces Role-Based Access Control (RBAC).
        Returns {'allowed': bool, 'role': str, 'reason': str}
        """
        member = cls.find_member_by_phone(phone)
        cmd_clean = command.strip().lower()
        if not cmd_clean.startsWith("!"):
            cmd_clean = "!" + cmd_clean

        # If user is not in directory, default to basic read-only commands
        if not member:
            public_commands = ["!help", "!status", "!health", "!orders"]
            if cmd_clean in public_commands:
                return {"allowed": True, "role": "GUEST", "member_name": "Guest"}
            return {
                "allowed": False,
                "role": "GUEST",
                "member_name": "Guest",
                "reason": f"Phone number not registered in Organization directory. Cannot run '{cmd_clean}'."
            }

        role_name = member.get("role", "GUEST")
        roles = cls.get_roles()
        role_def = roles.get(role_name, {})
        allowed_cmds = role_def.get("allowed_commands", [])

        # Wildcard superuser (EXECUTIVE)
        if "*" in allowed_cmds:
            return {"allowed": True, "role": role_name, "member_name": member.get("name")}

        # Exact command match
        if cmd_clean in [c.lower() for c in allowed_cmds]:
            return {"allowed": True, "role": role_name, "member_name": member.get("name")}

        return {
            "allowed": False,
            "role": role_name,
            "member_name": member.get("name"),
            "reason": f"Role '{role_name}' is not authorized to execute '{cmd_clean}'."
        }

    @classmethod
    def get_station_sla_minutes(cls, station_id: str) -> Optional[int]:
        stations = cls.get_business_process().get("stations", [])
        for s in stations:
            if s.get("id") == station_id.upper():
                return s.get("sla_minutes")
        return None

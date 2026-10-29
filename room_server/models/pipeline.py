"""
Tenant Pipeline Engine
Loads and validates shop-specific operational pipelines from config/shops/<slug>.json.
Enforces per-shop station sequencing, action commands, and authorized roles.
"""

import os
import json
from typing import Dict, Any, List, Optional, Tuple

CONFIG_SHOPS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "config", "shops"
)


class PipelineManager:
    _cache: Dict[str, Dict[str, Any]] = {}

    @classmethod
    def get_shop_pipeline(cls, shop_slug: str) -> Optional[Dict[str, Any]]:
        """Loads and caches the pipeline definition for a shop."""
        if not shop_slug:
            shop_slug = "leahs-kitchen"

        file_path = os.path.join(CONFIG_SHOPS_DIR, f"{shop_slug}.json")
        if not os.path.exists(file_path):
            # Fallback to leahs-kitchen if specific shop config not found
            file_path = os.path.join(CONFIG_SHOPS_DIR, "leahs-kitchen.json")
            if not os.path.exists(file_path):
                return None

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                cls._cache[shop_slug] = data
                return data
        except Exception as e:
            print(f"[PIPELINE ERROR] Could not read pipeline for {shop_slug}: {e}")
            return None

    @classmethod
    def get_initial_station(cls, shop_slug: str) -> str:
        """Returns the entry station for new orders."""
        pipeline_data = cls.get_shop_pipeline(shop_slug)
        if pipeline_data and "pipeline" in pipeline_data:
            return pipeline_data["pipeline"].get("initial_station", "PENDING")
        return "PENDING"

    @classmethod
    def get_stations(cls, shop_slug: str) -> List[Dict[str, Any]]:
        """Returns all stations for a shop."""
        pipeline_data = cls.get_shop_pipeline(shop_slug)
        if pipeline_data and "pipeline" in pipeline_data:
            return pipeline_data["pipeline"].get("stations", [])
        return []

    @classmethod
    def get_station_info(cls, shop_slug: str, station_id: str) -> Optional[Dict[str, Any]]:
        """Finds details for a specific station."""
        stations = cls.get_stations(shop_slug)
        for s in stations:
            if s.get("id", "").upper() == station_id.upper():
                return s
        return None

    @classmethod
    def resolve_next_station(
        cls, shop_slug: str, current_station: str, action_command: Optional[str] = None
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Determines the next station from current_station and action_command.
        Returns: (is_valid, next_station_id, error_message)
        """
        curr_info = cls.get_station_info(shop_slug, current_station)
        if not curr_info:
            return False, None, f"Current station '{current_station}' not recognized for shop '{shop_slug}'"

        expected_command = curr_info.get("action_command", "").lower()
        if action_command and expected_command:
            norm_action = action_command.lower() if action_command.startswith("!") else f"!{action_command.lower()}"
            if norm_action != expected_command:
                return False, None, f"Station '{current_station}' requires command '{expected_command}', got '{norm_action}'"

        next_station = curr_info.get("next")
        if not next_station:
            return False, None, f"Station '{current_station}' is a terminal state; no next station defined."

        return True, next_station, None

    @classmethod
    def validate_role_authorization(
        cls, shop_slug: str, current_station: str, role: str
    ) -> bool:
        """Checks if a staff role is allowed to advance from current_station."""
        if role.upper() in ("EXECUTIVE", "MANAGEMENT", "ADMIN", "OWNER"):
            return True

        curr_info = cls.get_station_info(shop_slug, current_station)
        if not curr_info:
            return True

        authorized = [r.upper() for r in curr_info.get("authorized_roles", [])]
        return role.upper() in authorized

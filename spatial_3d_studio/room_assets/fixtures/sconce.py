"""
Sconce wall fixture featuring coordinate pinning and matrix locking.
"""

from __future__ import annotations
import math
from typing import Optional, Tuple, Dict, Any
import numpy as np
from ..core.base import SceneObject
from ..core.wall import Wall
from ..core.camera import Camera


class Sconce(SceneObject):
    """
    Configurable wall fixture featuring coordinate pinning and matrix locking
    to prevent drift across camera re-renders and room updates.
    """

    def __init__(
        self,
        style: str = "modern_cylindrical_industrial",
        housing_color: str = "dark_grey",
        glass_diffuser: str = "ribbed_clear",
        light_state: str = "on",
        light_temperature: str = "warm_amber_glow",
        dimensions: Tuple[float, float, float] = (0.09, 0.20, 0.12)
    ):
        rgb = (50, 52, 55) if housing_color == "dark_grey" else (30, 30, 30)
        super().__init__(name="Sconce", dimensions=dimensions, color=rgb, material="brushed_metal_and_glass")
        self.style = style
        self.housing_color = housing_color
        self.glass_diffuser = glass_diffuser
        self.light_state = light_state
        self.light_temperature = light_temperature
        self._drift_accumulator: float = 0.0

    def anchor_to(
        self,
        surface: Wall,
        coordinates: Tuple[float, float, float],
        locking: bool = True
    ) -> Sconce:
        """
        Locks transformation matrices to prevent drift across camera re-renders.
        Pins the sconce relative to the target surface plane.
        """
        super().anchor_to(surface, coordinates, locking=locking)
        return self

    def get_light_emission_color(self) -> Tuple[int, int, int]:
        """Maps light_temperature string to RGB color values."""
        if self.light_temperature == "warm_amber_glow":
            return (255, 190, 115)  # ~2400K Warm amber
        elif self.light_temperature == "soft_white":
            return (255, 230, 185)  # ~3000K Soft white
        elif self.light_temperature == "neutral":
            return (255, 255, 250)
        return (255, 200, 130)

    def verify_lock_integrity(self, current_camera: Optional[Camera] = None) -> Dict[str, Any]:
        """
        Verifies coordinate locking integrity and checks for matrix drift.
        Returns drift statistics (drift is strictly 0.000000 when locked).
        """
        if not self.is_locked or self._locked_world_position is None:
            return {
                "locked": False,
                "drift_magnitude": self._drift_accumulator,
                "status": "UNLOCKED"
            }
            
        current_pos = self.get_world_position()
        drift = float(np.linalg.norm(current_pos - self._locked_world_position))
        
        return {
            "locked": True,
            "anchor_coordinates": self.anchor_coordinates,
            "world_position": self._locked_world_position.tolist(),
            "drift_magnitude": drift,
            "status": "PINNED_ZERO_DRIFT" if drift < 1e-12 else "DRIFT_DETECTED"
        }

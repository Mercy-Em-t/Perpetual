"""
Decorative vessels: Vase, Candle, PerfumeBottle, and Tin.
"""

from __future__ import annotations
from typing import Optional, Tuple
from ..core.base import SceneObject


class Vase(SceneObject):
    """Ceramic or stoneware decorative vase."""

    def __init__(
        self,
        shape: str = "minimalist_cylinder",
        color: str = "cream",
        material: str = "matte_ceramic",
        height: float = 0.22,
        dimensions: Optional[Tuple[float, float, float]] = None
    ):
        dims = dimensions or (0.10, height, 0.10)
        rgb = (230, 225, 215) if color == "cream" else (180, 120, 95)
        super().__init__(name=f"Vase_{shape}", dimensions=dims, color=rgb, material=material)
        self.shape = shape


class Candle(SceneObject):
    """Artisan wax candle in vessel."""

    def __init__(
        self,
        vessel: str = "ribbed_glass",
        wax_color: str = "ivory",
        wick_state: str = "unlit",
        scent_notes: str = "cedarwood_vanilla",
        dimensions: Tuple[float, float, float] = (0.08, 0.10, 0.08)
    ):
        super().__init__(name=f"Candle_{vessel}", dimensions=dimensions, color=(240, 235, 220), material="wax_glass")
        self.vessel = vessel
        self.wax_color = wax_color
        self.wick_state = wick_state
        self.scent_notes = scent_notes


class PerfumeBottle(SceneObject):
    """Glass perfume bottle or flacon."""

    def __init__(
        self,
        bottle_shape: str = "faceted_crystal",
        cap_finish: str = "gold",
        fluid_color: str = "amber",
        dimensions: Tuple[float, float, float] = (0.06, 0.12, 0.06)
    ):
        super().__init__(name=f"PerfumeBottle_{bottle_shape}", dimensions=dimensions, color=(210, 175, 110), material="glass")
        self.bottle_shape = bottle_shape
        self.cap_finish = cap_finish
        self.fluid_color = fluid_color


class Tin(SceneObject):
    """Metal canister, tea tin, or decorative vessel."""

    def __init__(
        self,
        finish: str = "brushed_brass",
        size: str = "small",
        dimensions: Tuple[float, float, float] = (0.09, 0.09, 0.09)
    ):
        rgb = (185, 150, 90) if "brass" in finish else (70, 70, 70)
        super().__init__(name=f"Tin_{finish}", dimensions=dimensions, color=rgb, material="metal")
        self.finish = finish
        self.size = size

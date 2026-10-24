"""
Spatial Nook Furniture: BlueVelvetSofa and SwivelBracketTVMount.
"""

from __future__ import annotations
from typing import Optional, Tuple
from ..core.base import SceneObject


class BlueVelvetSofa(SceneObject):
    """
    Blue velvet sofa designed flush against the back wall beneath sconce and daylight window.
    Standard 2.5-tile width alcove fit.
    """

    def __init__(
        self,
        width: float = 1.80,
        depth: float = 0.85,
        height: float = 0.80,
        fabric: str = "royal_blue_velvet",
        color: Tuple[int, int, int] = (25, 45, 90),
        cushions: int = 3
    ):
        super().__init__(
            name="BlueVelvetSofa",
            dimensions=(width, height, depth),
            color=color,
            material=fabric
        )
        self.fabric = fabric
        self.cushions = cushions


class SwivelBracketTVMount(SceneObject):
    """
    Articulating swivel wall bracket holding a flat-screen display on the wall
    to optimize viewing distance without blocking walkway.
    """

    def __init__(
        self,
        screen_size_inches: int = 55,
        swivel_angle_deg: float = 25.0,
        bracket_color: str = "matte_black",
        dimensions: Tuple[float, float, float] = (1.23, 0.71, 0.08)
    ):
        super().__init__(
            name=f"SwivelTV_{screen_size_inches}in",
            dimensions=dimensions,
            color=(20, 20, 20),
            material="metal_and_display"
        )
        self.screen_size_inches = screen_size_inches
        self.swivel_angle_deg = swivel_angle_deg
        self.bracket_color = bracket_color

"""
Textiles and boho wall hangings: WallHanging, Macrame, and JuteRunner.
"""

from __future__ import annotations
from typing import Tuple
from ..core.base import SceneObject


class WallHanging(SceneObject):
    """Tapestry, woven boho macrame, or framed wall art."""

    def __init__(
        self,
        style: str = "boho_macrame",
        width: float = 0.45,
        height: float = 0.70,
        color: Tuple[int, int, int] = (220, 210, 195)
    ):
        super().__init__(name=f"WallHanging_{style}", dimensions=(width, height, 0.03), color=color, material="woven_textile")
        self.style = style


class Macrame(SceneObject):
    """Hand-knotted macrame fiber art with hanging fringe."""

    def __init__(
        self,
        pattern: str = "diamond_chevron",
        cord_material: str = "natural_cotton",
        fringe_length: float = 0.25,
        width: float = 0.40,
        height: float = 0.65,
        color: Tuple[int, int, int] = (235, 230, 218)
    ):
        super().__init__(name=f"Macrame_{pattern}", dimensions=(width, height, 0.04), color=color, material=cord_material)
        self.pattern = pattern
        self.fringe_length = fringe_length


class JuteRunner(SceneObject):
    """Woven natural jute floor runner rug for boho nook aesthetics."""

    def __init__(
        self,
        width: float = 0.80,
        length: float = 2.40,
        weave_texture: str = "braided_loop",
        color: Tuple[int, int, int] = (195, 170, 130)
    ):
        super().__init__(name="JuteRunner", dimensions=(width, 0.015, length), color=color, material="jute_fiber")
        self.weave_texture = weave_texture

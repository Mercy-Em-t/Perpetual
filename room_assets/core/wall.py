"""
Surface Plane (Wall) defining spatial boundaries, texture, and child anchors.
"""

from __future__ import annotations
from typing import Optional, Tuple, Any, List
import numpy as np
from .base import create_translation_matrix


class Wall:
    """Base surface plane defining spatial boundaries, texture, and child anchors."""

    def __init__(
        self,
        id: str = "left_matte_white_wall",
        dimensions: Tuple[float, float, float] = (1.0, 1.0, 0.05),
        texture: str = "solid_matte_plaster",
        color: Tuple[int, int, int] = (245, 245, 242),
        origin: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    ):
        self.id = id
        self.dimensions = dimensions  # (width, height, thickness)
        self.texture = texture
        self.color = color
        self.origin = np.array(origin, dtype=np.float64)
        self.transform_matrix = create_translation_matrix(*origin)
        self.children: List[Any] = []
        self.scene: Optional[Any] = None

    def get_world_coordinates(self, normalized_coords: Tuple[float, float, float]) -> np.ndarray:
        """
        Maps normalized surface coordinates (u, v, w) in [0, 1] to 3D world coordinates.
        u: horizontal along wall
        v: vertical along wall (0 = top, 1 = bottom)
        w: depth offset normal to wall (w = 0 is flush against plaster surface)
        """
        u, v, w = normalized_coords
        width, height, _ = self.dimensions
        local_x = u * width
        local_y = (1.0 - v) * height  # Invert Y so v=0 is upper wall, matching image coordinates
        local_z = w
        local_pt = np.array([local_x, local_y, local_z, 1.0], dtype=np.float64)
        world_pt = self.transform_matrix @ local_pt
        return world_pt[:3]

    def add_child(self, child: Any) -> None:
        """Registers a child object attached to this wall plane."""
        if child not in self.children:
            self.children.append(child)

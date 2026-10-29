"""
Core base classes and spatial transformation primitives.
"""

from __future__ import annotations
import math
from typing import Optional, Tuple, Any, List
import numpy as np


def create_translation_matrix(tx: float, ty: float, tz: float) -> np.ndarray:
    """Creates a 4x4 homogeneous translation matrix."""
    mat = np.eye(4, dtype=np.float64)
    mat[0, 3] = tx
    mat[1, 3] = ty
    mat[2, 3] = tz
    return mat


def create_scale_matrix(sx: float, sy: float, sz: float) -> np.ndarray:
    """Creates a 4x4 homogeneous scaling matrix."""
    mat = np.eye(4, dtype=np.float64)
    mat[0, 0] = sx
    mat[1, 1] = sy
    mat[2, 2] = sz
    return mat


def create_rotation_matrix(rx_deg: float = 0.0, ry_deg: float = 0.0, rz_deg: float = 0.0) -> np.ndarray:
    """Creates a 4x4 homogeneous Euler rotation matrix (XYZ ordering)."""
    rx, ry, rz = np.radians(rx_deg), np.radians(ry_deg), np.radians(rz_deg)
    
    Rx = np.array([
        [1, 0, 0, 0],
        [0, np.cos(rx), -np.sin(rx), 0],
        [0, np.sin(rx), np.cos(rx), 0],
        [0, 0, 0, 1]
    ], dtype=np.float64)
    
    Ry = np.array([
        [np.cos(ry), 0, np.sin(ry), 0],
        [0, 1, 0, 0],
        [-np.sin(ry), 0, np.cos(ry), 0],
        [0, 0, 0, 1]
    ], dtype=np.float64)
    
    Rz = np.array([
        [np.cos(rz), -np.sin(rz), 0, 0],
        [np.sin(rz), np.cos(rz), 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ], dtype=np.float64)
    
    return Rz @ Ry @ Rx


class SceneObject:
    """Base class for all placeable scene assets with anchoring and transformation pinning."""

    def __init__(
        self,
        name: str = "SceneObject",
        dimensions: Tuple[float, float, float] = (0.1, 0.1, 0.1),
        color: Tuple[int, int, int] = (180, 180, 180),
        material: str = "generic"
    ):
        self.name = name
        self.dimensions = dimensions
        self.color = color
        self.material = material
        self.surface: Optional[Any] = None
        self.anchor_coordinates: Optional[Tuple[float, float, float]] = None
        self.is_locked: bool = False
        self.transform_matrix: np.ndarray = np.eye(4, dtype=np.float64)
        self._locked_transform: Optional[np.ndarray] = None
        self._locked_world_position: Optional[np.ndarray] = None

    def anchor_to(
        self,
        surface: Any,
        coordinates: Tuple[float, float, float],
        locking: bool = True
    ) -> SceneObject:
        """
        Anchors this asset to a target surface plane at specified normalized coordinates.
        When locking=True, freezes transformation matrices to guarantee zero drift.
        """
        self.surface = surface
        self.anchor_coordinates = coordinates
        self.is_locked = locking
        
        # Calculate world transform
        world_pos = surface.get_world_coordinates(coordinates)
        self.transform_matrix = create_translation_matrix(*world_pos)
        
        if locking:
            self._locked_transform = self.transform_matrix.copy()
            self._locked_world_position = world_pos.copy()
            
        surface.add_child(self)
        return self

    def get_world_position(self) -> np.ndarray:
        """Returns the world position vector, strictly enforcing lock if enabled."""
        if self.is_locked and self._locked_world_position is not None:
            return self._locked_world_position.copy()
        return self.transform_matrix[:3, 3].copy()

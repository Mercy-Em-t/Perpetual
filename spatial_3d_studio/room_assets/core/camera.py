"""
Simulated perspective camera for view projection and drift testing.
"""

from __future__ import annotations
import math
from typing import Tuple
import numpy as np


class Camera:
    """Simulated perspective camera for view projection and drift testing."""

    def __init__(
        self,
        position: Tuple[float, float, float] = (0.5, 0.5, 2.0),
        target: Tuple[float, float, float] = (0.5, 0.5, 0.0),
        up: Tuple[float, float, float] = (0.0, 1.0, 0.0),
        fov_deg: float = 60.0,
        aspect_ratio: float = 1.0,
        near: float = 0.1,
        far: float = 100.0
    ):
        self.position = np.array(position, dtype=np.float64)
        self.target = np.array(target, dtype=np.float64)
        self.up = np.array(up, dtype=np.float64)
        self.fov_deg = fov_deg
        self.aspect_ratio = aspect_ratio
        self.near = near
        self.far = far

    def get_view_matrix(self) -> np.ndarray:
        """Returns 4x4 camera view matrix (LookAt)."""
        forward = self.target - self.position
        norm_f = np.linalg.norm(forward)
        forward = forward / (norm_f if norm_f != 0 else 1.0)
        
        right = np.cross(forward, self.up)
        norm_r = np.linalg.norm(right)
        right = right / (norm_r if norm_r != 0 else 1.0)
        
        true_up = np.cross(right, forward)
        
        R = np.eye(4, dtype=np.float64)
        R[0, :3] = right
        R[1, :3] = true_up
        R[2, :3] = -forward
        
        T = np.eye(4, dtype=np.float64)
        T[:3, 3] = -self.position
        
        return R @ T

    def get_projection_matrix(self) -> np.ndarray:
        """Returns 4x4 perspective projection matrix."""
        f = 1.0 / np.tan(np.radians(self.fov_deg) / 2.0)
        mat = np.zeros((4, 4), dtype=np.float64)
        mat[0, 0] = f / self.aspect_ratio
        mat[1, 1] = f
        mat[2, 2] = (self.far + self.near) / (self.near - self.far)
        mat[2, 3] = (2.0 * self.far * self.near) / (self.near - self.far)
        mat[3, 2] = -1.0
        return mat

    def project_point(self, world_pt: np.ndarray, viewport_size: Tuple[int, int]) -> Tuple[float, float]:
        """Projects a 3D world coordinate into 2D viewport coordinates."""
        pt4 = np.array([world_pt[0], world_pt[1], world_pt[2], 1.0], dtype=np.float64)
        V = self.get_view_matrix()
        P = self.get_projection_matrix()
        
        clip = P @ V @ pt4
        if clip[3] != 0:
            ndc = clip[:3] / clip[3]
        else:
            ndc = clip[:3]
            
        w, h = viewport_size
        screen_x = (ndc[0] * 0.5 + 0.5) * w
        screen_y = (1.0 - (ndc[1] * 0.5 + 0.5)) * h
        return float(screen_x), float(screen_y)

"""
Photometric Lighting Engine and illumination field calculation.
"""

from __future__ import annotations
import math
from typing import Optional, Tuple, Dict, Any, List
import numpy as np
from ..fixtures.sconce import Sconce
from .wall import Wall


class LightingEngine:
    """
    Handles global light passes, computes photometric falloff
    (e.g. downward_and_outward_falloff), and applies lighting to scene surfaces.
    """

    def __init__(
        self,
        ambient_intensity: float = 0.35,
        ambient_color: Tuple[int, int, int] = (240, 238, 235)
    ):
        self.ambient_intensity = ambient_intensity
        self.ambient_color = ambient_color
        self.light_sources: List[Dict[str, Any]] = []

    def register_light_source(
        self,
        source: Sconce,
        strength: float = 0.7,
        throw: str = "downward_and_outward_falloff"
    ) -> LightingEngine:
        """Registers an active emitter fixture with specified strength and throw profile."""
        self.light_sources.append({
            "source": source,
            "strength": strength,
            "throw": throw
        })
        # Automatically connect to parent scene if available
        if source.surface is not None and getattr(source.surface, "scene", None) is not None:
            source.surface.scene.lighting_engine = self
        return self

    def compute_photometric_falloff(
        self,
        light_entry: Dict[str, Any],
        canvas_shape: Tuple[int, int]
    ) -> Tuple[np.ndarray, Tuple[int, int, int]]:
        """
        Computes 2D photometric illumination field across surface plane.
        Implements 'downward_and_outward_falloff' photometric profile.
        """
        h, w = canvas_shape
        source: Sconce = light_entry["source"]
        strength: float = light_entry["strength"]
        throw: str = light_entry["throw"]
        
        # Determine anchor coordinates on canvas
        if source.anchor_coordinates is not None:
            norm_x, norm_y, _ = source.anchor_coordinates
            cx = norm_x * w
            cy = norm_y * h
        else:
            cx, cy = w * 0.5, h * 0.2
            
        # Create pixel coordinate grids
        ys, xs = np.mgrid[0:h, 0:w]
        dx = (xs - cx) / float(w)
        dy = (ys - cy) / float(h)
        
        dist = np.sqrt(dx * dx + dy * dy)
        angle = np.arctan2(dy, dx)  # downward is +y, angle in [-pi, pi]
        
        if throw == "downward_and_outward_falloff":
            # Cone oriented downwards (angle centered around pi/2 = 90 degrees)
            downward_dev = np.abs(angle - (math.pi / 2.0))
            
            # Conical beam width ~ 70 degrees spread
            beam_spread = 0.65  # radians
            angular_factor = np.exp(-(downward_dev ** 2) / (2.0 * (beam_spread ** 2)))
            
            # Add outward lateral flare
            lateral_flare = 0.25 * np.exp(-((np.abs(dx) - 0.15) ** 2) / 0.05) * np.clip(dy * 2.0, 0.0, 1.0)
            directional_mask = np.clip(angular_factor + lateral_flare, 0.0, 1.0)
            
            # Photometric distance attenuation: inverse polynomial falloff
            attenuation = 1.0 / (1.0 + 12.0 * dist + 45.0 * (dist ** 2))
            
            # Combine profile
            intensity_map = strength * directional_mask * attenuation
            # Add a subtle direct emitter halo
            halo = strength * 0.45 * np.exp(-(dist ** 2) / 0.003)
            intensity_map = np.clip(intensity_map + halo, 0.0, 1.0)
        else:
            # Omnidirectional fallback
            attenuation = 1.0 / (1.0 + 8.0 * dist + 25.0 * (dist ** 2))
            intensity_map = np.clip(strength * attenuation, 0.0, 1.0)
            
        color = source.get_light_emission_color()
        return intensity_map, color

    def apply_lighting(
        self,
        base_matrix: np.ndarray,
        surfaces: Optional[List[Wall]] = None
    ) -> np.ndarray:
        """
        Applies ambient light and all registered photometric falloffs onto base image matrix.
        Returns illuminated RGB uint8 image matrix.
        """
        h, w, c = base_matrix.shape
        base_float = base_matrix.astype(np.float64) / 255.0
        
        # Base ambient pass
        ambient_rgb = np.array(self.ambient_color, dtype=np.float64) / 255.0
        lit_canvas = base_float * (self.ambient_intensity + (1.0 - self.ambient_intensity) * ambient_rgb)
        
        # Additive light passes
        for light_entry in self.light_sources:
            if light_entry["source"].light_state != "on":
                continue
            falloff_map, color_rgb = self.compute_photometric_falloff(light_entry, (h, w))
            light_rgb = np.array(color_rgb, dtype=np.float64) / 255.0
            
            # Modulate light pass onto surface diffuse reflection
            light_pass = (falloff_map[:, :, np.newaxis]) * light_rgb[np.newaxis, np.newaxis, :]
            lit_canvas = np.clip(lit_canvas + base_float * light_pass * 1.8 + light_pass * 0.35, 0.0, 1.0)
            
        return (lit_canvas * 255.0).astype(np.uint8)

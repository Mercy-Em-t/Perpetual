"""
Botanical elements: Flowers and TrailingPlants.
"""

from __future__ import annotations
from typing import Tuple
from ..core.base import SceneObject


class Flowers(SceneObject):
    """Dried or fresh botanical floral arrangement."""

    def __init__(
        self,
        flower_type: str = "dried_hydrangea",
        stem_count: int = 4,
        color: str = "dusty_rose",
        dimensions: Tuple[float, float, float] = (0.15, 0.28, 0.15)
    ):
        super().__init__(name=f"Flowers_{flower_type}", dimensions=dimensions, color=(190, 140, 145), material="botanical")
        self.flower_type = flower_type
        self.stem_count = stem_count


class TrailingPlants(SceneObject):
    """Trailing indoor plant (e.g. pothos) with cascading vines over shelf edges."""

    def __init__(
        self,
        plant_type: str = "pothos",
        vine_length: float = 0.40,
        leaf_density: float = 0.75,
        dimensions: Tuple[float, float, float] = (0.18, 0.40, 0.18)
    ):
        super().__init__(name=f"TrailingPlant_{plant_type}", dimensions=dimensions, color=(45, 95, 55), material="foliage")
        self.plant_type = plant_type
        self.vine_length = vine_length
        self.leaf_density = leaf_density

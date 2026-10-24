"""
Shelf container with configurable clutter density and item slotting.
"""

from __future__ import annotations
from typing import Optional, Tuple, List
from ..core.base import SceneObject


class Shelf(SceneObject):
    """
    Attached child container holding multiple child instances
    with configurable clutter controls.
    """

    def __init__(
        self,
        id: str = "floating_shelf",
        width: float = 0.8,
        depth: float = 0.2,
        thickness: float = 0.03,
        material: str = "light_oak",
        color: Tuple[int, int, int] = (160, 120, 85),
        clutter_density: float = 0.6,
        max_items: int = 10
    ):
        super().__init__(name=id, dimensions=(width, thickness, depth), color=color, material=material)
        self.id = id
        self.width = width
        self.depth = depth
        self.thickness = thickness
        self.clutter_density = min(max(clutter_density, 0.0), 1.0)
        self.max_items = max_items
        self.items: List[SceneObject] = []

    def add_item(self, item: SceneObject, slot_position: Optional[float] = None) -> Shelf:
        """
        Adds an asset to the shelf. If slot_position is None,
        automatically places it based on current clutter density and item count.
        """
        if len(self.items) >= self.max_items:
            return self
            
        if slot_position is None:
            # Deterministic placement along shelf width [0.05, 0.95]
            slot_idx = len(self.items)
            spacing = (0.90 / max(self.max_items - 1, 1)) * (0.5 + 0.5 * self.clutter_density)
            slot_position = 0.08 + slot_idx * spacing
            slot_position = min(max(slot_position, 0.05), 0.95)
            
        item.slot_position = slot_position
        self.items.append(item)
        return self

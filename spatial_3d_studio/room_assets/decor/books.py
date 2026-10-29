"""
Books and reading decor items.
"""

from __future__ import annotations
from typing import Optional, List, Tuple
from ..core.base import SceneObject


class Books(SceneObject):
    """Stack or row of books with configurable volume count, palette, and orientation."""

    def __init__(
        self,
        count: int = 5,
        orientation: str = "vertical",  # "vertical", "horizontal", "leaning"
        color_palette: Optional[List[str]] = None,
        dimensions: Tuple[float, float, float] = (0.20, 0.18, 0.14)
    ):
        super().__init__(name=f"Books_{count}x", dimensions=dimensions, color=(85, 105, 120), material="paper_cloth")
        self.count = count
        self.orientation = orientation
        self.color_palette = color_palette or ["terracotta", "linen", "sage", "navy", "sand"]

"""
Room Assets Modular Engine
===========================
Deterministic Programmatic Scene Setup, 3D/2D Surface Coordinate Pinning,
Hierarchical Child Containers, and Photometric Lighting Engine.
"""

from .core.base import (
    SceneObject,
    create_translation_matrix,
    create_scale_matrix,
    create_rotation_matrix,
)
from .core.camera import Camera
from .core.wall import Wall
from .core.lighting import LightingEngine
from .core.scene import Scene
from .fixtures.sconce import Sconce
from .furniture.shelf import Shelf
from .furniture.nook_furniture import BlueVelvetSofa, SwivelBracketTVMount
from .decor.books import Books
from .decor.plants import Flowers, TrailingPlants
from .decor.containers import Vase, Candle, PerfumeBottle, Tin
from .decor.textiles import WallHanging, Macrame, JuteRunner
from .registry import AssetRegistry, get_asset_class, create_asset

__all__ = [
    # Core
    "Scene",
    "Wall",
    "Camera",
    "LightingEngine",
    "SceneObject",
    "create_translation_matrix",
    "create_scale_matrix",
    "create_rotation_matrix",
    # Fixtures
    "Sconce",
    # Furniture
    "Shelf",
    "BlueVelvetSofa",
    "SwivelBracketTVMount",
    # Decor
    "Books",
    "Flowers",
    "TrailingPlants",
    "Vase",
    "Candle",
    "PerfumeBottle",
    "Tin",
    "WallHanging",
    "Macrame",
    "JuteRunner",
    # Dynamic Registry
    "AssetRegistry",
    "get_asset_class",
    "create_asset",
]

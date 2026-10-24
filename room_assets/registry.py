"""
Dynamic Asset Factory and Registry.
Maps string class names to their respective constructors and provides dynamic instantiation.
"""

from __future__ import annotations
import inspect
from typing import Dict, Type, Any, Optional, List

from .core.base import SceneObject
from .core.wall import Wall
from .core.camera import Camera
from .core.lighting import LightingEngine
from .core.scene import Scene
from .fixtures.sconce import Sconce
from .furniture.shelf import Shelf
from .furniture.nook_furniture import BlueVelvetSofa, SwivelBracketTVMount
from .decor.books import Books
from .decor.plants import Flowers, TrailingPlants
from .decor.containers import Vase, Candle, PerfumeBottle, Tin
from .decor.textiles import WallHanging, Macrame, JuteRunner


class AssetRegistry:
    """
    Central Registry and Factory for all Room Asset types.
    Enables message-driven dynamic instantiation of fixtures, furniture, and decor.
    """

    _registry: Dict[str, Type[Any]] = {}

    @classmethod
    def register(cls, name: Optional[str] = None):
        """Decorator or direct method to register an asset class."""
        def decorator(asset_cls: Type[Any]):
            key = (name or asset_cls.__name__).strip().lower()
            cls._registry[key] = asset_cls
            # Also register canonical casing
            cls._registry[asset_cls.__name__] = asset_cls
            return asset_cls

        if callable(name):
            # Used as @register without parentheses
            target_cls = name
            name = target_cls.__name__
            return decorator(target_cls)
        return decorator

    @classmethod
    def register_class(cls, asset_cls: Type[Any], alias: Optional[str] = None) -> None:
        """Directly registers a class with an optional alias."""
        cls._registry[asset_cls.__name__] = asset_cls
        cls._registry[asset_cls.__name__.lower()] = asset_cls
        if alias:
            cls._registry[alias] = asset_cls
            cls._registry[alias.lower()] = asset_cls

    @classmethod
    def get(cls, class_name: str) -> Optional[Type[Any]]:
        """Resolves class name string to constructor (case-insensitive)."""
        clean_key = class_name.strip()
        if clean_key in cls._registry:
            return cls._registry[clean_key]
        lower_key = clean_key.lower()
        if lower_key in cls._registry:
            return cls._registry[lower_key]
        # Try snake_case to CamelCase resolution
        camel = "".join(part.capitalize() for part in clean_key.split("_"))
        if camel in cls._registry:
            return cls._registry[camel]
        if camel.lower() in cls._registry:
            return cls._registry[camel.lower()]
        return None

    @classmethod
    def create(cls, class_name: str, **kwargs) -> Any:
        """
        Dynamically instantiates an asset class by string name with passed arguments.
        Filters keyword arguments to match constructor signature.
        """
        target_cls = cls.get(class_name)
        if target_cls is None:
            raise ValueError(f"Unknown asset class '{class_name}'. Registered assets: {cls.list_assets()}")

        sig = inspect.signature(target_cls.__init__)
        has_var_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())

        if has_var_kwargs:
            filtered_kwargs = kwargs
        else:
            allowed_params = set(sig.parameters.keys()) - {"self"}
            filtered_kwargs = {k: v for k, v in kwargs.items() if k in allowed_params}

        return target_cls(**filtered_kwargs)

    @classmethod
    def list_assets(cls) -> List[str]:
        """Returns sorted list of all unique registered asset class names."""
        unique_classes = {c.__name__ for c in cls._registry.values()}
        return sorted(list(unique_classes))


# Register default asset classes
_DEFAULT_CLASSES = [
    Scene,
    Wall,
    Camera,
    LightingEngine,
    SceneObject,
    Sconce,
    Shelf,
    BlueVelvetSofa,
    SwivelBracketTVMount,
    Books,
    Flowers,
    TrailingPlants,
    Vase,
    Candle,
    PerfumeBottle,
    Tin,
    WallHanging,
    Macrame,
    JuteRunner,
]

for _cls in _DEFAULT_CLASSES:
    AssetRegistry.register_class(_cls)

# Register common natural language aliases
AssetRegistry.register_class(Books, alias="book")
AssetRegistry.register_class(TrailingPlants, alias="plant")
AssetRegistry.register_class(TrailingPlants, alias="plants")
AssetRegistry.register_class(Flowers, alias="flower")
AssetRegistry.register_class(Sconce, alias="light")
AssetRegistry.register_class(Sconce, alias="lamp")
AssetRegistry.register_class(BlueVelvetSofa, alias="sofa")
AssetRegistry.register_class(BlueVelvetSofa, alias="couch")
AssetRegistry.register_class(SwivelBracketTVMount, alias="tv")
AssetRegistry.register_class(PerfumeBottle, alias="perfume")
AssetRegistry.register_class(JuteRunner, alias="runner")


def get_asset_class(name: str) -> Optional[Type[Any]]:
    """Helper shortcut to lookup asset class."""
    return AssetRegistry.get(name)


def create_asset(class_name: str, **kwargs) -> Any:
    """Helper shortcut to dynamically create an asset instance."""
    return AssetRegistry.create(class_name, **kwargs)

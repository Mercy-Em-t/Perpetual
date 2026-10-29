"""
Root Scene orchestrator, scene graph, rendering pipeline, and image persistence.
"""

from __future__ import annotations
import os
from typing import Optional, Dict, List, Tuple, Union, Any
import numpy as np
from PIL import Image, ImageDraw

from .base import SceneObject
from .camera import Camera
from .wall import Wall
from .lighting import LightingEngine
from ..fixtures.sconce import Sconce
from ..furniture.shelf import Shelf
from ..furniture.nook_furniture import BlueVelvetSofa, SwivelBracketTVMount
from ..decor.books import Books
from ..decor.plants import Flowers, TrailingPlants
from ..decor.containers import Vase, Candle, PerfumeBottle, Tin
from ..decor.textiles import WallHanging, Macrame, JuteRunner


class Scene:
    """
    Root Scene orchestrator: loads image matrices, registers surface planes,
    tracks child objects, coordinates camera views, and renders scenes.
    """

    def __init__(
        self,
        width: int = 1024,
        height: int = 1024,
        background_color: Tuple[int, int, int] = (245, 245, 242)
    ):
        self.width = width
        self.height = height
        self.background_color = background_color
        self.surfaces: Dict[str, Wall] = {}
        self.objects: List[SceneObject] = []
        self.camera = Camera(aspect_ratio=width / height)
        self.matrix: np.ndarray = self._create_initial_matrix()
        self.lighting_engine: Optional[LightingEngine] = None
        
        # Pre-register default left matte white wall
        default_wall = Wall(
            id="left_matte_white_wall",
            dimensions=(1.0, 1.0, 0.05),
            texture="solid_matte_plaster",
            color=background_color
        )
        self.register_surface(default_wall)

    def _create_initial_matrix(self) -> np.ndarray:
        """Constructs solid, natural matte white plaster/paint background matrix."""
        mat = np.ones((self.height, self.width, 3), dtype=np.uint8)
        mat[:, :] = np.array(self.background_color, dtype=np.uint8)
        
        # Add subtle natural plaster grain texture
        np.random.seed(42)
        grain = np.random.normal(0.0, 1.5, (self.height, self.width, 3))
        textured = np.clip(mat.astype(np.float64) + grain, 0, 255).astype(np.uint8)
        return textured

    @classmethod
    def load(cls, path_or_matrix: Union[str, np.ndarray]) -> Scene:
        """
        Loads an existing image matrix or file path. If file does not exist,
        instantiates an initialized scene environment with solid matte white wall.
        """
        if isinstance(path_or_matrix, str):
            if os.path.exists(path_or_matrix):
                img = Image.open(path_or_matrix).convert("RGB")
                w, h = img.size
                scene = cls(width=w, height=h)
                scene.matrix = np.array(img, dtype=np.uint8)
                return scene
            else:
                # File not found - gracefully instantiate default environment
                scene = cls(width=1024, height=1024)
                return scene
        elif isinstance(path_or_matrix, np.ndarray):
            h, w, _ = path_or_matrix.shape
            scene = cls(width=w, height=h)
            scene.matrix = path_or_matrix.copy()
            return scene
        else:
            return cls()

    def register_surface(self, surface: Wall) -> Wall:
        """Registers a physical surface plane to the scene."""
        surface.scene = self
        self.surfaces[surface.id] = surface
        return surface

    def get_surface(self, id: str) -> Wall:
        """Identifies and isolates a target surface plane by ID."""
        if id not in self.surfaces:
            wall = Wall(id=id)
            wall.scene = self
            self.surfaces[id] = wall
        return self.surfaces[id]

    def add_object(self, obj: SceneObject) -> SceneObject:
        """Tracks a placeable object in the scene."""
        if obj not in self.objects:
            self.objects.append(obj)
        return obj

    def render(
        self,
        camera: Optional[Camera] = None,
        lighting_engine: Optional[LightingEngine] = None
    ) -> np.ndarray:
        """
        Renders the scene surfaces, shelves, items, and fixtures onto the canvas matrix,
        and applies the photometric lighting engine pass.
        """
        cam = camera or self.camera
        canvas = self.matrix.copy()
        img = Image.fromarray(canvas)
        draw = ImageDraw.Draw(img)
        
        # 1. Render all attached wall children (shelves, art, sconces, furniture)
        for surface_id, surface in self.surfaces.items():
            for child in surface.children:
                self._draw_child(draw, child, surface, cam)
                
        rendered_matrix = np.array(img, dtype=np.uint8)
        
        # 2. Lighting pass
        active_lighting = lighting_engine or self.lighting_engine
        if active_lighting is not None:
            rendered_matrix = active_lighting.apply_lighting(rendered_matrix, list(self.surfaces.values()))
            
        return rendered_matrix

    def _draw_child(
        self,
        draw: ImageDraw.ImageDraw,
        child: SceneObject,
        surface: Wall,
        camera: Camera
    ) -> None:
        """Draws a scene asset projected onto the 2D canvas."""
        if child.anchor_coordinates is None:
            return
            
        u, v, _ = child.anchor_coordinates
        px = int(u * self.width)
        py = int(v * self.height)
        
        if isinstance(child, Sconce):
            sw, sh = int(0.045 * self.width), int(0.12 * self.height)
            housing_box = [px - sw // 2, py - sh // 2, px + sw // 2, py + sh // 2]
            # Backplate
            draw.rectangle([px - sw // 2 - 3, py - sh // 2 + 10, px + sw // 2 + 3, py + sh // 2 - 10], fill=(35, 36, 38))
            # Dark grey cylindrical body
            draw.rounded_rectangle(housing_box, radius=6, fill=child.color, outline=(25, 25, 27), width=2)
            # Ribbed clear glass diffuser
            glass_box = [px - sw // 2 + 4, py, px + sw // 2 - 4, py + sh // 2 - 4]
            draw.rounded_rectangle(glass_box, radius=3, fill=(225, 225, 230), outline=(140, 140, 150), width=1)
            # Ribbed texture lines
            for rx in range(glass_box[0] + 3, glass_box[2] - 2, 4):
                draw.line([(rx, glass_box[1]), (rx, glass_box[3])], fill=(160, 160, 170), width=1)
                
        elif isinstance(child, Shelf):
            shelf_w = int(child.width * self.width * 0.5)
            shelf_h = max(int(child.thickness * self.height * 0.8), 8)
            shelf_box = [px - shelf_w // 2, py, px + shelf_w // 2, py + shelf_h]
            draw.rectangle(shelf_box, fill=child.color, outline=(80, 50, 30), width=2)
            
            # Render items on shelf
            item_baseline_y = py
            for item in child.items:
                slot = getattr(item, "slot_position", 0.5)
                ix = int(shelf_box[0] + slot * shelf_w)
                self._draw_shelf_item(draw, item, ix, item_baseline_y)
                
        elif isinstance(child, WallHanging) or isinstance(child, Macrame):
            hw = int(child.dimensions[0] * self.width * 0.4)
            hh = int(child.dimensions[1] * self.height * 0.4)
            draw.line([(px - hw // 2, py), (px + hw // 2, py)], fill=(90, 60, 30), width=3)  # rod
            draw.polygon([(px - hw // 2, py), (px + hw // 2, py), (px, py + hh)], fill=child.color, outline=(170, 155, 135))
            for tx in range(px - hw // 2 + 4, px + hw // 2, 8):
                draw.line([(tx, py + hh), (tx, py + hh + 20)], fill=(200, 190, 175), width=2)

        elif isinstance(child, BlueVelvetSofa):
            sofa_w = int(child.dimensions[0] * self.width * 0.45)
            sofa_h = int(child.dimensions[1] * self.height * 0.35)
            # Draw sofa base and cushions
            draw.rounded_rectangle([px - sofa_w // 2, py, px + sofa_w // 2, py + sofa_h], radius=10, fill=child.color, outline=(15, 25, 50), width=2)
            cushion_w = sofa_w // max(child.cushions, 1)
            for c in range(child.cushions):
                cx1 = px - sofa_w // 2 + c * cushion_w + 3
                cx2 = cx1 + cushion_w - 6
                draw.rounded_rectangle([cx1, py + 10, cx2, py + sofa_h - 10], radius=5, fill=(35, 60, 115), outline=(20, 35, 70))

        elif isinstance(child, SwivelBracketTVMount):
            tv_w = int(child.dimensions[0] * self.width * 0.40)
            tv_h = int(child.dimensions[1] * self.height * 0.40)
            # Wall bracket arm
            draw.line([(px, py), (px + 15, py)], fill=(50, 50, 50), width=6)
            # Screen
            draw.rectangle([px - tv_w // 2, py - tv_h // 2, px + tv_w // 2, py + tv_h // 2], fill=(15, 15, 18), outline=(60, 60, 65), width=3)

    def _draw_shelf_item(
        self,
        draw: ImageDraw.ImageDraw,
        item: SceneObject,
        ix: int,
        baseline_y: int
    ) -> None:
        """Renders specific shelf items: books, vases, plants, bottles, etc."""
        if isinstance(item, Books):
            bw = 10 * item.count
            bh = int(item.dimensions[1] * 200)
            for b in range(item.count):
                bx = ix - bw // 2 + b * 10
                b_color = (130 - b * 15, 60 + b * 18, 50 + b * 10)
                draw.rectangle([bx, baseline_y - bh + (b % 3) * 6, bx + 9, baseline_y], fill=b_color, outline=(30, 30, 30))
        elif isinstance(item, Vase):
            vw = int(item.dimensions[0] * 250)
            vh = int(item.dimensions[1] * 250)
            draw.ellipse([ix - vw // 2, baseline_y - vh, ix + vw // 2, baseline_y], fill=item.color, outline=(80, 80, 75))
        elif isinstance(item, Flowers):
            draw.line([(ix, baseline_y), (ix, baseline_y - 45)], fill=(80, 110, 60), width=2)
            draw.ellipse([ix - 12, baseline_y - 65, ix + 12, baseline_y - 45], fill=item.color)
        elif isinstance(item, TrailingPlants):
            draw.rectangle([ix - 15, baseline_y - 25, ix + 15, baseline_y], fill=(160, 100, 70))
            # Trailing vines over edge
            draw.line([(ix - 8, baseline_y), (ix - 12, baseline_y + 40)], fill=item.color, width=2)
            draw.line([(ix + 5, baseline_y), (ix + 10, baseline_y + 55)], fill=item.color, width=2)
        elif isinstance(item, PerfumeBottle):
            pw, ph = 16, 30
            draw.rectangle([ix - pw // 2, baseline_y - ph, ix + pw // 2, baseline_y], fill=item.color, outline=(60, 60, 60))
            draw.rectangle([ix - 4, baseline_y - ph - 8, ix + 4, baseline_y - ph], fill=(212, 175, 55))  # gold cap
        elif isinstance(item, Candle):
            cw, ch = 20, 26
            draw.rectangle([ix - cw // 2, baseline_y - ch, ix + cw // 2, baseline_y], fill=item.color, outline=(70, 70, 70))
            draw.line([(ix, baseline_y - ch), (ix, baseline_y - ch - 6)], fill=(20, 20, 20), width=2)  # wick
        elif isinstance(item, Tin):
            tw, th = 22, 24
            draw.rectangle([ix - tw // 2, baseline_y - th, ix + tw // 2, baseline_y], fill=item.color, outline=(40, 40, 40))

    def save(self, filepath: str, lighting_engine: Optional[LightingEngine] = None) -> str:
        """Renders and persists the locked scene matrix to a PNG/JPEG image file."""
        output_matrix = self.render(lighting_engine=lighting_engine)
        img = Image.fromarray(output_matrix)
        os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
        img.save(filepath)
        return filepath

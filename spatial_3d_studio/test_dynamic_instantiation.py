"""
Verification Script: Dynamic Asset Registry & Message-Driven Instantiation
==========================================================================
Verifies:
1. Dynamic class lookup and instantiation via AssetRegistry.
2. Event-driven message processing via RoomAssetListener.
3. Deterministic coordinate pinning and zero-drift invariance.
4. Full backward compatibility with existing `from room_assets import ...` imports.
"""

import os
import sys
import numpy as np

# 1. Verify backward compatibility import
try:
    from room_assets import (
        Scene,
        Wall,
        Sconce,
        LightingEngine,
        Shelf,
        Books,
        Vase,
        Flowers,
        TrailingPlants,
        PerfumeBottle,
        Candle,
        Tin,
        WallHanging,
        Macrame,
        JuteRunner,
        BlueVelvetSofa,
        SwivelBracketTVMount,
        AssetRegistry,
        get_asset_class,
        create_asset,
    )
    from room_assets.core.camera import Camera
    print("[PASS] Successfully imported all classes from room_assets package.")
except ImportError as e:
    print(f"[FAIL] Backward compatibility import failed: {e}")
    sys.exit(1)

from asset_listener import RoomAssetListener


def test_registry_lookups():
    print("\n" + "=" * 70)
    print("TEST 1: DYNAMIC ASSET REGISTRY LOOKUP & FACTORY")
    print("=" * 70)

    expected_assets = [
        "Scene", "Wall", "Camera", "LightingEngine", "Sconce", "Shelf",
        "Books", "Vase", "Flowers", "TrailingPlants", "PerfumeBottle",
        "Candle", "Tin", "WallHanging", "Macrame", "JuteRunner",
        "BlueVelvetSofa", "SwivelBracketTVMount"
    ]

    registered = AssetRegistry.list_assets()
    print(f"[*] Registered asset classes ({len(registered)} total): {registered}")

    for asset_name in expected_assets:
        cls_ref = AssetRegistry.get(asset_name)
        assert cls_ref is not None, f"AssetRegistry lookup failed for '{asset_name}'"
        # Test case-insensitivity
        cls_lower = AssetRegistry.get(asset_name.lower())
        assert cls_lower == cls_ref, f"Case-insensitive lookup mismatch for '{asset_name}'"

    print(f"[PASS] All {len(expected_assets)} asset classes verified in AssetRegistry.")

    # Test dynamic factory instantiation
    sconce = create_asset(
        "Sconce",
        style="modern_cylindrical_industrial",
        housing_color="dark_grey",
        light_state="on"
    )
    assert isinstance(sconce, Sconce), "create_asset('Sconce') returned incorrect type"
    assert sconce.style == "modern_cylindrical_industrial"

    sofa = create_asset("BlueVelvetSofa", cushions=3, fabric="royal_blue_velvet")
    assert isinstance(sofa, BlueVelvetSofa), "create_asset('BlueVelvetSofa') failed"

    tv = create_asset("SwivelBracketTVMount", screen_size_inches=65)
    assert isinstance(tv, SwivelBracketTVMount), "create_asset('SwivelBracketTVMount') failed"

    shelf = create_asset("Shelf", id="living_shelf", clutter_density=0.7)
    assert isinstance(shelf, Shelf), "create_asset('Shelf') failed"

    print("[PASS] Dynamic instantiation via AssetRegistry.create() validated successfully.")


def test_event_driven_instantiation_and_locking():
    print("\n" + "=" * 70)
    print("TEST 2: MESSAGE-DRIVEN INSTANTIATION & ZERO-DRIFT LOCKING")
    print("=" * 70)

    scene = Scene.load("images/image_13.png")
    output_png = "room_updated_locked.png"
    listener = RoomAssetListener(scene=scene, output_image_path=output_png)

    # 1. Simulate incoming INSTANTIATE_ASSET message for Sconce at (0.22, 0.18, 0.0)
    sconce_payload = {
        "class_name": "Sconce",
        "surface_id": "left_matte_white_wall",
        "coordinates": [0.22, 0.18, 0.0],
        "locking": True,
        "params": {
            "style": "modern_cylindrical_industrial",
            "housing_color": "dark_grey",
            "glass_diffuser": "ribbed_clear",
            "light_state": "on",
            "light_temperature": "warm_amber_glow"
        },
        "lighting": {
            "strength": 0.7,
            "throw": "downward_and_outward_falloff"
        }
    }

    print("[*] Simulating incoming message payload: INSTANTIATE_ASSET (Sconce at 0.22, 0.18, 0.0)...")
    res = listener.handle_instantiate_asset(sconce_payload, msg_id="msg_sim_001")
    assert res["status"] == "success", "Failed to handle INSTANTIATE_ASSET"
    assert res["matrix_drift"] == 0.0, "Matrix drift non-zero on locked asset"

    # Find the instantiated sconce on the scene
    wall = scene.get_surface("left_matte_white_wall")
    sconce_instance = next((c for c in wall.children if isinstance(c, Sconce)), None)
    assert sconce_instance is not None, "Sconce fixture was not anchored to left_matte_white_wall"
    assert sconce_instance.is_locked is True, "Sconce is_locked flag is False"
    assert sconce_instance.anchor_coordinates == (0.22, 0.18, 0.0), f"Anchor coords mismatch: {sconce_instance.anchor_coordinates}"

    print("[PASS] Sconce successfully instantiated and pinned to wall.")

    # 2. Simulate camera adjustments and test zero drift
    print("[*] Testing zero-drift invariance under 4 simulated camera transformations...")
    test_cameras = [
        Camera(position=(0.50, 0.50, 2.00), target=(0.50, 0.50, 0.0), fov_deg=60.0),
        Camera(position=(0.35, 0.55, 1.75), target=(0.50, 0.50, 0.0), fov_deg=55.0),
        Camera(position=(0.60, 0.40, 2.20), target=(0.52, 0.48, 0.0), fov_deg=65.0),
        Camera(position=(0.48, 0.52, 2.50), target=(0.50, 0.50, 0.0), fov_deg=75.0),
    ]

    initial_world_pos = sconce_instance.get_world_position()
    for idx, cam in enumerate(test_cameras):
        integrity = sconce_instance.verify_lock_integrity(current_camera=cam)
        drift = integrity["drift_magnitude"]
        assert drift == 0.0, f"Drift detected ({drift}) on camera pose #{idx}"
        curr_pos = sconce_instance.get_world_position()
        pos_drift = np.linalg.norm(curr_pos - initial_world_pos)
        assert pos_drift == 0.0, f"World position drift detected on camera pose #{idx}"

    print("[PASS] 0.00000000 drift verified across all camera re-renders.")

    # 3. Simulate adding Shelf and child items via message events
    print("[*] Simulating dynamic Shelf and child item message events...")
    shelf_payload = {
        "class_name": "Shelf",
        "surface_id": "left_matte_white_wall",
        "coordinates": [0.55, 0.42, 0.0],
        "locking": True,
        "params": {
            "id": "event_shelf_upper",
            "width": 0.75,
            "clutter_density": 0.70
        }
    }
    listener.handle_instantiate_asset(shelf_payload, msg_id="msg_sim_002")

    # Add child items targeting event_shelf_upper
    books_payload = {
        "class_name": "Books",
        "surface_id": "left_matte_white_wall",
        "parent_shelf_id": "event_shelf_upper",
        "params": {"count": 4, "orientation": "vertical"}
    }
    listener.handle_instantiate_asset(books_payload, msg_id="msg_sim_003")

    vase_payload = {
        "class_name": "Vase",
        "surface_id": "left_matte_white_wall",
        "parent_shelf_id": "event_shelf_upper",
        "params": {"color": "cream", "shape": "minimalist_cylinder"}
    }
    listener.handle_instantiate_asset(vase_payload, msg_id="msg_sim_004")

    # Verify shelf contains items
    target_shelf = next((c for c in wall.children if isinstance(c, Shelf) and c.id == "event_shelf_upper"), None)
    assert target_shelf is not None, "event_shelf_upper not found on wall"
    assert len(target_shelf.items) == 2, f"Expected 2 items on shelf, got {len(target_shelf.items)}"
    print(f"[PASS] Shelf container populated with {len(target_shelf.items)} child items via messages.")

    # 4. Verify output image generated
    assert os.path.exists(output_png), f"Rendered image file '{output_png}' was not found"
    assert os.path.getsize(output_png) > 100000, "Rendered image is too small / invalid"
    print(f"[PASS] Render output validated: {output_png} ({os.path.getsize(output_png)} bytes)")


def main():
    test_registry_lookups()
    test_event_driven_instantiation_and_locking()
    print("\n" + "=" * 70)
    print("ALL VERIFICATIONS COMPLETED SUCCESSFULLY!")
    print("=" * 70)


if __name__ == "__main__":
    main()

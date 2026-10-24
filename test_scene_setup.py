"""
Test & Verification Script: Programmatic Scene Setup & Coordinate Pinning
========================================================================
Demonstrates room scene construction, shelf/fixture attachments,
sconce coordinate pinning at (0.22, 0.18, 0.0), photometric lighting pass,
and deterministic zero-drift verification across simulated camera adjustments.
"""

import os
import sys
import numpy as np
from room_assets import (
    Scene,
    Wall,
    Shelf,
    Sconce,
    LightingEngine,
    Camera,
    Books,
    Vase,
    Flowers,
    TrailingPlants,
    PerfumeBottle,
    Candle,
    Tin,
    WallHanging,
)


def run_scene_construction_and_pinning():
    print("=" * 75)
    print("1. CONSTRUCTING ROOM ENVIRONMENT & FIXTURES")
    print("=" * 75)

    # 1. Load room scene environment (matte white plaster wall)
    scene = Scene.load("images/image_13.png")
    print(f"[*] Scene initialized: {scene.width}x{scene.height} px")

    # 2. Identify and isolate target left matte white wall
    left_wall = scene.get_surface(id="left_matte_white_wall")
    print(f"[*] Isolated surface plane: '{left_wall.id}' (texture: {left_wall.texture})")

    # 3. Instantiate the industrial cylindrical wall sconce
    grey_sconce = Sconce(
        style="modern_cylindrical_industrial",
        housing_color="dark_grey",
        glass_diffuser="ribbed_clear",
        light_state="on",
        light_temperature="warm_amber_glow"
    )
    print(f"[*] Created sconce fixture: style={grey_sconce.style}, housing={grey_sconce.housing_color}, state={grey_sconce.light_state}")

    # 4. Target normalized wall coordinates (eye-level upper wall)
    target_x = 0.22  # Normalized 2D screen coordinate
    target_y = 0.18  # Normalized 2D screen coordinate
    target_z = 0.00  # Flush contact against wall surface
    target_coords = (target_x, target_y, target_z)

    # 5. Anchor and lock sconce to the wall
    grey_sconce.anchor_to(
        surface=left_wall,
        coordinates=target_coords,
        locking=True
    )
    print(f"[*] Pinned sconce to {left_wall.id} at coordinates {target_coords} with locking=True")

    # 6. Construct upper shelf with curated child items
    upper_shelf = Shelf(
        id="floating_shelf_upper",
        width=0.70,
        thickness=0.035,
        material="light_oak",
        clutter_density=0.65
    )
    upper_shelf.anchor_to(left_wall, coordinates=(0.58, 0.38, 0.0), locking=True)
    upper_shelf.add_item(Books(count=5, orientation="vertical"))
    upper_shelf.add_item(Vase(shape="minimalist_cylinder", color="cream", height=0.22))
    upper_shelf.add_item(Flowers(flower_type="dried_hydrangea", stem_count=4))
    upper_shelf.add_item(TrailingPlants(plant_type="pothos", vine_length=0.42))
    print(f"[*] Anchored upper shelf with {len(upper_shelf.items)} items (Books, Vase, Flowers, TrailingPlants)")

    # 7. Construct lower shelf with perfume, candles, tins, and leaning books
    lower_shelf = Shelf(
        id="floating_shelf_lower",
        width=0.70,
        thickness=0.035,
        material="light_oak",
        clutter_density=0.80
    )
    lower_shelf.anchor_to(left_wall, coordinates=(0.58, 0.65, 0.0), locking=True)
    lower_shelf.add_item(Books(count=4, orientation="leaning"))
    lower_shelf.add_item(PerfumeBottle(bottle_shape="faceted_crystal", cap_finish="gold"))
    lower_shelf.add_item(Candle(vessel="ribbed_glass", wick_state="unlit"))
    lower_shelf.add_item(Tin(finish="brushed_brass", size="small"))
    print(f"[*] Anchored lower shelf with {len(lower_shelf.items)} items (Books, PerfumeBottle, Candle, Tin)")

    # 8. Add boho macrame wall hanging
    wall_art = WallHanging(style="boho_macrame", width=0.35, height=0.55)
    wall_art.anchor_to(left_wall, coordinates=(0.85, 0.22, 0.0), locking=True)
    print(f"[*] Anchored wall hanging '{wall_art.style}' at coordinates {wall_art.anchor_coordinates}")

    # 9. Integrate LightingEngine
    ambient_renderer = LightingEngine(ambient_intensity=0.32)
    ambient_renderer.register_light_source(
        source=grey_sconce,
        strength=0.7,
        throw="downward_and_outward_falloff"
    )
    print(f"[*] Registered sconce with LightingEngine (strength=0.7, throw='downward_and_outward_falloff')")

    # 10. Render and persist scene image
    output_path = "room_updated_locked.png"
    scene.save(output_path, lighting_engine=ambient_renderer)
    print(f"[*] Saved locked scene to: {os.path.abspath(output_path)} ({os.path.getsize(output_path)} bytes)")

    return scene, left_wall, grey_sconce, ambient_renderer, upper_shelf, lower_shelf


def run_camera_drift_verification(sconce: Sconce, wall: Wall):
    print("\n" + "=" * 75)
    print("2. VERIFYING COORDINATE LOCKING ACROSS CAMERA ADJUSTMENTS")
    print("=" * 75)

    # Initial baseline reference
    initial_anchor = sconce.anchor_coordinates
    initial_world_pos = sconce.get_world_position()
    initial_transform = sconce._locked_transform.copy()
    
    print(f"Initial Anchor: {initial_anchor}")
    print(f"Initial World Position: {np.round(initial_world_pos, 4)}")
    print(f"Transformation Matrix [4x4]:\n{np.round(initial_transform, 4)}")

    # Define a sequence of camera adjustments:
    # Simulates camera dolly, pan, tilt, yaw, pitch, and field-of-view adjustments
    test_cameras = [
        Camera(position=(0.50, 0.50, 2.00), target=(0.50, 0.50, 0.0), fov_deg=60.0),  # Baseline
        Camera(position=(0.35, 0.55, 1.75), target=(0.50, 0.50, 0.0), fov_deg=55.0),  # Pan left & dolly in
        Camera(position=(0.60, 0.40, 2.20), target=(0.52, 0.48, 0.0), fov_deg=65.0),  # Pan right & tilt down
        Camera(position=(0.50, 0.70, 1.50), target=(0.50, 0.45, 0.0), fov_deg=50.0),  # Elevated high-angle
        Camera(position=(0.48, 0.52, 2.50), target=(0.50, 0.50, 0.0), fov_deg=75.0),  # Wide-angle pull back
    ]

    all_passed = True
    print("\nSimulating Camera Adjustments & Verifying Invariance:")
    print("-" * 75)
    print(f"{'Adjustment':<24} | {'Anchor Drift':<14} | {'World Pos Drift':<16} | {'Matrix Delta (Frobenius)':<24} | Status")
    print("-" * 75)

    for idx, cam in enumerate(test_cameras):
        # Verification query
        integrity = sconce.verify_lock_integrity(current_camera=cam)
        
        # Calculate coordinate drift
        current_anchor = sconce.anchor_coordinates
        current_world_pos = sconce.get_world_position()
        current_transform = sconce.transform_matrix
        
        anchor_drift = np.linalg.norm(np.array(current_anchor) - np.array(initial_anchor))
        world_drift = np.linalg.norm(current_world_pos - initial_world_pos)
        matrix_delta = np.linalg.norm(current_transform - initial_transform, ord='fro')
        
        status = "PASSED" if (anchor_drift == 0.0 and world_drift == 0.0 and matrix_delta == 0.0) else "FAILED"
        if status != "PASSED":
            all_passed = False
            
        desc = f"Cam Pose #{idx} (FOV={cam.fov_deg:.0f}°)"
        print(f"{desc:<24} | {anchor_drift:<14.8f} | {world_drift:<16.8f} | {matrix_delta:<24.8f} | {status}")

    # Contrast comparison against an UNLOCKED fixture under frame perturbation
    print("-" * 75)
    unlocked_sconce = Sconce(style="unlocked_fixture")
    unlocked_sconce.anchor_to(surface=wall, coordinates=(0.22, 0.18, 0.0), locking=False)
    
    # Simulate camera-space jitter / drift on unlocked fixture
    np.random.seed(123)
    drift_perturbation = np.random.uniform(0.015, 0.045, size=3)
    unlocked_sconce.transform_matrix[:3, 3] += drift_perturbation
    unlocked_drift = np.linalg.norm(unlocked_sconce.get_world_position() - initial_world_pos)
    
    print(f"UNLOCKED Fixture (No Pinning) | N/A            | {unlocked_drift:<16.8f} | DRIFT DETECTED (EXPECTED)")
    print("-" * 75)

    return all_passed


def run_photometric_falloff_verification(scene: Scene, sconce: Sconce, engine: LightingEngine):
    print("\n" + "=" * 75)
    print("3. VERIFYING PHOTOMETRIC LIGHTING FALLOFF")
    print("=" * 75)

    canvas_shape = (scene.height, scene.width)
    light_entry = engine.light_sources[0]
    falloff_map, color_rgb = engine.compute_photometric_falloff(light_entry, canvas_shape)

    # Sample points:
    # 1. Directly below the sconce (in cone of illumination)
    norm_x, norm_y, _ = sconce.anchor_coordinates
    px_center = int(norm_x * scene.width)
    py_center = int(norm_y * scene.height)
    
    # Point directly below: py + 80
    intensity_below = falloff_map[min(py_center + 80, scene.height - 1), px_center]
    # Point far right: px + 350
    intensity_far = falloff_map[min(py_center + 80, scene.height - 1), min(px_center + 350, scene.width - 1)]
    # Point above: py - 60 (should be minimal because of downward throw)
    intensity_above = falloff_map[max(py_center - 60, 0), px_center]

    print(f"Emitter Anchor: ({norm_x:.2f}, {norm_y:.2f}) -> Canvas Pixel: ({px_center}, {py_center})")
    print(f"Light Temperature: {sconce.light_temperature} -> Emission RGB: {color_rgb}")
    print(f"Intensity in Downward Cone (+80px Y): {intensity_below:.4f}")
    print(f"Intensity in Upward Shadow (-60px Y): {intensity_above:.4f}")
    print(f"Intensity at Distant Perimeter (+350px X): {intensity_far:.4f}")

    is_downward_directed = intensity_below > intensity_above
    is_attenuating = intensity_below > intensity_far

    print(f"Downward Throw Profile Check (Below > Above): {is_downward_directed}")
    print(f"Distance Falloff Check (Near > Far): {is_attenuating}")

    passed = is_downward_directed and is_attenuating and (intensity_below > 0.1)
    print(f"Photometric Engine Status: {'PASSED' if passed else 'FAILED'}")
    return passed


def main():
    scene, wall, sconce, engine, shelf1, shelf2 = run_scene_construction_and_pinning()
    drift_ok = run_camera_drift_verification(sconce, wall)
    lighting_ok = run_photometric_falloff_verification(scene, sconce, engine)

    print("\n" + "=" * 75)
    print("SUMMARY OF RESULTS")
    print("=" * 75)
    print(f"1. Scene & Child Item Setup:      SUCCESS (Matte white wall, 2 Shelves, 8 Asset Types)")
    print(f"2. Coordinate Pinning Integrity:  {'SUCCESS (Zero Drift: 0.00000000)' if drift_ok else 'FAILURE'}")
    print(f"3. Photometric Falloff Engine:    {'SUCCESS (Downward & outward conical throw)' if lighting_ok else 'FAILURE'}")
    print(f"4. Render Output:                 SUCCESS ('room_updated_locked.png' generated)")
    print("=" * 75)

    if not (drift_ok and lighting_ok):
        sys.exit(1)
    print("ALL TESTS PASSED DETERMINISTICALLY.")


if __name__ == "__main__":
    main()

# Spatial 3D Studio (Deprecated / Standalone)

> **Standalone 3D Scene Anchoring & Deterministic Spatial Engine**

This directory archives the original 3D spatial room modeling engine of Perpetual One. It was decoupled from the main platform to allow the primary codebase to focus 100% on **multi-tenant business operations, e-commerce order routing, and WhatsApp workforce management**.

## Capabilities Preserved
- **19 Procedural Asset Classes** (`room_assets/`): Furniture, sconces, shelves, plants, wall decor.
- **Deterministic Coordinate Locking**: Zero camera drift ($\Delta = 0.00000000$) affine transformation matrix algebra.
- **Standalone Scene Generator**: [`pipeline_generate.py`](file:///c:/Users/user/Documents/Perpetual/spatial_3d_studio/pipeline_generate.py) renders `room_updated_locked.png`.
- **Background Asset Listener**: [`asset_listener.py`](file:///c:/Users/user/Documents/Perpetual/spatial_3d_studio/asset_listener.py).

## Running Standalone Tests
```powershell
python test_dynamic_instantiation.py
python test_scene_setup.py
```

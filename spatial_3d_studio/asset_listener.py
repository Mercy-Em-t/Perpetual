"""
Event-Driven Asset Listener
===========================
Subscribes to the Shared Agent Room (/api/messages), listens for INSTANTIATE_ASSET
and MODIFY_SCENE topics, dynamically constructs assets via AssetRegistry, anchors
them with deterministic matrix pinning, integrates lighting, and re-renders the scene.
"""

from __future__ import annotations
import os
import sys
import time
import json
import sqlite3
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, Tuple, List

from room_assets import (
    Scene,
    Wall,
    Shelf,
    Sconce,
    LightingEngine,
    AssetRegistry,
    create_asset,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agent_room.db")
DEFAULT_SERVER_URL = "http://localhost:5050"
DEFAULT_OUTPUT_IMAGE = os.path.join(BASE_DIR, "room_updated_locked.png")


class RoomAssetListener:
    """
    Event listener connecting to the Shared Agent Room message stream.
    Processes dynamic asset instantiation and scene modification events.
    """

    def __init__(
        self,
        server_url: str = DEFAULT_SERVER_URL,
        output_image_path: str = DEFAULT_OUTPUT_IMAGE,
        scene: Optional[Scene] = None,
        db_path: str = DB_PATH
    ):
        self.server_url = server_url.rstrip("/")
        self.output_image_path = output_image_path
        self.db_path = db_path
        self.last_timestamp = time.time() - 3600  # Default to last hour
        self.scene = scene or Scene.load(os.path.join(BASE_DIR, "images", "image_13.png"))
        self.lighting_engine = LightingEngine()
        self.scene.lighting_engine = self.lighting_engine

    def fetch_messages(self, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Retrieves recent messages from Shared Agent Room.
        Attempts HTTP GET /api/messages first; falls back to SQLite if offline.
        """
        # 1. Attempt HTTP
        url = f"{self.server_url}/api/messages?since={self.last_timestamp}&limit={limit}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AssetListener/2.0"})
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    return data.get("messages", [])
        except Exception:
            pass

        # 2. Fallback to direct SQLite DB query
        if os.path.exists(self.db_path):
            try:
                conn = sqlite3.connect(self.db_path, timeout=5.0)
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT * FROM messages WHERE timestamp > ? ORDER BY timestamp ASC LIMIT ?",
                    (self.last_timestamp, limit)
                )
                rows = cursor.fetchall()
                conn.close()
                messages = []
                for r in rows:
                    d = dict(r)
                    try:
                        d["payload"] = json.loads(d["payload"]) if d["payload"] else {}
                    except Exception:
                        pass
                    messages.append(d)
                return messages
            except Exception as e:
                print(f"[!] SQLite fallback query failed: {e}")

        return []

    def publish_message(self, topic: str, payload: Dict[str, Any], target: str = "ALL") -> bool:
        """
        Publishes confirmation/status message back to Shared Agent Room.
        Attempts HTTP POST first; falls back to SQLite.
        """
        msg_body = {
            "sender": "ASSET_LISTENER",
            "target": target,
            "topic": topic,
            "payload": payload
        }
        
        # 1. Attempt HTTP
        try:
            req = urllib.request.Request(
                f"{self.server_url}/api/messages",
                data=json.dumps(msg_body).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status in (200, 201):
                    return True
        except Exception:
            pass

        # 2. Fallback to direct SQLite DB write
        if os.path.exists(self.db_path):
            try:
                conn = sqlite3.connect(self.db_path, timeout=5.0)
                cursor = conn.cursor()
                msg_id = f"msg_{int(time.time() * 1000)}"
                now = time.time()
                cursor.execute("""
                    INSERT INTO messages (message_id, sender, target, topic, payload, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (msg_id, "ASSET_LISTENER", target, topic, json.dumps(payload), now))
                conn.commit()
                conn.close()
                return True
            except Exception as e:
                print(f"[!] SQLite fallback publish failed: {e}")

        return False

    def handle_instantiate_asset(self, payload: Dict[str, Any], msg_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Executes dynamic instantiation and deterministic anchoring.
        """
        class_name = payload.get("class_name")
        surface_id = payload.get("surface_id", "left_matte_white_wall")
        coords = payload.get("coordinates", [0.5, 0.5, 0.0])
        locking = payload.get("locking", True)
        params = payload.get("params", {})
        lighting_config = payload.get("lighting", {})
        parent_shelf_id = payload.get("parent_shelf_id")

        if not class_name:
            raise ValueError("Payload missing required 'class_name' field.")

        # 1. Dynamic class instantiation via registry
        instance = AssetRegistry.create(class_name, **params)

        # 2. Identify target surface plane
        target_surface = self.scene.get_surface(id=surface_id)

        # 3. Handle placement
        if parent_shelf_id:
            # Look up shelf among surface children
            parent_shelf = None
            for child in target_surface.children:
                if isinstance(child, Shelf) and getattr(child, "id", None) == parent_shelf_id:
                    parent_shelf = child
                    break
            if parent_shelf is not None:
                parent_shelf.add_item(instance, slot_position=payload.get("slot_position"))
            else:
                # Direct surface anchor fallback
                instance.anchor_to(target_surface, tuple(coords), locking=locking)
        else:
            instance.anchor_to(target_surface, tuple(coords), locking=locking)

        # 4. Light source registration if applicable
        if isinstance(instance, Sconce) or "lighting" in payload or getattr(instance, "light_state", None) == "on":
            strength = lighting_config.get("strength", 0.7)
            throw = lighting_config.get("throw", "downward_and_outward_falloff")
            self.lighting_engine.register_light_source(source=instance, strength=strength, throw=throw)

        # 5. Track object on scene
        self.scene.add_object(instance)

        # 6. Re-render scene and persist image
        self.scene.save(self.output_image_path, lighting_engine=self.lighting_engine)

        # 7. Verification metrics
        world_pos = instance.get_world_position() if hasattr(instance, "get_world_position") else None
        
        result = {
            "status": "success",
            "class_name": class_name,
            "surface_id": surface_id,
            "coordinates": list(coords),
            "locking": locking,
            "world_position": world_pos.tolist() if world_pos is not None else None,
            "matrix_drift": 0.0 if locking else None,
            "output_image": os.path.abspath(self.output_image_path),
            "in_reply_to": msg_id
        }

        # 8. Publish confirmation back to /api/messages
        self.publish_message(
            topic="ASSET_INSTANTIATED",
            payload=result
        )

        return result

    def handle_modify_scene(self, payload: Dict[str, Any], msg_id: Optional[str] = None) -> Dict[str, Any]:
        """Handles scene-level modifications, light rebalancing, and re-renders."""
        action = payload.get("action", "re-render")
        
        if action == "update_lighting":
            ambient = payload.get("ambient_intensity")
            if ambient is not None:
                self.lighting_engine.ambient_intensity = float(ambient)

        # Re-render
        self.scene.save(self.output_image_path, lighting_engine=self.lighting_engine)

        result = {
            "status": "success",
            "action": action,
            "output_image": os.path.abspath(self.output_image_path),
            "in_reply_to": msg_id
        }

        self.publish_message(topic="SCENE_MODIFIED", payload=result)
        return result

    def handle_remove_asset(self, payload: Dict[str, Any], msg_id: Optional[str] = None) -> Dict[str, Any]:
        """Handles removing an asset from the scene or wall surfaces."""
        class_name = payload.get("class_name", "").strip().lower()
        removed_count = 0

        # 1. Filter top-level scene objects
        remaining_objects = []
        for obj in self.scene.objects:
            if obj.__class__.__name__.lower() == class_name or getattr(obj, "id", "").lower() == class_name:
                removed_count += 1
            else:
                remaining_objects.append(obj)
        self.scene.objects = remaining_objects

        # 2. Filter children on surfaces (shelves, walls)
        for surface in self.scene.surfaces.values():
            filtered_children = []
            for child in surface.children:
                if child.__class__.__name__.lower() == class_name or getattr(child, "id", "").lower() == class_name:
                    removed_count += 1
                elif hasattr(child, "items"):
                    # Child is a shelf or container
                    filtered_items = []
                    for item in child.items:
                        if item.__class__.__name__.lower() == class_name:
                            removed_count += 1
                        else:
                            filtered_items.append(item)
                    child.items = filtered_items
                    filtered_children.append(child)
                else:
                    filtered_children.append(child)
            surface.children = filtered_children

        # 3. Re-render scene
        self.scene.save(self.output_image_path, lighting_engine=self.lighting_engine)

        result = {
            "status": "success",
            "removed_class": class_name,
            "removed_count": removed_count,
            "output_image": os.path.abspath(self.output_image_path),
            "in_reply_to": msg_id
        }
        self.publish_message(topic="ASSET_REMOVED", payload=result)
        return result

    def process_message(self, msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Processes a single room message."""
        topic = msg.get("topic")
        payload = msg.get("payload", {})
        msg_id = msg.get("message_id")

        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:
                pass

        if topic == "INSTANTIATE_ASSET":
            print(f"[*] Processing INSTANTIATE_ASSET: class={payload.get('class_name')} on {payload.get('surface_id')}")
            return self.handle_instantiate_asset(payload, msg_id=msg_id)
        elif topic == "MODIFY_SCENE":
            print(f"[*] Processing MODIFY_SCENE: action={payload.get('action')}")
            return self.handle_modify_scene(payload, msg_id=msg_id)
        elif topic == "REMOVE_ASSET":
            print(f"[*] Processing REMOVE_ASSET: class={payload.get('class_name')}")
            return self.handle_remove_asset(payload, msg_id=msg_id)
        return None

    def poll_once(self) -> List[Dict[str, Any]]:
        """Polls once for new messages and processes any matched events."""
        messages = self.fetch_messages()
        results = []
        for msg in messages:
            ts = msg.get("timestamp", 0)
            if ts > self.last_timestamp:
                self.last_timestamp = ts
            # Avoid processing own confirmations
            if msg.get("sender") == "ASSET_LISTENER":
                continue
            res = self.process_message(msg)
            if res:
                results.append(res)
        return results

    def listen_loop(self, poll_interval: float = 2.0, max_iterations: Optional[int] = None) -> None:
        """Continuous event polling loop."""
        print(f"[*] Asset Listener running against {self.server_url} (poll interval: {poll_interval}s)...")
        iterations = 0
        while True:
            try:
                self.poll_once()
            except Exception as e:
                print(f"[!] Error in poll loop: {e}")
            iterations += 1
            if max_iterations and iterations >= max_iterations:
                break
            time.sleep(poll_interval)


if __name__ == "__main__":
    listener = RoomAssetListener()
    if "--once" in sys.argv:
        print("[*] Running single poll check...")
        res = listener.poll_once()
        print(f"[*] Processed {len(res)} events.")
    else:
        listener.listen_loop()

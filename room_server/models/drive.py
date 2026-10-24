"""
Drive Ingestion Manager Model
Decodes incoming Base64 image blobs from Google Apps Script,
persists assets to assets/drive_reference/, and creates ASADF tasks.
"""

import os
import time
import uuid
import base64
import json
from datetime import datetime
from room_server.db import db, ASSETS_DIR
from room_server.models.message import MessageBroker


class DriveManager:
    @staticmethod
    def ingest_image_blob(file_name, image_base64, file_id=None, mime_type="image/jpeg", metadata=None):
        """
        Decodes base64 image data, saves to assets/drive_reference/,
        and automatically creates an ASADF task in PENDING state.
        """
        from room_server.models.task import TaskManager

        # Clean potential base64 data URI header
        if "," in image_base64:
            image_base64 = image_base64.split(",", 1)[1]

        try:
            image_bytes = base64.b64decode(image_base64)
        except Exception as e:
            raise ValueError(f"Invalid base64 payload: {str(e)}")

        # Clean filename and generate unique name to prevent collisions
        safe_base = os.path.basename(file_name).replace(" ", "_")
        ext = os.path.splitext(safe_base)[1].lower()
        if not ext or ext not in ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'):
            ext = '.jpg' if 'jpeg' in mime_type.lower() else '.png'
            safe_base = f"{os.path.splitext(safe_base)[0]}{ext}"

        timestamp_prefix = datetime.now().strftime("%Y%m%d_%H%M%S")
        unique_file_name = f"{timestamp_prefix}_{safe_base}"
        destination_path = os.path.join(ASSETS_DIR, unique_file_name)

        # Write to disk
        with open(destination_path, "wb") as f:
            f.write(image_bytes)

        file_size = len(image_bytes)
        asset_id = f"asset_{uuid.uuid4().hex[:8]}"
        now = time.time()
        relative_path = f"assets/drive_reference/{unique_file_name}"

        # 1. Register Drive Asset in DB
        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO drive_assets (
                    asset_id, file_id, file_name, file_path,
                    mime_type, file_size, associated_task_id, metadata, ingested_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """, (asset_id, file_id or "", unique_file_name, relative_path, mime_type, file_size, json.dumps(metadata or {}), now))
            conn.commit()
            conn.close()

        # 2. Auto-register into ASADF Task State Machine
        task_title = f"Process Drive Ingest: {file_name}"
        task_payload = {
            "asset_id": asset_id,
            "file_id": file_id,
            "original_name": file_name,
            "file_name": unique_file_name,
            "file_path": relative_path,
            "mime_type": mime_type,
            "file_size_bytes": file_size,
            "metadata": metadata or {}
        }
        task = TaskManager.create_task(
            title=task_title,
            task_type="DRIVE_IMAGE_INGEST",
            priority=3,  # Higher priority for incoming visual assets
            payload=task_payload
        )

        # Link task_id back to asset
        with db._lock:
            conn = db.get_connection()
            cursor = conn.cursor()
            cursor.execute("UPDATE drive_assets SET associated_task_id = ? WHERE asset_id = ?", (task["task_id"], asset_id))
            conn.commit()
            conn.close()

        # 3. Broadcast notification to room & WhatsApp
        MessageBroker.publish(
            sender="DRIVE_INGEST_BOT",
            target="ALL",
            topic="DRIVE_IMAGE_RECEIVED",
            payload={
                "asset_id": asset_id,
                "task_id": task["task_id"],
                "file_name": unique_file_name,
                "file_size": file_size,
                "download_url": f"/assets/drive_reference/{unique_file_name}"
            }
        )

        return {
            "status": "success",
            "asset_id": asset_id,
            "task_id": task["task_id"],
            "file_name": unique_file_name,
            "file_path": relative_path,
            "file_size": file_size,
            "ingested_at": now
        }

    @staticmethod
    def list_assets(limit=30):
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM drive_assets ORDER BY ingested_at DESC LIMIT ?", (limit,))
        rows = cursor.fetchall()
        conn.close()

        assets = []
        for r in rows:
            d = dict(r)
            try:
                d["metadata"] = json.loads(d["metadata"])
            except Exception:
                pass
            d["formatted_date"] = datetime.fromtimestamp(d["ingested_at"]).strftime("%Y-%m-%d %H:%M:%S")
            d["url"] = f"/assets/drive_reference/{d['file_name']}"
            assets.append(d)
        return assets


# Alias for backwards compatibility
DriveIngestionService = DriveManager

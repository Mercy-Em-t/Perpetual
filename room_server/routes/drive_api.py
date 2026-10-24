"""
Google Drive Ingestion & Asset Serving API Blueprint
Routes:
- POST /api/drive/ingest: Webhook for base64 encoded images from Google Apps Script
- GET /api/drive/assets: List recent ingested reference assets
- GET /assets/drive_reference/<path:filename>: Serve local asset images
"""

from flask import Blueprint, request, jsonify, send_from_directory
from room_server.db import ASSETS_DIR
from room_server.models.drive import DriveManager

drive_bp = Blueprint("drive_bp", __name__)


@drive_bp.route("/assets/drive_reference/<path:filename>", methods=["GET"])
def serve_drive_asset(filename):
    return send_from_directory(ASSETS_DIR, filename)


@drive_bp.route("/api/drive/ingest", methods=["POST"])
def api_drive_ingest():
    data = request.get_json(force=True, silent=True)
    if not data:
        return jsonify({"error": "Request body must be valid JSON"}), 400

    file_name = data.get("file_name")
    image_base64 = data.get("image_base64")
    if not file_name or not image_base64:
        return jsonify({"error": "'file_name' and 'image_base64' are required fields"}), 400

    file_id = data.get("file_id")
    mime_type = data.get("mime_type", "image/jpeg")
    metadata = data.get("metadata", {})

    try:
        result = DriveManager.ingest_image_blob(
            file_name=file_name,
            image_base64=image_base64,
            file_id=file_id,
            mime_type=mime_type,
            metadata=metadata
        )
        return jsonify(result), 201
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except Exception as e:
        return jsonify({"error": f"Failed to ingest image: {str(e)}"}), 500


@drive_bp.route("/api/drive/assets", methods=["GET"])
def api_drive_assets():
    limit = int(request.args.get("limit", 30))
    assets = DriveManager.list_assets(limit=limit)
    return jsonify({"assets": assets, "count": len(assets)}), 200

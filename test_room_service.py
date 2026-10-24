#!/usr/bin/env python3
"""
Verification Test Suite for Shared Agent Room Microservice
Tests all core endpoints:
- GET /health
- POST/GET /api/messages
- 5-Stage ASADF Task State Machine (/api/tasks) + Timeout Rollback
- POST /api/drive/ingest (Base64 decoding, disk persistence, auto-task registration)
- GET /room (DOM dashboard template)
- GET /room/state
"""

import os
import sys
import time
import base64
import json
import unittest

# Silence live WhatsApp dispatches during test executions
os.environ["DISABLE_WHATSAPP_DISPATCH"] = "true"

# Import the Flask application and modules
from room_server import app, db, TaskManager, MessageBroker, DriveIngestionService, TicketManager, ASSETS_DIR

class TestSharedAgentRoom(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.testing = True
        cls.client = app.test_client()

    def test_01_health_check(self):
        """Test GET /health endpoint"""
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "healthy")
        self.assertIn("stats", data)
        print("[OK] Health check endpoint verified.")

    def test_02_pubsub_messaging(self):
        """Test POST /api/messages and GET /api/messages"""
        # Publish
        payload = {
            "sender": "Agent_Alpha",
            "target": "Agent_Beta",
            "topic": "SCENE_COORDINATION",
            "payload": {"status": "sconce_anchored", "coords": [0.22, 0.18, 0.0]}
        }
        post_res = self.client.post("/api/messages", json=payload)
        self.assertEqual(post_res.status_code, 201)
        msg_data = post_res.get_json()
        self.assertEqual(msg_data["status"], "success")
        msg_id = msg_data["message"]["message_id"]

        # Fetch
        get_res = self.client.get("/api/messages?topic=SCENE_COORDINATION")
        self.assertEqual(get_res.status_code, 200)
        msgs = get_res.get_json()["messages"]
        found = any(m["message_id"] == msg_id for m in msgs)
        self.assertTrue(found)
        print(f"[OK] Pub/Sub messaging verified (Created msg: {msg_id}).")

    def test_03_asadf_5stage_state_machine(self):
        """
        Test 5-Stage ASADF State Machine:
        PENDING -> CLAIMED -> IN_PROGRESS -> VERIFIED -> DONE
        """
        # 1. Create task (State: PENDING)
        create_res = self.client.post("/api/tasks", json={
            "title": "Render Sconce Amber Glow",
            "task_type": "RENDER_PASS",
            "priority": 3,
            "payload": {"fixture": "cylindrical_sconce", "temperature": "warm_amber"}
        })
        self.assertEqual(create_res.status_code, 201)
        task = create_res.get_json()["task"]
        task_id = task["task_id"]
        self.assertEqual(task["state"], "PENDING")

        # 2. Claim task (PENDING -> CLAIMED)
        claim_res = self.client.post(f"/api/tasks/{task_id}/claim", json={"agent_id": "RenderWorker_1"})
        self.assertEqual(claim_res.status_code, 200)
        claimed_task = claim_res.get_json()["task"]
        self.assertEqual(claimed_task["state"], "CLAIMED")
        self.assertEqual(claimed_task["claimed_by"], "RenderWorker_1")

        # 3. Start task (CLAIMED -> IN_PROGRESS)
        start_res = self.client.post(f"/api/tasks/{task_id}/start", json={"agent_id": "RenderWorker_1"})
        self.assertEqual(start_res.status_code, 200)
        in_prog_task = start_res.get_json()["task"]
        self.assertEqual(in_prog_task["state"], "IN_PROGRESS")

        # 4. Verify task (IN_PROGRESS -> VERIFIED)
        verify_res = self.client.post(f"/api/tasks/{task_id}/verify", json={
            "agent_id": "RenderWorker_1",
            "result": {"render_url": "/renders/sconce_01.png", "samples": 512}
        })
        self.assertEqual(verify_res.status_code, 200)
        verified_task = verify_res.get_json()["task"]
        self.assertEqual(verified_task["state"], "VERIFIED")
        self.assertIn("render_url", verified_task["result"])

        # 5. Complete task (VERIFIED -> DONE)
        complete_res = self.client.post(f"/api/tasks/{task_id}/complete", json={
            "result": {"quality_gate": "PASSED"}
        })
        self.assertEqual(complete_res.status_code, 200)
        done_task = complete_res.get_json()["task"]
        self.assertEqual(done_task["state"], "DONE")
        print(f"[OK] ASADF 5-Stage lifecycle verified for {task_id}.")

    def test_04_claim_lease_timeout_rollback(self):
        """Test that tasks in CLAIMED state expire and rollback to PENDING after timeout."""
        # Create task
        t_res = self.client.post("/api/tasks", json={"title": "Timeout Test Task"})
        task_id = t_res.get_json()["task"]["task_id"]

        # Claim as Agent_Slow
        self.client.post(f"/api/tasks/{task_id}/claim", json={"agent_id": "Agent_Slow"})
        t_claimed = TaskManager.get_task(task_id)
        self.assertEqual(t_claimed["state"], "CLAIMED")

        # Simulate 70 seconds elapsed (lease limit is 60s)
        with db._lock:
            conn = db.get_connection()
            conn.execute("UPDATE tasks SET claimed_at = ? WHERE task_id = ?", (time.time() - 75, task_id))
            conn.commit()
            conn.close()

        # Trigger reconciliation
        TaskManager.reconcile_timeouts()

        # Check rolled back to PENDING
        t_reconciled = TaskManager.get_task(task_id)
        self.assertEqual(t_reconciled["state"], "PENDING")
        self.assertIsNone(t_reconciled["claimed_by"])
        print(f"[OK] 60-second lease timeout rollback verified (Rolled back {task_id} to PENDING).")

    def test_05_drive_image_ingestion(self):
        """
        Test POST /api/drive/ingest:
        - Decodes base64 payload
        - Writes to assets/drive_reference/
        - Automatically registers an ASADF task
        - Broadcasts DRIVE_IMAGE_RECEIVED message
        """
        # 1x1 test red pixel PNG
        pixel_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        test_filename = "breakfast_reference_sconce.png"

        ingest_payload = {
            "file_id": "gdrive_test_file_987",
            "file_name": test_filename,
            "mime_type": "image/png",
            "image_base64": pixel_b64,
            "metadata": {
                "author": "Antigravity Studio",
                "scene": "Alcove Wall with Sconce",
                "room_time": "11:09 AM"
            }
        }

        res = self.client.post("/api/drive/ingest", json=ingest_payload)
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertTrue(data["task_id"].startswith("task_"))

        # Verify file exists on disk in assets/drive_reference
        saved_file_name = data["file_name"]
        disk_path = os.path.join(ASSETS_DIR, saved_file_name)
        self.assertTrue(os.path.exists(disk_path))
        self.assertGreater(os.path.getsize(disk_path), 0)

        # Verify auto-created task
        created_task = TaskManager.get_task(data["task_id"])
        self.assertIsNotNone(created_task)
        self.assertEqual(created_task["state"], "PENDING")
        self.assertEqual(created_task["task_type"], "DRIVE_IMAGE_INGEST")
        self.assertEqual(created_task["payload"]["file_name"], saved_file_name)

        # Verify broadcast message
        msgs = MessageBroker.get_messages(topic="DRIVE_IMAGE_RECEIVED", limit=5)
        self.assertTrue(any(m["payload"].get("asset_id") == data["asset_id"] for m in msgs))

        print(f"[OK] Google Drive Ingest pipeline verified (Asset: {data['asset_id']}, Disk: {disk_path}).")

    def test_06_dom_dashboard_and_state(self):
        """Test GET /room and GET /room/state"""
        # GET /room HTML
        res_room = self.client.get("/room")
        self.assertEqual(res_room.status_code, 200)
        html = res_room.get_data(as_text=True)
        self.assertIn("SHARED AGENT ROOM", html)
        self.assertIn("ASADF Task Pipeline", html)
        self.assertIn("Drive Reference Assets", html)

        # GET /room/state
        res_state = self.client.get("/room/state")
        self.assertEqual(res_state.status_code, 200)
        state_data = res_state.get_json()
        self.assertIn("task_pipeline", state_data)
        self.assertIn("PENDING", state_data["task_pipeline"])
        self.assertIn("messages", state_data)
        self.assertIn("assets", state_data)
        self.assertIn("tickets", state_data)
        print("[OK] Real-time DOM dashboard and consolidated telemetry verified.")

    def test_07_it_helpdesk_tickets(self):
        """Test IT Helpdesk tickets: create, list, resolve, and auto-rollback tickets"""
        # 1. Create manual ticket via API
        post_res = self.client.post("/api/tickets", json={
            "title": "Camera perspective skew on left wall",
            "description": "Reported by camera worker 2 during render pass",
            "reported_by": "Worker_Camera2",
            "severity": "HIGH",
            "associated_task_id": "task_demo_cam"
        })
        self.assertEqual(post_res.status_code, 201)
        ticket = post_res.get_json()["ticket"]
        self.assertTrue(ticket["ticket_id"].startswith("TICK-"))
        self.assertEqual(ticket["status"], "OPEN")
        self.assertEqual(ticket["severity"], "HIGH")
        ticket_id = ticket["ticket_id"]

        # 2. Query tickets
        list_res = self.client.get("/api/tickets?status=OPEN")
        self.assertEqual(list_res.status_code, 200)
        tickets = list_res.get_json()["tickets"]
        self.assertTrue(any(t["ticket_id"] == ticket_id for t in tickets))

        # 3. Resolve ticket
        resolve_res = self.client.post(f"/api/tickets/{ticket_id}/resolve", json={
            "resolved_by": "LeadAdmin",
            "resolution_notes": "Sconce anchored with locking=True and camera matrices synchronized."
        })
        self.assertEqual(resolve_res.status_code, 200)
        res_ticket = resolve_res.get_json()["ticket"]
        self.assertEqual(res_ticket["status"], "RESOLVED")
        self.assertIn("locking=True", res_ticket["resolution_notes"])

        # 4. Verify auto-generated ticket from lease timeout test
        all_tickets = TicketManager.list_tickets(limit=20)
        has_timeout_ticket = any("Timeout" in t["title"] or "timeout" in t["title"] for t in all_tickets)
        self.assertTrue(has_timeout_ticket)

        print(f"[OK] IT Helpdesk Incident Tickets verified ({ticket_id} created & resolved; auto-rollback ticket logged).")

if __name__ == "__main__":
    unittest.main(verbosity=2)

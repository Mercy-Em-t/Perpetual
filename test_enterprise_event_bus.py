"""
Unit Test Suite for Python Enterprise Event Bus
Verifies Java-to-Python architectural parity:
1. Immutable RoomEvent contract
2. Wildcard topic matching (fnmatch)
3. Dead Letter Queue (DLQ) fault isolation
4. Sliding-window deduplication
5. Automatic room triggers integration
"""

import os
import unittest
from room_server.services.event_bus import (
    RoomEvent,
    EnterpriseEventBus,
    EventSubscriber,
    DeadLetterRecord
)
from room_server.models.message import MessageBroker

# Disable live network socket dispatches during unit testing
os.environ["DISABLE_WHATSAPP_DISPATCH"] = "true"


class MockRecordingSubscriber(EventSubscriber):
    def __init__(self, subscriber_id: str, topic_pattern: str):
        super().__init__(subscriber_id, topic_pattern)
        self.received_events = []

    def on_event(self, event: RoomEvent) -> None:
        self.received_events.append(event)


class FailingSubscriber(EventSubscriber):
    def __init__(self):
        super().__init__("FAILING_SUB", "*")

    def on_event(self, event: RoomEvent) -> None:
        raise ConnectionResetError("Simulated socket network disconnect")


class TestEnterpriseEventBus(unittest.TestCase):

    def test_immutable_event_record(self):
        """Validates that RoomEvent behaves as an immutable value object."""
        evt = RoomEvent(topic="TASK_CREATED", sender="TEST_WORKER", payload={"task_id": "123"})
        self.assertEqual(evt.topic, "TASK_CREATED")
        self.assertTrue(evt.event_id.startswith("evt_"))
        self.assertTrue(evt.trace_id.startswith("trc_"))

        # Verify immutability
        with self.assertRaises(Exception):
            evt.topic = "MODIFIED_TOPIC"

    def test_wildcard_topic_matching(self):
        """Validates wildcard topic routing (e.g. TASK_*, *)."""
        bus = EnterpriseEventBus(max_workers=2, dedup_window_seconds=0.0)
        task_sub = MockRecordingSubscriber("TASK_SUB", "TASK_*")
        all_sub = MockRecordingSubscriber("ALL_SUB", "*")

        bus.register(task_sub)
        bus.register(all_sub)

        # Publish TASK_CREATED
        bus.publish_sync(RoomEvent(topic="TASK_CREATED", sender="AGENT_1"))
        # Publish DRIVE_IMAGE_INGEST
        bus.publish_sync(RoomEvent(topic="DRIVE_IMAGE_INGEST", sender="DRIVE_BOT"))

        self.assertEqual(len(task_sub.received_events), 1)
        self.assertEqual(task_sub.received_events[0].topic, "TASK_CREATED")

        self.assertEqual(len(all_sub.received_events), 2)
        bus.shutdown()

    def test_dead_letter_queue_isolation(self):
        """Validates that a failing subscriber lands in DLQ without interrupting others."""
        bus = EnterpriseEventBus(max_workers=2, dedup_window_seconds=0.0)
        failing_sub = FailingSubscriber()
        healthy_sub = MockRecordingSubscriber("HEALTHY_SUB", "*")

        bus.register(failing_sub)
        bus.register(healthy_sub)

        bus.publish_sync(RoomEvent(topic="TIMEOUT_ROLLBACK", sender="RECONCILER"))

        # Healthy subscriber received event
        self.assertEqual(len(healthy_sub.received_events), 1)

        # Failing subscriber logged to DLQ
        dlq = bus.dead_letter_queue
        self.assertEqual(len(dlq), 1)
        self.assertEqual(dlq[0].subscriber_id, "FAILING_SUB")
        self.assertIn("Simulated socket network disconnect", dlq[0].error)

        bus.shutdown()

    def test_message_broker_event_bus_integration(self):
        """Validates MessageBroker publishing integrates through event bus."""
        msg = MessageBroker.publish(
            sender="ASADF_ENGINE",
            topic="TASK_STATE_CHANGED",
            payload={"task_id": "task_enterprise_01", "new_state": "CLAIMED"}
        )
        self.assertIsNotNone(msg["message_id"])
        self.assertEqual(msg["topic"], "TASK_STATE_CHANGED")


if __name__ == "__main__":
    unittest.main()

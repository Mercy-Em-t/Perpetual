"""
Database layer for Shared Agent Room.
Thread-safe SQLite connection handling and schema initialization.
"""

import os
import sqlite3
import threading

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(BASE_DIR, "assets", "drive_reference")
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
DB_PATH = os.path.join(BASE_DIR, "agent_room.db")

CLAIM_TIMEOUT_SECONDS = 60
AGENT_OFFLINE_THRESHOLD_SECONDS = 120

os.makedirs(ASSETS_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)


class Database:
    def __init__(self, db_path=DB_PATH):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def get_connection(self):
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        return conn

    def _init_db(self):
        with self._lock:
            conn = self.get_connection()
            cursor = conn.cursor()

            # Tasks table with 5-stage ASADF lifecycle
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                task_type TEXT NOT NULL DEFAULT 'GENERAL',
                state TEXT NOT NULL CHECK(state IN ('PENDING', 'CLAIMED', 'IN_PROGRESS', 'VERIFIED', 'DONE')),
                priority INTEGER NOT NULL DEFAULT 2,
                claimed_by TEXT,
                claimed_at REAL,
                claim_timeout_seconds INTEGER NOT NULL DEFAULT 60,
                payload TEXT DEFAULT '{}',
                result TEXT DEFAULT '{}',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """)

            # Pub/Sub messages table
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                message_id TEXT PRIMARY KEY,
                sender TEXT NOT NULL,
                target TEXT NOT NULL DEFAULT 'ALL',
                topic TEXT NOT NULL DEFAULT 'GENERAL',
                payload TEXT DEFAULT '{}',
                timestamp REAL NOT NULL
            )
            """)

            # Registered Agents
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'IDLE',
                current_task_id TEXT,
                last_heartbeat REAL NOT NULL,
                metadata TEXT DEFAULT '{}'
            )
            """)

            # Ingested Drive Assets
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS drive_assets (
                asset_id TEXT PRIMARY KEY,
                file_id TEXT,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                associated_task_id TEXT,
                metadata TEXT DEFAULT '{}',
                ingested_at REAL NOT NULL
            )
            """)

            # IT Helpdesk Incident Tickets
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS tickets (
                ticket_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                reported_by TEXT NOT NULL DEFAULT 'SYSTEM',
                severity TEXT NOT NULL DEFAULT 'MEDIUM' CHECK(severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
                status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
                associated_task_id TEXT,
                resolution_notes TEXT DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """)

            # Store Orders across the 5 Operational Stations
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT PRIMARY KEY,
                customer_name TEXT NOT NULL,
                customer_phone TEXT DEFAULT '',
                items TEXT NOT NULL DEFAULT '[]',
                total_amount REAL NOT NULL DEFAULT 0.0,
                currency TEXT NOT NULL DEFAULT 'USD',
                station TEXT NOT NULL DEFAULT 'PENDING' CHECK(station IN ('PENDING', 'PAID', 'PACKAGING', 'VERIFIED', 'DISPATCHED', 'CANCELLED')),
                payment_ref TEXT DEFAULT '',
                courier_name TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """)

            conn.commit()
            conn.close()


db = Database()

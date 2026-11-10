"""
Nova Perpetual - Storage
A dedicated SQLite (WAL) database, kept apart from agent_room.db so that
AI traffic (traces, cache, vectors) never contends with order-floor writes.
"""

import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS kb_chunks (
    chunk_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    heading TEXT,
    content TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'public',
    embedding BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    ingested_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS answer_cache (
    cache_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    question TEXT NOT NULL,
    embedding BLOB NOT NULL,
    answer TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]',
    hits INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_scope ON answer_cache(scope);

CREATE TABLE IF NOT EXISTS traces (
    trace_id TEXT PRIMARY KEY,
    user_id TEXT,
    role TEXT,
    tenant TEXT,
    channel TEXT,
    input TEXT,
    output TEXT,
    prompt_version TEXT,
    prompt_hash TEXT,
    model TEXT,
    route TEXT,
    cache_hit INTEGER DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    latency_ms REAL DEFAULT 0,
    status TEXT,
    guardrail_flags TEXT DEFAULT '[]',
    started_at REAL,
    ended_at REAL
);

CREATE TABLE IF NOT EXISTS spans (
    span_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    input TEXT,
    output TEXT,
    status TEXT,
    latency_ms REAL,
    meta TEXT DEFAULT '{}',
    started_at REAL
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);

CREATE TABLE IF NOT EXISTS refunds (
    refund_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL CHECK(status IN ('ISSUED', 'PENDING_APPROVAL', 'REJECTED')),
    requested_by TEXT NOT NULL,
    approved_by TEXT,
    trace_id TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED')),
    requested_by TEXT NOT NULL,
    decided_by TEXT,
    trace_id TEXT,
    created_at REAL NOT NULL,
    decided_at REAL
);
"""


class NovaStore:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.lock = threading.RLock()
        conn = self.connect()
        try:
            conn.executescript(SCHEMA)
        finally:
            conn.close()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        return conn

    def execute(self, sql: str, params: tuple = ()) -> None:
        with self.lock:
            conn = self.connect()
            try:
                conn.execute(sql, params)
                conn.commit()
            finally:
                conn.close()

    def query(self, sql: str, params: tuple = ()) -> list:
        conn = self.connect()
        try:
            return [dict(r) for r in conn.execute(sql, params).fetchall()]
        finally:
            conn.close()

    def query_one(self, sql: str, params: tuple = ()):
        rows = self.query(sql, params)
        return rows[0] if rows else None

"""
Answer cache (exact + semantic).

Safety rules - a cache is a data-leak vector if done naively:
  * The scope key includes tenant, the caller's knowledge audiences, the prompt
    hash and the knowledge-base version, so a staff/HR answer is never served
    to a customer, and any prompt or policy change invalidates old answers.
  * Only answers produced WITHOUT tool calls and WITHOUT untrusted content are
    stored (no personal order data, no injected text).
"""

import hashlib
import json
import re
import time
from typing import Dict, List, Optional

from nova_perpetual.rag.embeddings import cosine, pack, unpack
from nova_perpetual.storage import NovaStore


def normalise(q: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s$]", "", (q or "").lower())).strip()


class AnswerCache:
    def __init__(self, store: NovaStore, embedder, threshold: float, ttl_seconds: int):
        self.store, self.embedder = store, embedder
        self.threshold, self.ttl = threshold, ttl_seconds

    @staticmethod
    def scope(tenant: str, audiences, prompt_hash: str, kb_version: str) -> str:
        return hashlib.sha256(f"{tenant}|{','.join(sorted(audiences))}|{prompt_hash}|{kb_version}".encode()).hexdigest()[:16]

    def get(self, scope: str, question: str) -> Optional[Dict]:
        cutoff = time.time() - self.ttl
        key = hashlib.sha256(f"{scope}|{normalise(question)}".encode()).hexdigest()
        row = self.store.query_one("SELECT * FROM answer_cache WHERE cache_key=? AND created_at>?", (key, cutoff))
        kind = "exact"
        if not row:
            qv = self.embedder.embed(normalise(question))
            best, best_s = None, 0.0
            for r in self.store.query("SELECT * FROM answer_cache WHERE scope=? AND created_at>?", (scope, cutoff)):
                s = cosine(qv, unpack(r["embedding"]))
                if s > best_s:
                    best, best_s = r, s
            if best is None or best_s < self.threshold:
                return None
            row, kind = best, f"semantic:{best_s:.3f}"
        self.store.execute("UPDATE answer_cache SET hits=hits+1 WHERE cache_key=?", (row["cache_key"],))
        return {"answer": row["answer"], "citations": json.loads(row["citations"]), "kind": kind}

    def put(self, scope: str, question: str, answer: str, citations: List[str]) -> None:
        norm = normalise(question)
        key = hashlib.sha256(f"{scope}|{norm}".encode()).hexdigest()
        self.store.execute(
            "INSERT OR REPLACE INTO answer_cache (cache_key, scope, question, embedding, answer, citations, hits,"
            " created_at) VALUES (?,?,?,?,?,?,0,?)",
            (key, scope, question, pack(self.embedder.embed(norm)), answer, json.dumps(citations), time.time()))

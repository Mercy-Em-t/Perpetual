"""
Knowledge base: ingestion (chunk -> embed -> store) and audience-filtered retrieval.

Documents are Markdown files with optional front matter:

    ---
    audience: public        # public | staff | hr
    ---

Chunks inherit their document's audience, and retrieval only searches chunks the
caller's role is cleared for - so RBAC applies to documents, not just tools.
"""

import hashlib
import os
import re
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Set

from nova_perpetual.rag.embeddings import cosine, pack, unpack
from nova_perpetual.storage import NovaStore

FRONT_MATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)
MAX_CHUNK_CHARS = 700


@dataclass
class Chunk:
    chunk_id: str
    source: str
    heading: str
    content: str
    audience: str
    score: float = 0.0


def parse_document(text: str) -> (Dict[str, str], str):
    meta: Dict[str, str] = {}
    m = FRONT_MATTER_RE.match(text)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        text = text[m.end():]
    return meta, text


def chunk_markdown(text: str) -> List[tuple]:
    """Split on headings, then pack paragraphs up to MAX_CHUNK_CHARS. Returns (heading, body)."""
    sections, heading, buf = [], "", []
    for line in text.splitlines():
        if line.startswith("#"):
            if "".join(buf).strip():
                sections.append((heading, "\n".join(buf).strip()))
            heading, buf = line.lstrip("# ").strip(), []
        else:
            buf.append(line)
    if "".join(buf).strip():
        sections.append((heading, "\n".join(buf).strip()))

    chunks = []
    for head, body in sections:
        current = ""
        for para in re.split(r"\n\s*\n", body):
            if current and len(current) + len(para) > MAX_CHUNK_CHARS:
                chunks.append((head, current.strip()))
                current = ""
            current += para + "\n\n"
        if current.strip():
            chunks.append((head, current.strip()))
    return chunks


class KnowledgeBase:
    def __init__(self, store: NovaStore, embedder):
        self.store = store
        self.embedder = embedder

    def ingest_directory(self, directory: str) -> Dict[str, int]:
        stats = {"files": 0, "chunks": 0, "unchanged": 0}
        seen: Set[str] = set()
        for root, _, files in os.walk(directory):
            for fn in sorted(files):
                if not fn.endswith((".md", ".txt")):
                    continue
                path = os.path.join(root, fn)
                rel = os.path.relpath(path, directory).replace("\\", "/")
                with open(path, "r", encoding="utf-8") as f:
                    meta, body = parse_document(f.read())
                stats["files"] += 1
                for i, (heading, content) in enumerate(chunk_markdown(body)):
                    chunk_id = f"{rel}#{i}"
                    seen.add(chunk_id)
                    text_for_embedding = f"{heading}\n{content}"
                    h = hashlib.sha256((text_for_embedding + meta.get("audience", "public")).encode()).hexdigest()
                    existing = self.store.query_one("SELECT content_hash FROM kb_chunks WHERE chunk_id=?", (chunk_id,))
                    if existing and existing["content_hash"] == h:
                        stats["unchanged"] += 1
                        continue
                    self.store.execute(
                        "INSERT OR REPLACE INTO kb_chunks (chunk_id, source, heading, content, audience, embedding,"
                        " content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
                        (chunk_id, rel, heading, content, meta.get("audience", "public"),
                         pack(self.embedder.embed(text_for_embedding)), h, time.time()))
                    stats["chunks"] += 1
        # Remove chunks whose source text disappeared (stale policy must never be quoted)
        for row in self.store.query("SELECT chunk_id FROM kb_chunks"):
            if row["chunk_id"] not in seen:
                self.store.execute("DELETE FROM kb_chunks WHERE chunk_id=?", (row["chunk_id"],))
        return stats

    def version(self) -> str:
        rows = self.store.query("SELECT content_hash FROM kb_chunks ORDER BY chunk_id")
        return hashlib.sha256("".join(r["content_hash"] for r in rows).encode()).hexdigest()[:12]

    def search(self, query: str, audiences: Set[str], top_k: int = 3, min_score: float = 0.08) -> List[Chunk]:
        if not audiences:
            return []
        qv = self.embedder.embed(query)
        placeholders = ",".join("?" for _ in audiences)
        rows = self.store.query(f"SELECT * FROM kb_chunks WHERE audience IN ({placeholders})", tuple(audiences))
        scored = []
        for r in rows:
            s = cosine(qv, unpack(r["embedding"]))
            if s >= min_score:
                scored.append(Chunk(r["chunk_id"], r["source"], r["heading"], r["content"], r["audience"], s))
        scored.sort(key=lambda c: c.score, reverse=True)
        return scored[:top_k]

    @staticmethod
    def format_context(chunks: List[Chunk]) -> Optional[str]:
        if not chunks:
            return None
        parts = []
        for i, c in enumerate(chunks, 1):
            title = f"{c.heading}: " if c.heading else ""
            parts.append(f"[S{i}] (source: {c.source})\n{title}{c.content}")
        return "\n".join(parts)

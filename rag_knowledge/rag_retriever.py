#!/usr/bin/env python3
"""
RAG Knowledge Retriever CLI and Programmatic Engine
Grounded Semantic Search across the Shared Agent Room & Multi-Agent Architecture
"""

import os
import sys
import json
import math
import re
from typing import List, Dict, Any, Optional

import zlib

class RAGRetriever:
    def __init__(self, index_path: Optional[str] = None):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        if index_path is None:
            index_path = os.path.join(base_dir, "index", "vector_index.json")
        self.index_path = index_path
        self.dim = 256
        self.indexed_cards: List[Dict[str, Any]] = []
        self._load_index()

    def _load_index(self):
        if not os.path.exists(self.index_path):
            raise FileNotFoundError(f"Index file not found: {self.index_path}")
        with open(self.index_path, "r", encoding="utf-8") as f:
            self.indexed_cards = json.load(f)

    def embed(self, text: str) -> List[float]:
        stop_words = {
            'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'in', 'to', 'of', 'for', 
            'with', 'as', 'by', 'we', 'how', 'do', 'that', 'this', 'it', 'from', 'be', 'are', 
            'so', 'you', 'can', 'our', 'what', 'their', 'they', 'your'
        }
        vec = [0.0] * self.dim
        raw_tokens = re.findall(r'\b\w+\b', text.lower())
        tokens = [t for t in raw_tokens if t not in stop_words and len(t) > 2]
        synonym_boosts = {
            'sconce': ['fixture', 'lamp', 'light', 'anchoring', 'matrix'],
            'fixture': ['sconce', 'lamp', 'light', 'anchoring', 'matrix'],
            'lock': ['locking', 'anchored', 'pinned', 'fixed', 'matrix'],
            'flask': ['server', 'microservice', 'room', 'pubsub', 'endpoint'],
            'pubsub': ['flask', 'server', 'microservice', 'room', 'messages'],
            'nook': ['layout', 'sofa', 'alcove', 'couch', 'tv', 'bracket'],
            'spotify': ['audio', 'music', 'nasty', 'track', 'media', 'sound'],
            'state': ['machine', 'fsm', 'pending', 'claimed', 'progress'],
            'tunnel': ['cloudflare', 'ingress', 'remote', 'zerotrust', 'network']
        }
        expanded = []
        for t in tokens:
            expanded.append(t)
            if t in synonym_boosts:
                expanded.extend(synonym_boosts[t])

        for token in expanded:
            h = zlib.crc32(token.encode('utf-8')) % self.dim
            vec[h] += 1.0
        norm = math.sqrt(sum(x * x for x in vec))
        return [x / norm for x in vec] if norm > 0 else vec

    def query(self, text: str, top_k: int = 5, category_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        q_vec = self.embed(text)
        results = []
        for item in self.indexed_cards:
            card = item["card"]
            if category_filter and category_filter.lower() not in card.get("category", "").lower():
                continue
            doc_vec = item["vector"]
            # Cosine similarity (dot product of L2-normalized vectors)
            score = sum(q * d for q, d in zip(q_vec, doc_vec))
            results.append({"card": card, "score": score})

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_k]

def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if len(sys.argv) < 2:
        print("Usage: python rag_retriever.py '<search query>' [top_k]")
        sys.exit(1)

    query_str = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    retriever = RAGRetriever()
    hits = retriever.query(query_str, top_k=top_k)

    print(f"\n[QUERY]: '{query_str}' ({len(hits)} results)\n" + "=" * 70)
    for i, hit in enumerate(hits, 1):
        c = hit["card"]
        score = hit["score"]
        print(f"[{i}] [{c['card_id']}] {c['topic']} (Score: {score:.4f})")
        print(f"    Category: {c['category']}")
        print(f"    Source:   {c['source_file']} (Page {c['page_number']})")
        print(f"    Summary:  {c['summary']}")
        print(f"    Entities: {', '.join(c.get('key_entities', []))}")
        print(f"    Tags:     {' '.join(c.get('tags', []))}")
        print("-" * 70)

if __name__ == "__main__":
    main()

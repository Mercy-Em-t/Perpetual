"""
Embedding backends.
- HashEmbedder: offline feature-hashing embedder (no network, deterministic).
  Good enough for a policy corpus of hundreds of chunks and for CI.
- OpenAIEmbedder / GeminiEmbedder: production semantic embeddings.
Vectors are L2-normalised so cosine similarity == dot product.
"""

import hashlib
import math
import os
import re
from array import array
from typing import List

import requests

DIM = 512
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _normalise(vec: List[float]) -> List[float]:
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def pack(vec: List[float]) -> bytes:
    return array("f", vec).tobytes()


def unpack(blob: bytes) -> List[float]:
    a = array("f")
    a.frombytes(blob)
    return a.tolist()


def cosine(a: List[float], b: List[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _stem(tok: str) -> str:
    for suffix in ("ing", "ed", "es", "s"):
        if len(tok) > 4 and tok.endswith(suffix):
            return tok[: -len(suffix)]
    return tok


class HashEmbedder:
    name = "hash"
    dim = DIM

    def embed(self, text: str) -> List[float]:
        toks = [_stem(t) for t in _TOKEN_RE.findall((text or "").lower())]
        feats = toks + [f"{a}_{b}" for a, b in zip(toks, toks[1:])]
        vec = [0.0] * DIM
        for f in feats:
            h = int(hashlib.md5(f.encode()).hexdigest(), 16)
            vec[h % DIM] += 1.0 if (h >> 9) & 1 else -1.0
        return _normalise(vec)


class OpenAIEmbedder:
    name = "openai"

    def __init__(self, model: str = "text-embedding-3-small"):
        self.model = model

    def embed(self, text: str) -> List[float]:
        key = os.environ["OPENAI_API_KEY"]
        r = requests.post("https://api.openai.com/v1/embeddings", timeout=30,
                          headers={"Authorization": f"Bearer {key}"},
                          json={"model": self.model, "input": text})
        r.raise_for_status()
        return _normalise(r.json()["data"][0]["embedding"])


class GeminiEmbedder:
    name = "gemini"

    def __init__(self, model: str = "text-embedding-004"):
        self.model = model

    def embed(self, text: str) -> List[float]:
        key = os.environ["GEMINI_API_KEY"]
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:embedContent"
        r = requests.post(url, timeout=30, headers={"x-goog-api-key": key},
                          json={"content": {"parts": [{"text": text}]}})
        r.raise_for_status()
        return _normalise(r.json()["embedding"]["values"])


def get_embedder(name: str):
    return {"hash": HashEmbedder, "openai": OpenAIEmbedder, "gemini": GeminiEmbedder}[name]()

"""
Nova Perpetual - Runtime Settings
All knobs are environment-driven so the same code runs offline (mock provider)
in tests/CI and against real model providers in production.
"""

import os
from dataclasses import dataclass, field
from typing import Dict

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(PACKAGE_DIR)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class NovaSettings:
    # Brand
    assistant_name: str = field(default_factory=lambda: os.environ.get("NOVA_ASSISTANT_NAME", "Nova"))

    # LLM providers: mock | openai | anthropic | gemini
    provider: str = field(default_factory=lambda: os.environ.get("NOVA_PROVIDER", "mock"))
    small_model: str = field(default_factory=lambda: os.environ.get("NOVA_SMALL_MODEL", "mock-small"))
    large_model: str = field(default_factory=lambda: os.environ.get("NOVA_LARGE_MODEL", "mock-large"))

    # Embeddings: hash (offline) | openai | gemini
    embedding_provider: str = field(default_factory=lambda: os.environ.get("NOVA_EMBEDDINGS", "hash"))

    # Storage
    db_path: str = field(default_factory=lambda: os.environ.get(
        "NOVA_DB_PATH", os.path.join(PROJECT_DIR, "nova_perpetual.db")))
    knowledge_dir: str = field(default_factory=lambda: os.environ.get(
        "NOVA_KNOWLEDGE_DIR", os.path.join(PACKAGE_DIR, "knowledge")))
    prompts_dir: str = field(default_factory=lambda: os.environ.get(
        "NOVA_PROMPTS_DIR", os.path.join(PACKAGE_DIR, "prompts")))

    # Security
    token_secret: str = field(default_factory=lambda: os.environ.get("NOVA_TOKEN_SECRET", "dev-only-change-me"))
    refund_auto_approve_limit: float = field(default_factory=lambda: _env_float("NOVA_REFUND_AUTO_LIMIT", 50.0))
    max_side_effect_tools_per_turn: int = 1

    # Release gate: refuse to serve a prompt version that has no passing eval stamp
    enforce_eval_gate: bool = field(default_factory=lambda: os.environ.get(
        "NOVA_ENFORCE_EVAL_GATE", "true").lower() in ("1", "true", "yes"))

    # Cache
    semantic_cache_threshold: float = field(default_factory=lambda: _env_float("NOVA_SEMANTIC_CACHE_THRESHOLD", 0.93))
    cache_ttl_seconds: int = 3600

    # Agent loop
    max_agent_steps: int = 5
    rag_top_k: int = 3

    # USD per 1K tokens (input, output) - used for cost tracing; override per deployment
    pricing: Dict[str, tuple] = field(default_factory=lambda: {
        "mock-small": (0.0, 0.0),
        "mock-large": (0.0, 0.0),
        "gpt-4o-mini": (0.00015, 0.0006),
        "gpt-4o": (0.0025, 0.01),
        "claude-3-5-haiku-latest": (0.0008, 0.004),
        "claude-sonnet-4-5": (0.003, 0.015),
        "gemini-2.0-flash": (0.0001, 0.0004),
        "gemini-2.5-pro": (0.00125, 0.01),
    })

    # Competitors Nova must never endorse (brand loyalty guardrail)
    competitors: tuple = ("FastShip", "QuickParcel", "SpeedyPost", "DHL", "FedEx", "UPS", "G4S Courier", "Sendy")

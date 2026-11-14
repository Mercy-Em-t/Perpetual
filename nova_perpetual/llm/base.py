"""
Provider-neutral LLM contract.
Every provider adapter translates to/from these types, so the agent loop,
guardrails, tracing and evals never depend on a specific vendor SDK.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class Message:
    role: str  # system | user | assistant | tool
    content: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    tool_call_id: Optional[str] = None
    name: Optional[str] = None  # tool name for role=tool


@dataclass
class LLMResponse:
    content: str
    tool_calls: List[ToolCall]
    model: str
    tokens_in: int
    tokens_out: int


class LLMProvider:
    name = "base"

    def complete(self, model: str, messages: List[Message], tools: List[ToolSpec]) -> LLMResponse:
        raise NotImplementedError


def estimate_tokens(text: str) -> int:
    return max(1, len(text or "") // 4)

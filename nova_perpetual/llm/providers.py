"""
LLM provider adapters.
- OpenAI / Anthropic / Gemini: thin HTTP adapters (no vendor SDKs) translating
  the provider-neutral Message/ToolSpec types to each wire format.
- MockProvider: a deterministic, intentionally *naive* model used offline, in
  tests and in CI evals. It obeys whatever text it sees (including injected
  instructions) so that the surrounding guardrails - not the model - are what
  get exercised and verified.
"""

import json
import os
import re
import uuid
from typing import Any, Dict, List

import requests

from nova_perpetual.llm.base import LLMProvider, LLMResponse, Message, ToolCall, ToolSpec, estimate_tokens

HTTP_TIMEOUT = 60


class ProviderError(RuntimeError):
    pass


def _require_key(env_name: str) -> str:
    key = os.environ.get(env_name, "").strip()
    if not key:
        raise ProviderError(f"{env_name} is not set. Add it to the environment to use this provider.")
    return key


# --------------------------------------------------------------------------- OpenAI
class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, base_url: str = None):
        self.base_url = base_url or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")

    def complete(self, model, messages, tools):
        key = _require_key("OPENAI_API_KEY")
        wire = []
        for m in messages:
            if m.role == "tool":
                wire.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
            elif m.role == "assistant" and m.tool_calls:
                wire.append({
                    "role": "assistant",
                    "content": m.content or None,
                    "tool_calls": [{
                        "id": tc.id, "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}
                    } for tc in m.tool_calls],
                })
            else:
                wire.append({"role": m.role, "content": m.content})
        body: Dict[str, Any] = {"model": model, "messages": wire, "temperature": 0.2}
        if tools:
            body["tools"] = [{"type": "function", "function": {
                "name": t.name, "description": t.description, "parameters": t.parameters}} for t in tools]
        r = requests.post(f"{self.base_url}/chat/completions", json=body, timeout=HTTP_TIMEOUT,
                          headers={"Authorization": f"Bearer {key}"})
        if r.status_code >= 400:
            raise ProviderError(f"OpenAI {r.status_code}: {r.text[:300]}")
        data = r.json()
        msg = data["choices"][0]["message"]
        calls = [ToolCall(id=tc["id"], name=tc["function"]["name"],
                          arguments=json.loads(tc["function"].get("arguments") or "{}"))
                 for tc in (msg.get("tool_calls") or [])]
        usage = data.get("usage", {})
        return LLMResponse(content=msg.get("content") or "", tool_calls=calls, model=model,
                           tokens_in=usage.get("prompt_tokens", 0), tokens_out=usage.get("completion_tokens", 0))


# --------------------------------------------------------------------------- Anthropic
class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def complete(self, model, messages, tools):
        key = _require_key("ANTHROPIC_API_KEY")
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        wire: List[Dict[str, Any]] = []
        for m in messages:
            if m.role == "system":
                continue
            if m.role == "tool":
                block = {"type": "tool_result", "tool_use_id": m.tool_call_id, "content": m.content}
                # Consecutive tool results must share a single user turn
                if wire and wire[-1]["role"] == "user" and isinstance(wire[-1]["content"], list) \
                        and wire[-1]["content"] and wire[-1]["content"][0].get("type") == "tool_result":
                    wire[-1]["content"].append(block)
                else:
                    wire.append({"role": "user", "content": [block]})
            elif m.role == "assistant":
                blocks: List[Dict[str, Any]] = []
                if m.content:
                    blocks.append({"type": "text", "text": m.content})
                for tc in m.tool_calls:
                    blocks.append({"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments})
                wire.append({"role": "assistant", "content": blocks or m.content})
            else:
                wire.append({"role": "user", "content": m.content})
        body: Dict[str, Any] = {"model": model, "max_tokens": 1024, "system": system, "messages": wire}
        if tools:
            body["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.parameters}
                             for t in tools]
        r = requests.post("https://api.anthropic.com/v1/messages", json=body, timeout=HTTP_TIMEOUT,
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
        if r.status_code >= 400:
            raise ProviderError(f"Anthropic {r.status_code}: {r.text[:300]}")
        data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        calls = [ToolCall(id=b["id"], name=b["name"], arguments=b.get("input") or {})
                 for b in data.get("content", []) if b.get("type") == "tool_use"]
        usage = data.get("usage", {})
        return LLMResponse(content=text, tool_calls=calls, model=model,
                           tokens_in=usage.get("input_tokens", 0), tokens_out=usage.get("output_tokens", 0))


# --------------------------------------------------------------------------- Gemini
def _gemini_schema(schema: Any) -> Any:
    """Gemini's function schema is a subset of JSON Schema; strip unsupported keys."""
    if isinstance(schema, dict):
        return {k: _gemini_schema(v) for k, v in schema.items()
                if k not in ("additionalProperties", "$schema", "default")}
    if isinstance(schema, list):
        return [_gemini_schema(s) for s in schema]
    return schema


class GeminiProvider(LLMProvider):
    name = "gemini"

    def complete(self, model, messages, tools):
        key = _require_key("GEMINI_API_KEY")
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        contents: List[Dict[str, Any]] = []
        for m in messages:
            if m.role == "system":
                continue
            if m.role == "tool":
                try:
                    payload = json.loads(m.content)
                except (ValueError, TypeError):
                    payload = {"result": m.content}
                if not isinstance(payload, dict):
                    payload = {"result": payload}
                part = {"functionResponse": {"name": m.name, "response": payload}}
                if contents and contents[-1]["role"] == "user" and "functionResponse" in contents[-1]["parts"][0]:
                    contents[-1]["parts"].append(part)
                else:
                    contents.append({"role": "user", "parts": [part]})
            elif m.role == "assistant":
                parts = [{"text": m.content}] if m.content else []
                parts += [{"functionCall": {"name": tc.name, "args": tc.arguments}} for tc in m.tool_calls]
                contents.append({"role": "model", "parts": parts or [{"text": ""}]})
            else:
                contents.append({"role": "user", "parts": [{"text": m.content}]})
        body: Dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {"temperature": 0.2},
        }
        if tools:
            body["tools"] = [{"functionDeclarations": [
                {"name": t.name, "description": t.description, "parameters": _gemini_schema(t.parameters)}
                for t in tools]}]
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        r = requests.post(url, json=body, timeout=HTTP_TIMEOUT, headers={"x-goog-api-key": key})
        if r.status_code >= 400:
            raise ProviderError(f"Gemini {r.status_code}: {r.text[:300]}")
        data = r.json()
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        calls = [ToolCall(id=f"call_{uuid.uuid4().hex[:8]}", name=p["functionCall"]["name"],
                          arguments=p["functionCall"].get("args") or {})
                 for p in parts if "functionCall" in p]
        usage = data.get("usageMetadata", {})
        return LLMResponse(content=text, tool_calls=calls, model=model,
                           tokens_in=usage.get("promptTokenCount", 0),
                           tokens_out=usage.get("candidatesTokenCount", 0))


# --------------------------------------------------------------------------- Mock
ORDER_ID_RE = re.compile(r"\bORD-[A-Z0-9]{3,}\b", re.IGNORECASE)
AMOUNT_RE = re.compile(r"(?:\$|USD\s*|KES\s*)(\d+(?:\.\d+)?)", re.IGNORECASE)
STOPWORDS = set("""a an the is are was were what whats what's how much many for of to in on at my me i
you your our we it this that do does can could should would with and or be by from which who
when where why limit""".split())


def _tokens(text: str) -> List[str]:
    return [t for t in re.findall(r"[a-z0-9$]+", (text or "").lower()) if t not in STOPWORDS]


def _call(name: str, **args) -> ToolCall:
    return ToolCall(id=f"call_{uuid.uuid4().hex[:8]}", name=name, arguments=args)


class MockProvider(LLMProvider):
    """Deterministic rule-based stand-in for a real LLM (see module docstring)."""
    name = "mock"

    def complete(self, model, messages, tools):
        tool_names = {t.name for t in tools}
        system = "\n".join(m.content for m in messages if m.role == "system")
        user_msgs = [m for m in messages if m.role == "user"]
        user_text = user_msgs[-1].content if user_msgs else ""
        # Index of the last user message: only tool results after it belong to this turn
        last_user_idx = max(i for i, m in enumerate(messages) if m.role == "user") if user_msgs else -1
        turn_tool_msgs = [m for m in messages[last_user_idx + 1:] if m.role == "tool"]

        content, calls = self._decide(system, user_text, turn_tool_msgs, tool_names)
        prompt_chars = sum(len(m.content or "") for m in messages)
        return LLMResponse(content=content, tool_calls=calls, model=model,
                           tokens_in=estimate_tokens("x" * prompt_chars), tokens_out=estimate_tokens(content))

    # ---- decision logic ----
    def _decide(self, system: str, user_text: str, tool_msgs: List[Message], tool_names: set):
        low = user_text.lower()
        order_ids = sorted({o.upper() for o in ORDER_ID_RE.findall(user_text)})
        wants_bulk_refund = bool(re.search(r"refund (every|all)( the)? orders?", low))

        if tool_msgs:
            last = tool_msgs[-1]
            try:
                result = json.loads(last.content)
            except (ValueError, TypeError):
                result = {"raw": last.content}
            # Naive multi-step: follow an injected "refund everything" after listing orders
            if wants_bulk_refund and last.name == "list_my_orders" and "issue_refund" in tool_names:
                done = {m.name for m in tool_msgs}
                if "issue_refund" not in done and isinstance(result, dict):
                    return "", [_call("issue_refund", order_id=o["order_id"], reason="Customer request")
                                for o in result.get("orders", [])]
            return self._summarise_tools(tool_msgs), []

        # --- tool intents ---
        if wants_bulk_refund and "list_my_orders" in tool_names:
            return "", [_call("list_my_orders")]
        if "refund" in low and order_ids and "issue_refund" in tool_names:
            amt = AMOUNT_RE.search(user_text)
            args = {"order_id": order_ids[0], "reason": "damaged parcel" if "damag" in low else "customer request"}
            if amt:
                args["amount"] = float(amt.group(1))
            return "", [_call("issue_refund", **args)]
        if order_ids and re.search(r"where|status|track|parcel|order", low) and "get_order_status" in tool_names:
            return "", [_call("get_order_status", order_id=order_ids[0])]
        if re.search(r"\b(salary|salaries|payroll|earn|earns|make|makes|paid)\b", low) and \
                re.search(r"how much|salary|payroll|earn", low) and "get_compensation" in tool_names:
            target = "my manager" if "manager" in low else ("me" if re.search(r"\b(i|my)\b", low) else user_text)
            return "", [_call("get_compensation", employee=target)]
        if re.search(r"\b(ping|notify|alert|tell)\b.*\bteam\b", low) and "notify_team" in tool_names:
            return "", [_call("notify_team", department="floor_operations", message=user_text[:280])]
        if re.search(r"open (a )?ticket|raise (a )?ticket|report (an )?(issue|incident)", low) and \
                "open_ticket" in tool_names:
            return "", [_call("open_ticket", title=user_text[:80], description=user_text, severity="MEDIUM")]

        # --- brand loyalty: behaviour depends entirely on the system prompt ---
        if re.search(r"(best|recommend|which|good).*(delivery|courier|shipping|logistics)", low):
            if re.search(r"never (recommend|endorse|promote) (a )?competitor", system, re.IGNORECASE):
                return ("I'd recommend Perpetua Express - our own delivery service with tracked, "
                        "insured parcels. I can check any order for you right now."), []
            return "Honestly, FastShip is the best delivery company around - fast and cheap.", []

        # --- grounded answer from retrieved context ---
        return self._answer_from_context(system, user_text), []

    @staticmethod
    def _answer_from_context(system: str, question: str) -> str:
        blocks = re.findall(r"\[(S\d+)\] \(source: ([^)]+)\)\n(.*?)(?=\n\[S\d+\] \(source:|\Z)", system, re.S)
        q = set(_tokens(question))
        best, best_score = None, 0.0
        for label, source, body in blocks:
            for sent in re.split(r"(?<=[.!?])\s+|\n+", body):
                s_tokens = set(_tokens(sent))
                if not s_tokens:
                    continue
                score = len(q & s_tokens) / (len(q) ** 0.5 + 1e-9)
                if score > best_score:
                    best, best_score = (label, source, sent.strip(" -*")), score
        if not best or best_score < 0.5:
            return "I don't have that in Perpetua's documents, so I won't guess. I can open a ticket for the team."
        label, source, sent = best
        return f"{sent} [{label}: {source}]"

    @staticmethod
    def _summarise_tools(tool_msgs: List[Message]) -> str:
        lines = []
        for m in tool_msgs:
            try:
                r = json.loads(m.content)
            except (ValueError, TypeError):
                r = {"raw": m.content}
            if isinstance(r, dict) and r.get("error"):
                lines.append(f"I couldn't complete {m.name}: {r['error']}")
            elif isinstance(r, dict) and r.get("summary"):
                lines.append(r["summary"])
            else:
                lines.append(f"{m.name} result: {json.dumps(r)[:300]}")
        return "\n".join(lines)


def get_provider(name: str) -> LLMProvider:
    providers = {"mock": MockProvider, "openai": OpenAIProvider,
                 "anthropic": AnthropicProvider, "gemini": GeminiProvider}
    if name not in providers:
        raise ProviderError(f"Unknown provider '{name}'. Choose one of {sorted(providers)}")
    return providers[name]()

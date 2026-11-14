"""
NovaAgent - the request pipeline.

    identity -> prompt gate -> input guardrails -> router (fast path | cache | LLM)
    -> RAG -> agent loop (RBAC + side-effect policy per tool call)
    -> output guardrails (brand loyalty, PII) -> cache -> trace
"""

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from nova_perpetual.approvals import ApprovalService
from nova_perpetual.cache import AnswerCache
from nova_perpetual.config import NovaSettings
from nova_perpetual.llm import Message, ModelRouter, ProviderError, get_provider
from nova_perpetual.observability import Tracer
from nova_perpetual.prompts.registry import EvalGateError, PromptIntegrityError, PromptRegistry
from nova_perpetual.rag import KnowledgeBase, get_embedder
from nova_perpetual.security import guardrails, rbac
from nova_perpetual.security.principal import Principal
from nova_perpetual.storage import NovaStore
from nova_perpetual.tools.backend import PerpetualBackend
from nova_perpetual.tools.registry import TOOLS, ToolContext, execute_tool, to_json, tools_for

UNAVAILABLE = "Nova is temporarily unavailable while a configuration issue is resolved. Please try again shortly."


@dataclass
class Attachment:
    source: str        # e.g. "email:customer@example.com"
    content: str


@dataclass
class NovaReply:
    answer: str
    trace_id: str
    route: str
    cache_hit: bool = False
    citations: List[str] = field(default_factory=list)
    actions: List[Dict[str, Any]] = field(default_factory=list)
    pending_approvals: List[str] = field(default_factory=list)
    flags: List[str] = field(default_factory=list)
    prompt_version: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return self.__dict__.copy()


class NovaAgent:
    def __init__(self, settings: NovaSettings, backend: PerpetualBackend, store: Optional[NovaStore] = None,
                 provider=None):
        self.settings = settings
        self.backend = backend
        self.store = store or NovaStore(settings.db_path)
        self.embedder = get_embedder(settings.embedding_provider)
        self.kb = KnowledgeBase(self.store, self.embedder)
        self.prompts = PromptRegistry(settings.prompts_dir)
        self.provider = provider or get_provider(settings.provider)
        self.router = ModelRouter(settings.small_model, settings.large_model)
        self.cache = AnswerCache(self.store, self.embedder, settings.semantic_cache_threshold,
                                 settings.cache_ttl_seconds)
        self.tracer = Tracer(self.store)
        self.approvals = ApprovalService(self.store)

    # ------------------------------------------------------------------ public
    def chat(self, principal: Principal, message: str, attachments: Optional[List[Attachment]] = None,
             channel: str = "api", prompt_version: Optional[str] = None) -> NovaReply:
        attachments = attachments or []
        trace = self.tracer.start(principal, channel, message)
        reply = NovaReply(answer="", trace_id=trace.trace_id, route="")
        try:
            self._run(principal, message, attachments, prompt_version, trace, reply)
            status = "ok"
        except (PromptIntegrityError, EvalGateError) as e:
            trace.flags.append("prompt_gate_blocked")
            reply.answer, reply.route, status = UNAVAILABLE, "blocked", "blocked"
            trace.fields["error"] = str(e)
            with trace.span("gate", "prompt_registry") as s:
                s["output"], s["status"] = str(e), "blocked"
        except ProviderError as e:
            reply.answer, status = "I'm having trouble reaching my language model right now. Please try again.", "error"
            with trace.span("llm", "provider_error") as s:
                s["output"], s["status"] = str(e), "error"
        reply.flags = list(dict.fromkeys(trace.flags))
        self.tracer.finish(trace, reply.answer, status)
        return reply

    def execute_deferred(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Run a tool call that a human approved (called by ApprovalService.decide)."""
        p = Principal(**{**payload["principal"], "departments": tuple(payload["principal"].get("departments", []))})
        ctx = ToolContext(p, self.backend, self.store, self.settings, trace_id=payload.get("trace_id", ""))
        return execute_tool(ctx, payload["tool"], payload["arguments"])

    # ------------------------------------------------------------------ pipeline
    def _run(self, principal, message, attachments, prompt_version, trace, reply):
        prompt = self.prompts.load(prompt_version, enforce_gate=self.settings.enforce_eval_gate)
        trace.fields.update(prompt_version=prompt.version, prompt_hash=prompt.sha256)
        reply.prompt_version = prompt.version

        # 1. Input guardrails
        with trace.span("guardrail", "input_scan", message, attachments=len(attachments)) as s:
            scan = guardrails.scan_for_injection(message + "\n" + "\n".join(a.content for a in attachments))
            tainted = bool(attachments) or scan.suspicious
            if scan.suspicious:
                trace.flags.extend(f"injection:{f}" for f in scan.flags)
            if attachments:
                trace.flags.append("untrusted_content")
            s["output"] = {"flags": scan.flags, "tainted": tainted}

        user_content = message + "".join("\n\n" + guardrails.wrap_untrusted(a.content, a.source) for a in attachments)

        # 2. Route
        route = self.router.route(message, has_untrusted=tainted)
        reply.route = route.tier
        trace.fields["route"] = route.tier
        with trace.span("router", "route", message) as s:
            s["output"] = route.__dict__

        if route.tier == "fast_path":
            ctx = ToolContext(principal, self.backend, self.store, self.settings, trace.trace_id)
            with trace.span("tool", route.fast_tool, route.fast_args, fast_path=True) as s:
                result = execute_tool(ctx, route.fast_tool, route.fast_args)
                s["output"] = result
            reply.actions.append({"tool": route.fast_tool, "arguments": route.fast_args, "result": result})
            trace.fields["model"] = "none"
            reply.answer = self._output_guardrails(result.get("summary") or result.get("error", ""), principal, trace)
            return

        # 3. Cache (only for clean, tool-free questions)
        audiences = rbac.allowed_audiences(principal)
        scope = AnswerCache.scope(principal.tenant, audiences, prompt.sha256, self.kb.version())
        if not tainted:
            with trace.span("cache", "lookup", message) as s:
                hit = self.cache.get(scope, message)
                s["output"] = hit and hit["kind"]
            if hit:
                trace.fields.update(cache_hit=True, model="cache")
                reply.cache_hit, reply.citations, reply.route = True, hit["citations"], "cache"
                trace.fields["route"] = "cache"
                reply.answer = hit["answer"]
                return

        # 4. Retrieval (audience-filtered)
        with trace.span("retrieval", "kb_search", message, audiences=sorted(audiences)) as s:
            chunks = self.kb.search(message, audiences, top_k=self.settings.rag_top_k)
            s["output"] = [{"source": c.chunk_id, "score": round(c.score, 3)} for c in chunks]
        context = KnowledgeBase.format_context(chunks)

        system = prompt.render(assistant_name=self.settings.assistant_name,
                               org_name="Perpetua Artisanal & Decor Hub", user_name=principal.name,
                               role=principal.role, today=time.strftime("%Y-%m-%d"))
        system += "\n\n## Retrieved policy context\n" + (context or "(no relevant documents found)")

        # 5. Agent loop
        messages = [Message("system", system), Message("user", user_content)]
        answer, used_tools = self._agent_loop(principal, messages, route, tainted, trace, reply)

        # 6. Output guardrails
        rewritten_before = len(trace.flags)
        answer = self._output_guardrails(answer, principal, trace)
        cited = sorted(set(re.findall(r"\[S(\d+)", answer)))
        reply.citations = [chunks[int(i) - 1].source for i in cited if 0 < int(i) <= len(chunks)]
        reply.answer = answer

        # 7. Cache write
        if not used_tools and not tainted and len(trace.flags) == rewritten_before and reply.citations:
            self.cache.put(scope, message, answer, reply.citations)

    def _agent_loop(self, principal, messages, route, tainted, trace, reply):
        tools = tools_for(principal)
        specs = [t.spec() for t in tools]
        ctx = ToolContext(principal, self.backend, self.store, self.settings, trace.trace_id)
        side_effects, used_tools = 0, False
        models = [route.model] + ([self.settings.small_model] if route.model != self.settings.small_model else [])

        for step in range(self.settings.max_agent_steps):
            resp = self._complete_with_fallback(models, messages, specs, trace, step)
            if not resp.tool_calls:
                return resp.content, used_tools
            used_tools = True
            messages.append(Message("assistant", resp.content, tool_calls=resp.tool_calls))
            for tc in resp.tool_calls:
                tool = TOOLS.get(tc.name)
                decision = guardrails.side_effect_policy(tc.name, tainted, side_effects,
                                                         self.settings.max_side_effect_tools_per_turn)
                with trace.span("tool", tc.name, tc.arguments, side_effect=bool(tool and tool.side_effect)) as s:
                    if not decision.allowed and rbac.can_use_tool(principal, tc.name):
                        apr = self.approvals.request(
                            kind="deferred_tool_call",
                            payload={"tool": tc.name, "arguments": tc.arguments, "trace_id": trace.trace_id,
                                     "principal": {**principal.__dict__, "departments": list(principal.departments)}},
                            reason=decision.reason, requested_by=principal.user_id, trace_id=trace.trace_id)
                        reply.pending_approvals.append(apr)
                        trace.flags.append("action_held_for_approval")
                        result = {"held_for_approval": apr,
                                  "summary": f"I haven't done that yet: {tc.name} needs human approval "
                                             f"({apr}). {decision.reason}"}
                        s["status"] = "held"
                    else:
                        result = execute_tool(ctx, tc.name, tc.arguments)
                        if result.get("denied"):
                            trace.flags.append("rbac_denied")
                            s["status"] = "denied"
                        elif tool and tool.side_effect and not result.get("error"):
                            side_effects += 1
                    s["output"] = result
                reply.actions.append({"tool": tc.name, "arguments": tc.arguments, "result": result})
                messages.append(Message("tool", to_json(result), tool_call_id=tc.id, name=tc.name))
        return "I wasn't able to finish that request. I've logged it so the team can follow up.", used_tools

    def _complete_with_fallback(self, models, messages, specs, trace, step):
        last_err = None
        for model in models:
            with trace.span("llm", model, {"step": step, "messages": len(messages)}) as s:
                try:
                    resp = self.provider.complete(model, messages, specs)
                except ProviderError as e:
                    last_err = e
                    s["status"], s["output"] = "error", str(e)
                    continue
                cost = trace.add_usage(model, resp.tokens_in, resp.tokens_out, self.settings.pricing)
                trace.fields["model"] = model
                s["output"] = {"content": resp.content, "tool_calls": [tc.__dict__ for tc in resp.tool_calls]}
                s["meta"].update(tokens_in=resp.tokens_in, tokens_out=resp.tokens_out, cost_usd=cost)
                return resp
        raise last_err or ProviderError("No model available")

    def _output_guardrails(self, answer: str, principal: Principal, trace) -> str:
        with trace.span("guardrail", "output_scan", answer) as s:
            if guardrails.endorses_competitor(answer, self.settings.competitors):
                trace.flags.append("competitor_endorsement_blocked")
                answer = guardrails.BRAND_SAFE_RESPONSE
            answer, n = guardrails.mask_pii(answer)
            if n:
                trace.flags.append("pii_masked")
            s["output"] = answer
        return answer

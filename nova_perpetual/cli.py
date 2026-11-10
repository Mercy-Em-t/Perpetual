"""
Nova Perpetual CLI

  python -m nova_perpetual.cli ingest
  python -m nova_perpetual.cli prompt status | register v1 | new | activate v2
  python -m nova_perpetual.cli evals [--version v2] [--stamp] [--json]
  python -m nova_perpetual.cli token --role CUSTOMER --phone +254722000111 --name Amina
  python -m nova_perpetual.cli chat --role CUSTOMER --phone +254722000111 "Where is ORD-1001?"
  python -m nova_perpetual.cli traces [--id trc_...]
"""

import argparse
import json
import sys

from nova_perpetual.config import NovaSettings
from nova_perpetual.prompts.registry import PromptRegistry
from nova_perpetual.security.principal import Principal, customer_principal, issue_token, principal_from_org_member


def _principal(args) -> Principal:
    if args.role == "CUSTOMER":
        return customer_principal(args.phone or "", args.name or "Customer")
    if args.phone:
        p = principal_from_org_member(args.phone)
        if p:
            return p
    return Principal(user_id=args.user_id or f"usr_{args.role.lower()}", name=args.name or args.role.title(),
                     role=args.role, phone=args.phone or "")


def _identity_args(p):
    p.add_argument("--role", default="CUSTOMER")
    p.add_argument("--phone")
    p.add_argument("--name")
    p.add_argument("--user-id")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="nova")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ingest")

    pp = sub.add_parser("prompt")
    pp.add_argument("action", choices=["status", "register", "new", "activate"])
    pp.add_argument("version", nargs="?")

    ep = sub.add_parser("evals")
    ep.add_argument("--version")
    ep.add_argument("--stamp", action="store_true")
    ep.add_argument("--json", action="store_true")

    tp = sub.add_parser("token")
    _identity_args(tp)
    tp.add_argument("--ttl", type=int, default=3600)

    cp = sub.add_parser("chat")
    _identity_args(cp)
    cp.add_argument("--backend", choices=["live", "memory"], default="memory")
    cp.add_argument("--email", help="Path to an email/document to attach as untrusted content")
    cp.add_argument("message")

    trp = sub.add_parser("traces")
    trp.add_argument("--id")

    args = ap.parse_args(argv)
    s = NovaSettings()
    reg = PromptRegistry(s.prompts_dir)

    if args.cmd == "ingest":
        from nova_perpetual.rag import KnowledgeBase, get_embedder
        from nova_perpetual.storage import NovaStore
        print(json.dumps(KnowledgeBase(NovaStore(s.db_path), get_embedder(s.embedding_provider))
                         .ingest_directory(s.knowledge_dir)))
        return 0

    if args.cmd == "prompt":
        if args.action == "status":
            print(json.dumps(reg._read(), indent=2))
        elif args.action == "register":
            print(f"registered {args.version}: {reg.register(args.version)}")
        elif args.action == "new":
            v = reg.new_version(args.version)
            print(f"created prompts/system.{v}.md - edit it, then run: prompt register {v} && evals --version {v} --stamp")
        elif args.action == "activate":
            reg.activate(args.version)
            print(f"{args.version} is now active")
        return 0

    if args.cmd == "evals":
        from nova_perpetual.evals.runner import format_report, run_evals
        report = run_evals(s, version=args.version)
        print(json.dumps(report, indent=2) if args.json else format_report(report))
        if args.stamp:
            version = args.version or reg._read()["active"]
            reg.stamp_eval(version, report["passed"], report)
            print(f"stamped {version}: passed={report['passed']}")
        return 0 if report["passed"] else 1

    if args.cmd == "token":
        print(issue_token(_principal(args), s.token_secret, args.ttl))
        return 0

    if args.cmd == "chat":
        from nova_perpetual.agent import Attachment, NovaAgent
        from nova_perpetual.tools.backend import InMemoryBackend, LivePerpetualBackend
        agent = NovaAgent(s, InMemoryBackend() if args.backend == "memory" else LivePerpetualBackend())
        agent.kb.ingest_directory(s.knowledge_dir)
        atts = []
        if args.email:
            with open(args.email, "r", encoding="utf-8") as f:
                atts.append(Attachment(source=f"email:{args.email}", content=f.read()))
        print(json.dumps(agent.chat(_principal(args), args.message, atts, channel="cli").to_dict(), indent=2))
        return 0

    if args.cmd == "traces":
        from nova_perpetual.observability import Tracer
        from nova_perpetual.storage import NovaStore
        t = Tracer(NovaStore(s.db_path))
        print(json.dumps(t.get(args.id) if args.id else {"stats": t.stats(), "recent": t.recent(20)},
                         indent=2, default=str))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

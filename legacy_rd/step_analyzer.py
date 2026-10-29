#!/usr/bin/env python3
"""
Step Analyzer & Trajectory Dependency Graph Engine
Deep forensic audit of conversation trajectory steps, thematic clusters, and cross-step lineages.
"""

import os
import sys
import json
import re
import argparse
from datetime import datetime
from collections import defaultdict
from typing import List, Dict, Any, Set, Tuple

# Ensure UTF-8 output on Windows terminals
if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

DEFAULT_CONV_ID = "41890625-6523-4286-8f79-b0e0cb6bdfdb"
BRAIN_BASE = r"C:\Users\user\.gemini\antigravity\brain"

def clean_xml_tags(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r'</?(?:USER_REQUEST|ADDITIONAL_METADATA|SYSTEM_MESSAGE|USER_SETTINGS_CHANGE)[^>]*>', '', text)
    return text.strip()

class StepNode:
    def __init__(self, step_idx: int, timestamp: str = ""):
        self.step_idx = step_idx
        self.timestamp = timestamp
        self.user_prompt = ""
        self.planner_summary = ""
        self.tools: List[str] = []
        self.files_read: Set[str] = set()
        self.files_written: Set[str] = set()
        self.entities: Set[str] = set()
        self.tags: Set[str] = set()
        self.category = "General"
        # Links
        self.precursors: Set[int] = set()
        self.successors: Set[int] = set()
        self.thematic_siblings: Set[int] = set()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step_idx": self.step_idx,
            "timestamp": self.timestamp,
            "category": self.category,
            "user_prompt": self.user_prompt[:250],
            "planner_summary": self.planner_summary[:300],
            "tools": self.tools[:8],
            "files_read": sorted(list(self.files_read)),
            "files_written": sorted(list(self.files_written)),
            "entities": sorted(list(self.entities)),
            "tags": sorted(list(self.tags)),
            "precursors": sorted(list(self.precursors)),
            "successors": sorted(list(self.successors)),
            "thematic_siblings": sorted(list(self.thematic_siblings))
        }

class StepAnalyzer:
    def __init__(self, conv_id: str = DEFAULT_CONV_ID):
        self.conv_id = conv_id
        self.transcript_path = os.path.join(BRAIN_BASE, conv_id, ".system_generated", "logs", "transcript.jsonl")
        self.nodes: Dict[int, StepNode] = {}
        self.entity_index: Dict[str, Set[int]] = defaultdict(set)
        self.file_index: Dict[str, Set[int]] = defaultdict(set)
        self.category_index: Dict[str, Set[int]] = defaultdict(set)
        self._load_and_parse()
        self._build_relationship_graph()

    def _extract_entities(self, text: str) -> Set[str]:
        entities = set()
        # IPs
        for ip in re.findall(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', text):
            entities.add(f"IP:{ip}")
        # Key scripts / files
        for fn in re.findall(r'\b[\w\-\.]+\.(?:py|mjs|cjs|js|json|md|vxp|sh|yaml)\b', text, re.IGNORECASE):
            entities.add(f"FILE:{fn.lower()}")
        # Hardware / Protocols
        keywords = {
            'tailscale': 'NET:Tailscale',
            'netplan': 'NET:Netplan',
            'rtw-8821ce': 'HW:RTW-8821CE-WiFi',
            'villaon': 'HW:Villaon-V2160',
            'vxp': 'ROM:MediaTek-VXP',
            'ttyusb': 'PORT:/dev/ttyUSB',
            'daraja': 'FIN:Daraja-API',
            '5758419': 'TILL:5758419',
            'mpesa': 'FIN:M-Pesa',
            'baileys': 'BOT:Baileys-WhatsApp',
            'dokploy': 'SRV:Dokploy',
            'creative galore': 'SHOP:Creative-Galore',
            'whitelabel': 'CORE:TMS-Whitelabel',
            'dispute': 'OPS:Disputes-Desk',
            'hotspot': 'NET:Mobile-Hotspot'
        }
        tl = text.lower()
        for k, v in keywords.items():
            if k in tl:
                entities.add(v)
        return entities

    def _classify_category(self, text: str) -> Tuple[str, Set[str]]:
        tl = text.lower()
        tags = set()
        if any(k in tl for k in ['tailscale', 'netplan', 'hotspot', 'tether', 'usb', 'ping', 'ufw', 'rtw']):
            cat = "Infrastructure & Connectivity"
            tags.update(['#Networking', '#Tailscale', '#HardwareLink'])
        elif any(k in tl for k in ['vxp', 'mediatek', 'mre', 'villaon', 'v2160', 'rom', 'binary']):
            cat = "Feature Phone & Baseband"
            tags.update(['#FeaturePhone', '#MediaTek', '#HardwareModem'])
        elif any(k in tl for k in ['till', '5758419', 'mpesa', 'stk', 'payment', 'ledger', 'sms']):
            cat = "M-Pesa & Payment Automation"
            tags.update(['#MPesa', '#Payments', '#TillLedger'])
        elif any(k in tl for k in ['whatsapp', 'baileys', 'bot', 'qr', 'chat']):
            cat = "WhatsApp Autonomous Gateway"
            tags.update(['#WhatsApp', '#Baileys', '#Automation'])
        elif any(k in tl for k in ['storefront', 'catalog', 'spinner', 'checkout', 'creative galore', 'whitelabel']):
            cat = "Storefront & Client UX"
            tags.update(['#Storefront', '#Whitelabel', '#Frontend'])
        elif any(k in tl for k in ['dispute', 'refund', 'claim']):
            cat = "Disputes & Reconciliation"
            tags.update(['#Disputes', '#Audit'])
        else:
            cat = "General Operations"
            tags.update(['#DevOps', '#Operations'])
        return cat, tags

    def _load_and_parse(self):
        if not os.path.exists(self.transcript_path):
            print(f"Error: Transcript not found at {self.transcript_path}")
            return

        current_node = None
        with open(self.transcript_path, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                try:
                    data = json.loads(line)
                except Exception:
                    continue

                msg_type = data.get('type')
                step_idx = data.get('step_index', 0)
                content = data.get('content', '')
                created_at = data.get('created_at', '')

                if msg_type == 'USER_INPUT':
                    cleaned_prompt = clean_xml_tags(content)
                    if not cleaned_prompt or len(cleaned_prompt) < 4:
                        continue
                    current_node = StepNode(step_idx, created_at)
                    current_node.user_prompt = cleaned_prompt
                    self.nodes[step_idx] = current_node
                
                elif msg_type == 'PLANNER_RESPONSE' and current_node:
                    if content:
                        clean_resp = clean_xml_tags(content)
                        if clean_resp and not current_node.planner_summary:
                            current_node.planner_summary = clean_resp[:400]
                    
                    for tc in data.get('tool_calls', []):
                        fn_name = tc.get('name') or tc.get('toolSummary') or 'command'
                        current_node.tools.append(fn_name)
                        args = tc.get('args', {}) or tc
                        path = args.get('Path') or args.get('path') or ''
                        if path:
                            bn = os.path.basename(path).lower()
                            if 'write' in fn_name.lower() or 'edit' in fn_name.lower():
                                current_node.files_written.add(bn)
                            else:
                                current_node.files_read.add(bn)

        # Post-process entities and categorization
        for idx, node in self.nodes.items():
            combined_text = f"{node.user_prompt} {node.planner_summary} {' '.join(node.tools)}"
            node.entities = self._extract_entities(combined_text)
            node.category, node.tags = self._classify_category(combined_text)

            # Build indexes
            self.category_index[node.category].add(idx)
            for ent in node.entities:
                self.entity_index[ent].add(idx)
            for fn in node.files_written | node.files_read:
                self.file_index[fn].add(idx)

    def _build_relationship_graph(self):
        sorted_steps = sorted(self.nodes.keys())
        
        # Link sequential precursors/successors within the same category
        cat_chains = defaultdict(list)
        for s in sorted_steps:
            cat = self.nodes[s].category
            cat_chains[cat].append(s)

        for cat, chain in cat_chains.items():
            for i in range(len(chain) - 1):
                prev_s = chain[i]
                next_s = chain[i + 1]
                self.nodes[next_s].precursors.add(prev_s)
                self.nodes[prev_s].successors.add(next_s)

        # Entity-based cross-step linkage
        for s in sorted_steps:
            node = self.nodes[s]
            for ent in node.entities:
                related = self.entity_index[ent] - {s}
                for r in related:
                    node.thematic_siblings.add(r)

    def inspect_step(self, step_idx: int) -> str:
        target_idx = step_idx
        if target_idx not in self.nodes:
            # Check if target falls within a turn range
            sorted_keys = sorted(self.nodes.keys())
            matched = None
            for i in range(len(sorted_keys)):
                curr_s = sorted_keys[i]
                next_s = sorted_keys[i+1] if i + 1 < len(sorted_keys) else float('inf')
                if curr_s <= target_idx < next_s:
                    matched = curr_s
                    break
            if matched is not None:
                target_idx = matched
            else:
                closest = min(self.nodes.keys(), key=lambda x: abs(x - step_idx))
                target_idx = closest

        node = self.nodes[target_idx]
        lines = []
        lines.append("=" * 80)
        lines.append(f"  🔍 STEP ANALYZER: STEP {node.step_idx} [{node.category.upper()}]")
        lines.append(f"  Timestamp: {node.timestamp}")
        lines.append("=" * 80)
        lines.append(f"\n[USER PROMPT]:\n{node.user_prompt}")
        lines.append(f"\n[AGENT RESPONSE / ACTION]:\n{node.planner_summary}")
        lines.append(f"\n[KEY ENTITIES]: {', '.join(sorted(node.entities)) or 'None'}")
        lines.append(f"[FILES ACCESSED]: Read: {list(node.files_read)} | Written: {list(node.files_written)}")
        lines.append(f"[TOOLS USED]: {', '.join(node.tools[:5]) or 'None'}")
        
        lines.append("\n" + "-" * 50)
        lines.append("  🔗 RELATIONSHIP & DEPENDENCY GRAPH")
        lines.append("-" * 50)
        
        if node.precursors:
            lines.append(f"  ⬆️ Upstream Precursor Steps: {sorted(list(node.precursors))}")
        else:
            lines.append("  ⬆️ Upstream Precursor Steps: (Root of topic chain)")

        if node.successors:
            lines.append(f"  ⬇️ Downstream Successor Steps: {sorted(list(node.successors))}")
        else:
            lines.append("  ⬇️ Downstream Successor Steps: (Terminal of topic chain)")

        if node.thematic_siblings:
            sibling_sample = sorted(list(node.thematic_siblings))[:8]
            lines.append(f"  🔄 Related Thematic Steps: {sibling_sample} (Total linked: {len(node.thematic_siblings)})")

        return "\n".join(lines)

    def trace_chain(self, start_step: int) -> str:
        if start_step not in self.nodes:
            return f"Step {start_step} does not exist."

        lines = []
        lines.append(f"### ⛓️ CAUSALITY & DEPENDENCY CHAIN FROM STEP {start_step}")
        curr = start_step
        visited = set()
        step_list = []

        while curr and curr not in visited:
            visited.add(curr)
            step_list.append(curr)
            succ = sorted(list(self.nodes[curr].successors))
            curr = succ[0] if succ else None

        for s in step_list:
            node = self.nodes[s]
            first_line = node.user_prompt.split('\n')[0][:70]
            lines.append(f"- **Step {node.step_idx}** `[{node.category}]`: {first_line}")
            if node.entities:
                lines.append(f"  *Entities:* {', '.join(sorted(list(node.entities))[:4])}")

        return "\n".join(lines)

    def search_query(self, query: str) -> str:
        ql = query.lower()
        matches = []
        for idx, node in self.nodes.items():
            text = f"{node.user_prompt} {node.planner_summary} {' '.join(node.entities)}".lower()
            if ql in text:
                matches.append(node)

        lines = [f"Found {len(matches)} steps matching '{query}':\n"]
        for m in matches[:15]:
            first_line = m.user_prompt.split('\n')[0][:65]
            lines.append(f"* **Step {m.step_idx:04d}** [{m.category}]: {first_line}")
            lines.append(f"  Linked to: Precursors {list(m.precursors)[:3]} | Successors {list(m.successors)[:3]}")
        return "\n".join(lines)

    def generate_markdown_matrix(self, output_path: str):
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write("# 🧭 Step Dependency & Trajectory Matrix\n")
            f.write("### *End-to-End Forensic Map of Conversation Steps & Thematic Lineages*\n\n")
            f.write(f"**Total Indexed User Milestones:** `{len(self.nodes)}`  \n")
            f.write(f"**Analyzed Conversation:** `{self.conv_id}`  \n")
            f.write(f"**Generated:** `{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`  \n\n")

            f.write("## 1. High-Level Trajectory Clusters\n\n")
            for cat, steps in self.category_index.items():
                f.write(f"### 📂 {cat} (`{len(steps)}` steps)\n")
                f.write(f"**Step Span:** `Step {min(steps)}` ➔ `Step {max(steps)}`  \n")
                sample_steps = sorted(list(steps))[:6]
                f.write(f"**Key Anchor Steps:** {', '.join([f'`Step {s}`' for s in sample_steps])}  \n\n")

            f.write("## 2. Master Step Cross-Reference Matrix\n\n")
            f.write("| Step | Category | What This Step Was About | Key Entities | Precursors (Came From) | Successors (Led To) |\n")
            f.write("| :--- | :--- | :--- | :--- | :--- | :--- |\n")

            for s in sorted(self.nodes.keys()):
                node = self.nodes[s]
                about = node.user_prompt.split('\n')[0][:80].replace('|', '/')
                ents = ", ".join(sorted(list(node.entities))[:3])
                pre = ", ".join([f"`{p}`" for p in sorted(list(node.precursors))[:2]]) or "—"
                succ = ", ".join([f"`sc`" for sc in sorted(list(node.successors))[:2]]) or "—"
                f.write(f"| **`{node.step_idx}`** | {node.category} | {about} | {ents} | {pre} | {succ} |\n")

        print(f"Matrix written to {output_path}")

def main():
    parser = argparse.ArgumentParser(description="Conversation Step Analyzer & Trajectory Graph")
    parser.add_argument("--step", type=int, help="Inspect a specific step")
    parser.add_argument("--chain", type=int, help="Trace causality chain starting from step")
    parser.add_argument("--search", type=str, help="Search for steps by keyword")
    parser.add_argument("--matrix", action="store_true", help="Generate full markdown matrix report")
    parser.add_argument("--conv", type=str, default=DEFAULT_CONV_ID, help="Conversation ID to analyze")

    args = parser.parse_args()
    analyzer = StepAnalyzer(args.conv)

    if args.step:
        print(analyzer.inspect_step(args.step))
    elif args.chain:
        print(analyzer.trace_chain(args.chain))
    elif args.search:
        print(analyzer.search_query(args.search))
    elif args.matrix:
        out = os.path.join(r"c:\Users\user\Documents\Perpetual\docs", "step_dependency_matrix.md")
        analyzer.generate_markdown_matrix(out)
    else:
        # Default behavior: run summary and generate matrix
        print(f"Loaded {len(analyzer.nodes)} milestone steps.")
        print("\n--- SAMPLE INSPECTION: STEP 4013 (Turning Point) ---")
        print(analyzer.inspect_step(4013))
        out = os.path.join(r"c:\Users\user\Documents\Perpetual\docs", "step_dependency_matrix.md")
        analyzer.generate_markdown_matrix(out)

if __name__ == "__main__":
    main()

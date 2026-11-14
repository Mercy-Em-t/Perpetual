#!/usr/bin/env python3
"""
RAGerize Conversation Transcript, Artifacts, and Source Code
Extracts semantic knowledge cards, 256-dim embeddings, and standalone retriever CLI.
"""
import os
import sys
import json
import re
import math
import zlib
from datetime import datetime
from typing import List, Dict, Any, Tuple

DIM = 256
STOP_WORDS = {
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'in', 'to', 'of', 'for', 
    'with', 'as', 'by', 'we', 'how', 'do', 'that', 'this', 'it', 'from', 'be', 'are', 
    'so', 'you', 'can', 'our', 'what', 'their', 'they', 'your', 'i', 'me', 'my', 'have'
}

SYNONYMS = {
    'mpesa': ['daraja', 'stk', 'payment', 'till', 'transaction', 'sms', 'reconciler', 'settle'],
    'whatsapp': ['baileys', 'gateway', 'microservice', 'bot', 'qr', 'chat', 'message', 'group', 'dm'],
    'resurrect': ['revive', 'reorder', 'repeat', 'expired', 'abandoned', 'rearm', 'cart'],
    'guardrail': ['rbac', 'unpaid', 'terminal', 'immutable', 'authority', 'filter', 'sanity'],
    'channel': ['newsletter', 'broadcast', 'updates', 'showcase', 'catalog', 'drops'],
    'savannah': ['server', 'backend', 'node', 'pavilion', 'microservice', 'express', 'cloud'],
    'storefront': ['whitelabel', 'catalog', 'checkout', 'orders', 'tms', 'haberdashery']
}

def clean_text(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r'<USER_REQUEST>[\s\S]*?</USER_REQUEST>', lambda m: m.group(0).replace('<USER_REQUEST>', '').replace('</USER_REQUEST>', ''), text)
    text = re.sub(r'<ADDITIONAL_METADATA>[\s\S]*?</ADDITIONAL_METADATA>', '', text)
    text = re.sub(r'<SYSTEM_MESSAGE>[\s\S]*?</SYSTEM_MESSAGE>', '', text)
    text = re.sub(r'<USER_SETTINGS_CHANGE>[\s\S]*?</USER_SETTINGS_CHANGE>', '', text)
    return text.strip()

def embed(text: str, dim: int = DIM) -> List[float]:
    vec = [0.0] * dim
    raw_tokens = re.findall(r'\b\w+\b', text.lower())
    tokens = [t for t in raw_tokens if t not in STOP_WORDS and len(t) > 2]
    expanded = []
    for t in tokens:
        expanded.append(t)
        if t in SYNONYMS:
            expanded.extend(SYNONYMS[t])
    for token in expanded:
        h = zlib.crc32(token.encode('utf-8')) % dim
        vec[h] += 1.0
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec] if norm > 0 else vec

def extract_entities(text: str) -> List[str]:
    entities = set()
    ips = re.findall(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', text)
    entities.update(ips[:3])
    files = re.findall(r'\b[\w\-\.]+\.(?:mjs|cjs|js|json|md|py|sql|ps1)\b', text)
    entities.update(files[:6])
    orders = re.findall(r'#[0-9a-fA-F]{8}\b', text)
    entities.update(orders[:4])
    keywords = ['Baileys', 'M-Pesa', 'Supabase', 'Haberdashery', 'PerpetualGateway',
                'missperpetual.cloud', 'OrderResurrection', 'WhatsAppChannel',
                'MultiDeviceListener', 'Guardrails']
    for kw in keywords:
        if kw.lower() in text.lower():
            entities.add(kw)
    return sorted(list(entities))[:10]

def categorize_content(text: str) -> Tuple[str, List[str]]:
    tl = text.lower()
    tags = []
    if any(k in tl for k in ['resurrect', 'reorder', 'repeat', 'expired', 'abandoned']):
        category = "Order Resurrection & Re-Order Engine"
        tags.extend(['#OrderResurrection', '#ReOrder', '#CartRecovery', '#Commerce'])
    elif any(k in tl for k in ['channel', 'newsletter', 'broadcast', 'showcase']):
        category = "WhatsApp Channels & Public Marketing"
        tags.extend(['#WhatsAppChannels', '#Newsletter', '#Showcase', '#Marketing'])
    elif any(k in tl for k in ['mpesa', 'till', 'stk', 'payment', 'auto-settled']):
        category = "M-Pesa Auto-Reconciliation"
        tags.extend(['#MPesa', '#Payments', '#AutoReconcile', '#Cashier'])
    elif any(k in tl for k in ['guardrail', 'rbac', 'terminal', 'unpaid', 'negation']):
        category = "Enterprise Safety Guardrails"
        tags.extend(['#Guardrails', '#RBAC', '#TerminalState', '#Security'])
    elif any(k in tl for k in ['fromme', 'multidevice', 'linked device', 'baileys', 'botsent']):
        category = "WhatsApp Gateway Architecture & Multi-Device"
        tags.extend(['#Baileys', '#WhatsAppGateway', '#MultiDevice', '#EdgeCore'])
    elif any(k in tl for k in ['missperpetual', 'domain', 'ddns', 'namecheap', 'tunnel']):
        category = "Cloud Ingress & missperpetual.cloud Topology"
        tags.extend(['#missperpetual', '#CloudIngress', '#DDNS', '#Networking'])
    elif any(k in tl for k in ['photo', 'draft', 'approval', 'optimistic', 'strict']):
        category = "Product Photo Ingestion & Catalog Lifecycle"
        tags.extend(['#PhotoIngestion', '#Catalog', '#ApprovalPolicy', '#StudioPreview'])
    else:
        category = "Systems Analysis & Engineering Specifications"
        tags.extend(['#SAD', '#IEEE29148', '#Architecture', '#Specifications'])
    return category, list(set(tags))

def process_transcript(transcript_path: str, conv_id: str, start_idx: int) -> Tuple[List[Dict[str, Any]], int]:
    cards = []
    card_idx = start_idx
    if not os.path.exists(transcript_path):
        print(f"Transcript not found: {transcript_path}")
        return cards, card_idx

    print(f"Reading transcript: {transcript_path} ({os.path.getsize(transcript_path)} bytes)...")
    turns = []
    current_turn = None

    with open(transcript_path, 'r', encoding='utf-8', errors='ignore') as f:
        for line_num, line in enumerate(f):
            try:
                data = json.loads(line)
            except Exception:
                continue

            msg_type = data.get('type')
            step_idx = data.get('step_index', line_num)
            content = data.get('content', '')
            created_at = data.get('created_at', '')

            if msg_type == 'USER_INPUT':
                clean_c = clean_text(content)
                if not clean_c or len(clean_c) < 5:
                    continue
                if current_turn:
                    turns.append(current_turn)
                current_turn = {
                    'step': step_idx,
                    'user': clean_c,
                    'created_at': created_at,
                    'planner': [],
                    'tool_calls': []
                }
            elif msg_type == 'PLANNER_RESPONSE' and current_turn is not None:
                if content:
                    clean_p = clean_text(content)
                    if clean_p:
                        current_turn['planner'].append(clean_p)
                for tc in data.get('tool_calls', []):
                    current_turn['tool_calls'].append(tc.get('toolSummary') or tc.get('CommandLine') or tc.get('Path') or '')

        if current_turn:
            turns.append(current_turn)

    print(f"Extracted {len(turns)} conversation turns from {conv_id}.")

    for turn in turns:
        user_text = turn['user']
        planner_texts = "\n\n".join(turn['planner'])
        tools_summary = ", ".join([t for t in turn['tool_calls'] if t][:4])

        combined_text = f"USER REQUEST:\n{user_text}\n\nAGENT EXECUTION & SOLUTION:\n{planner_texts}"
        if tools_summary:
            combined_text += f"\n\nTOOLS APPLIED:\n{tools_summary}"

        if len(combined_text) < 70:
            continue

        category, tags = categorize_content(combined_text)
        entities = extract_entities(combined_text)

        first_line = user_text.split('\n')[0].strip()
        topic = re.sub(r'^[#*\-•\s]+', '', first_line)[:90] or f"{category} Exchange"

        summary = f"User: {user_text[:140].replace(chr(10), ' ')} | Result: {planner_texts[:160].replace(chr(10), ' ')}..."

        grounded_rules = []
        rule_matches = re.findall(r'(?:rule|must|guardrail|endpoint|port|policy|key):[^\.\n]+', combined_text, re.IGNORECASE)
        for rm in rule_matches[:3]:
            grounded_rules.append(rm.strip().capitalize())
        if not grounded_rules:
            grounded_rules.append(f"Derived from conversation turn {turn['step']} on {turn['created_at'][:10]}.")

        card = {
            'card_id': f"RAG-TRANS-{card_idx:04d}",
            'category': category,
            'topic': topic,
            'source_file': f"transcript:{conv_id}",
            'page_number': turn['step'],
            'timestamp': turn['created_at'],
            'summary': summary,
            'key_entities': entities,
            'content': combined_text[:3500],
            'grounded_rules': grounded_rules,
            'tags': tags
        }
        cards.append(card)
        card_idx += 1

    return cards, card_idx

def process_artifacts(artifacts_dir: str, start_idx: int) -> Tuple[List[Dict[str, Any]], int]:
    cards = []
    card_idx = start_idx
    if not os.path.exists(artifacts_dir):
        return cards, card_idx

    print(f"Scanning markdown artifacts in {artifacts_dir}...")
    for f in os.listdir(artifacts_dir):
        if f.endswith('.md'):
            fp = os.path.join(artifacts_dir, f)
            try:
                with open(fp, 'r', encoding='utf-8', errors='ignore') as af:
                    content = af.read()
            except Exception:
                continue

            sections = re.split(r'\n(?=#{1,3}\s+)', content)
            for s_idx, sec in enumerate(sections):
                sec_str = sec.strip()
                if len(sec_str) < 120:
                    continue

                lines = sec_str.split('\n')
                topic = lines[0].strip('#*` ') or f"{f} Section {s_idx+1}"
                category, tags = categorize_content(sec_str)
                entities = extract_entities(sec_str)

                grounded_rules = []
                rules = re.findall(r'(?:[0-9]+\.\s+|[-*]\s+)(?:[A-Z][^\.\n]+\.)', sec_str)
                for r in rules[:3]:
                    grounded_rules.append(r.strip('-*0123456789. '))
                if not grounded_rules:
                    grounded_rules.append(f"Specification derived from artifact {f}.")

                card = {
                    'card_id': f"RAG-SPEC-{card_idx:04d}",
                    'category': category,
                    'topic': topic[:100],
                    'source_file': f"artifact:{f}",
                    'page_number': s_idx + 1,
                    'timestamp': datetime.now().isoformat(),
                    'summary': sec_str[:220].replace('\n', ' ') + '...',
                    'key_entities': entities,
                    'content': sec_str[:3500],
                    'grounded_rules': grounded_rules,
                    'tags': tags + [f"#{f.replace('.md', '')}"]
                }
                cards.append(card)
                card_idx += 1

    return cards, card_idx

def process_source_code(code_dir: str, start_idx: int) -> Tuple[List[Dict[str, Any]], int]:
    cards = []
    card_idx = start_idx
    if not os.path.exists(code_dir):
        return cards, card_idx

    print(f"Scanning source code files in {code_dir}...")
    for f in os.listdir(code_dir):
        if f.endswith('.mjs') or f.endswith('.js'):
            fp = os.path.join(code_dir, f)
            try:
                with open(fp, 'r', encoding='utf-8', errors='ignore') as cf:
                    code_content = cf.read()
            except Exception:
                continue

            # Split by functions or major blocks
            functions = re.findall(r'(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{', code_content)
            category, tags = categorize_content(code_content)
            entities = extract_entities(code_content)

            card = {
                'card_id': f"RAG-CODE-{card_idx:04d}",
                'category': f"Source Code: {category}",
                'topic': f"Module Implementation: {f}",
                'source_file': f"src:{f}",
                'page_number': 1,
                'timestamp': datetime.now().isoformat(),
                'summary': f"Source module {f} containing functions: {', '.join(functions[:6])}.",
                'key_entities': entities + functions[:5],
                'content': code_content[:3500],
                'grounded_rules': [
                    f"Exports key functions: {', '.join(functions[:4])}",
                    f"Target file: perpetual_gateway/{f}"
                ],
                'tags': tags + ['#SourceCode', f"#{f.replace('.mjs', '')}"]
            }
            cards.append(card)
            card_idx += 1

    return cards, card_idx

def generate_retriever_script(target_path: str):
    script_content = '''#!/usr/bin/env python3
"""
Standalone Grounded RAG Semantic Retriever CLI
Queries vector_index.json using normalized 256-dim dot-product cosine similarity.
"""
import os
import sys
import json
import re
import math
import zlib
from typing import List, Dict, Any, Optional

DIM = 256
STOP_WORDS = {
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'in', 'to', 'of', 'for', 
    'with', 'as', 'by', 'we', 'how', 'do', 'that', 'this', 'it', 'from', 'be', 'are', 
    'so', 'you', 'can', 'our', 'what', 'their', 'they', 'your', 'i', 'me', 'my', 'have'
}
SYNONYMS = {
    'mpesa': ['daraja', 'stk', 'payment', 'till', 'transaction', 'sms', 'reconciler', 'settle'],
    'whatsapp': ['baileys', 'gateway', 'microservice', 'bot', 'qr', 'chat', 'message', 'group', 'dm'],
    'resurrect': ['revive', 'reorder', 'repeat', 'expired', 'abandoned', 'rearm', 'cart'],
    'guardrail': ['rbac', 'unpaid', 'terminal', 'immutable', 'authority', 'filter', 'sanity'],
    'channel': ['newsletter', 'broadcast', 'updates', 'showcase', 'catalog', 'drops'],
    'missperpetual': ['cloud', 'domain', 'ddns', 'namecheap', 'tunnel']
}

def embed(text: str, dim: int = DIM) -> List[float]:
    vec = [0.0] * dim
    tokens = [t for t in re.findall(r'\\b\\w+\\b', text.lower()) if t not in STOP_WORDS and len(t) > 2]
    expanded = []
    for t in tokens:
        expanded.append(t)
        if t in SYNONYMS:
            expanded.extend(SYNONYMS[t])
    for token in expanded:
        h = zlib.crc32(token.encode('utf-8')) % dim
        vec[h] += 1.0
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec] if norm > 0 else vec

class GroundedRAGRetriever:
    def __init__(self, index_path: Optional[str] = None):
        if not index_path:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            index_path = os.path.join(base_dir, "index", "vector_index.json")
        self.index_path = index_path
        self.entries = []
        if os.path.exists(index_path):
            with open(index_path, 'r', encoding='utf-8') as f:
                self.entries = json.load(f)

    def query(self, query_str: str, top_k: int = 5, category_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        if not self.entries:
            return []
        q_vec = embed(query_str)
        results = []
        for item in self.entries:
            card = item['card']
            if category_filter and category_filter.lower() not in card.get('category', '').lower():
                continue
            v = item['vector']
            score = sum(q_vec[i] * v[i] for i in range(len(q_vec)))
            results.append((score, card))
        results.sort(key=lambda x: x[0], reverse=True)
        return [{'score': round(s, 4), 'card': c} for s, c in results[:top_k]]

def main():
    if len(sys.argv) < 2:
        print("Usage: python rag_retriever.py \\"<query text>\\" [top_k] [category_filter]")
        sys.exit(1)
    q = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    cat = sys.argv[3] if len(sys.argv) > 3 else None
    
    retriever = GroundedRAGRetriever()
    hits = retriever.query(q, top_k=top_k, category_filter=cat)
    print(f"\\n=== RAG SEARCH RESULTS FOR: '{q}' (Top {len(hits)}) ===")
    for idx, h in enumerate(hits, 1):
        c = h['card']
        print(f"\\n[{idx}] Score: {h['score']} | {c['card_id']} | Category: {c['category']}")
        print(f"    Topic: {c['topic']}")
        print(f"    Source: {c['source_file']} (Page/Step: {c.get('page_number', 'N/A')})")
        print(f"    Summary: {c['summary']}")
        print(f"    Rules: {'; '.join(c.get('grounded_rules', [])[:2])}")

if __name__ == "__main__":
    main()
'''
    with open(target_path, "w", encoding="utf-8") as f:
        f.write(script_content)

def main():
    target_base = r"D:\Savannah_Secure_Home_Server\perpetual_gateway"
    rag_dir = os.path.join(target_base, "rag_knowledge")
    cards_dir = os.path.join(rag_dir, "cards")
    index_dir = os.path.join(rag_dir, "index")
    os.makedirs(cards_dir, exist_ok=True)
    os.makedirs(index_dir, exist_ok=True)

    conv_id = "41890625-6523-4286-8f79-b0e0cb6bdfdb"
    transcript_path = os.path.join(r"C:\Users\user\.gemini\antigravity\brain", conv_id, ".system_generated", "logs", "transcript.jsonl")
    artifacts_dir = os.path.join(r"C:\Users\user\.gemini\antigravity\brain", conv_id)

    print("==================================================================")
    print(f"RAGERIZING CONVERSATION {conv_id} INTO {rag_dir}")
    print("==================================================================")

    master_cards = []
    card_counter = 1

    # 1. Process Transcript
    trans_cards, card_counter = process_transcript(transcript_path, conv_id, card_counter)
    master_cards.extend(trans_cards)

    # 2. Process Markdown Artifacts
    art_cards, card_counter = process_artifacts(artifacts_dir, card_counter)
    master_cards.extend(art_cards)

    # 3. Process Source Code
    code_cards, card_counter = process_source_code(target_base, card_counter)
    master_cards.extend(code_cards)

    print(f"\nTotal Unified Grounded Cards Extracted: {len(master_cards)}")

    # 4. Save cards_master.json
    output_cards_path = os.path.join(cards_dir, "cards_master.json")
    with open(output_cards_path, "w", encoding="utf-8") as f:
        json.dump(master_cards, f, indent=2)
    print(f"Saved master cards database: {output_cards_path}")

    # 5. Build normalized vector embeddings index
    print("Building 256-dim dense vector index...")
    vector_index = []
    for c in master_cards:
        semantic_text = f"{c.get('topic', '')} {c.get('category', '')} {c.get('summary', '')} {' '.join(c.get('key_entities', []))} {c.get('content', '')} {' '.join(c.get('tags', []))}"
        vec = embed(semantic_text)
        vector_index.append({
            'card': c,
            'vector': vec
        })

    vector_index_path = os.path.join(index_dir, "vector_index.json")
    with open(vector_index_path, "w", encoding="utf-8") as f:
        json.dump(vector_index, f, indent=2)
    print(f"Saved dense vector index: {vector_index_path}")

    # 6. Generate formatted Markdown summary table
    summary_md_path = os.path.join(cards_dir, "cards_summary.md")
    with open(summary_md_path, "w", encoding="utf-8") as f:
        f.write("# Grounded RAG Knowledge Base - Perpetual Gateway & Architecture\n\n")
        f.write(f"**Total Indexed Cards:** `{len(master_cards)}`  \n")
        f.write(f"**Generated:** `{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`  \n\n")
        f.write("| Card ID | Category | Topic | Source | Key Entities | Summary |\n")
        f.write("| :--- | :--- | :--- | :--- | :--- | :--- |\n")
        for c in master_cards:
            cid = c.get('card_id', '')
            cat = c.get('category', '')
            top = c.get('topic', '')[:45]
            src = os.path.basename(c.get('source_file', ''))
            ent = ", ".join(c.get('key_entities', [])[:3])
            sm = c.get('summary', '')[:80].replace('|', '/')
            f.write(f"| `{cid}` | {cat} | {top} | {src} | {ent} | {sm}... |\n")

    print(f"Rendered Markdown Summary Catalog: {summary_md_path}")

    # 7. Generate Standalone Retriever CLI
    retriever_path = os.path.join(rag_dir, "rag_retriever.py")
    generate_retriever_script(retriever_path)
    print(f"Generated Standalone Retriever CLI: {retriever_path}")

    # 8. Mirror to D:\Savannah_Secure_Home_Server\rag_knowledge\
    home_rag_dir = r"D:\Savannah_Secure_Home_Server\rag_knowledge"
    if os.path.exists(home_rag_dir):
        import shutil
        shutil.copytree(rag_dir, home_rag_dir, dirs_exist_ok=True)
        print(f"Mirrored knowledge base to: {home_rag_dir}")

    print("==================================================================")
    print("RAGERIZING PIPELINE COMPLETED SUCCESSFULLY!")
    print("==================================================================")

if __name__ == "__main__":
    main()

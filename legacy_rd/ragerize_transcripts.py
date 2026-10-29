#!/usr/bin/env python3
"""
RAGerizer Pipeline for Conversation Transcripts and Architectural Artifacts
Processes Antigravity Conversation Transcripts into Dense Vector Knowledge Cards
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
    'mpesa': ['daraja', 'stk', 'payment', 'till', 'transaction', 'sms', 'safari'],
    'whatsapp': ['baileys', 'gateway', 'microservice', 'bot', 'qr', 'chat', 'message'],
    'savannah': ['server', 'backend', 'node', 'pavilion', 'microservice', 'express'],
    'vxp': ['mediatek', 'mre', 'featurephone', 'villaon', 'v2160', 'rom', 'binary'],
    'storefront': ['whitelabel', 'creative', 'galore', 'catalog', 'checkout', 'orders', 'tms'],
    'tailscale': ['vpn', 'hotspot', 'tether', 'network', 'wireguard', 'ip'],
    'disputes': ['refunds', 'claims', 'desk', 'orders', 'resolution'],
    'room': ['topology', 'scene', 'assets', 'anchoring', 'sconce', 'matrix']
}

def clean_text(text: str) -> str:
    if not text:
        return ""
    # Strip Antigravity XML / metadata tags
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
    # Extract commands, URLs, IPs, filepaths, code symbols
    entities = set()
    # IPs
    ips = re.findall(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', text)
    entities.update(ips[:3])
    # Files / scripts
    files = re.findall(r'\b[\w\-\.]+\.(?:py|mjs|cjs|js|json|md|vxp|sh|yaml)\b', text)
    entities.update(files[:5])
    # URLs
    urls = re.findall(r'https?://[^\s<>"]+', text)
    entities.update([u.split('/')[2] for u in urls[:3]])
    # Keywords / components
    keywords = ['SavannahServer', 'Baileys', 'M-Pesa', 'Tailscale', 'MediaTek', 'Villaon V2160', 
                'UFW Firewall', 'Supabase', 'TMS Whitelabel', 'Creative Galore', 'Disputes Desk']
    for kw in keywords:
        if kw.lower() in text.lower():
            entities.add(kw)
    return sorted(list(entities))[:10]

def categorize_content(text: str) -> Tuple[str, List[str]]:
    tl = text.lower()
    tags = []
    if any(k in tl for k in ['tailscale', 'netplan', 'hotspot', 'tether', 'usb', 'ping', 'ufw']):
        category = "Network & Infrastructure Setup"
        tags.extend(['#Tailscale', '#Networking', '#LinuxServer', '#Infrastructure'])
    elif any(k in tl for k in ['mpesa', 'till', 'stk', 'payment', 'sms_dump', 'phone_sms']):
        category = "M-Pesa & Payment Automation"
        tags.extend(['#MPesa', '#Payments', '#STKPush', '#SMSListener'])
    elif any(k in tl for k in ['whatsapp', 'baileys', 'bot', 'qr', 'chat']):
        category = "WhatsApp Autonomous Gateway"
        tags.extend(['#WhatsApp', '#Baileys', '#Automation', '#Microservice'])
    elif any(k in tl for k in ['vxp', 'mediatek', 'mre', 'feature phone', 'villaon', 'v2160', 'rom']):
        category = "Hardware & Feature Phone Engineering"
        tags.extend(['#VXP', '#MediaTek', '#FeaturePhone', '#MRE', '#Hardware'])
    elif any(k in tl for k in ['storefront', 'catalog', 'product', 'checkout', 'creative galore', 'whitelabel']):
        category = "E-Commerce & Storefront Systems"
        tags.extend(['#Storefront', '#TMSWhitelabel', '#Ecommerce', '#Frontend'])
    elif any(k in tl for k in ['dispute', 'refund', 'claim', 'ticket']):
        category = "Disputes & Customer Resolution"
        tags.extend(['#Disputes', '#Refunds', '#OrderResolution'])
    elif any(k in tl for k in ['video', 'transcript', 'preference', 'multimodal']):
        category = "AI Preferences & Modality Selection"
        tags.extend(['#Transcripts', '#VideoModality', '#AIEngineering'])
    elif any(k in tl for k in ['room', 'sconce', 'decor', 'matrix', 'topology']):
        category = "Spatial Topology & Scene Modeling"
        tags.extend(['#SpatialTopology', '#3DScene', '#AgentRoom'])
    else:
        category = "Systems Engineering & Operations"
        tags.extend(['#Architecture', '#DevOps', '#Operations'])
    return category, list(set(tags))

def process_transcript_file(transcript_path: str, conv_id: str, start_card_idx: int) -> Tuple[List[Dict[str, Any]], int]:
    cards = []
    card_idx = start_card_idx

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

    print(f"Extracted {len(turns)} conversational exchanges from {conv_id}.")

    for turn in turns:
        user_text = turn['user']
        planner_texts = "\n\n".join(turn['planner'])
        tools_summary = ", ".join([t for t in turn['tool_calls'] if t][:4])

        combined_text = f"USER REQUEST:\n{user_text}\n\nASSISTANT EXECUTION & SUMMARY:\n{planner_texts}"
        if tools_summary:
            combined_text += f"\n\nTOOLS APPLIED:\n{tools_summary}"

        if len(combined_text) < 80:
            continue

        category, tags = categorize_content(combined_text)
        entities = extract_entities(combined_text)

        # Generate a clean topic title
        first_line = user_text.split('\n')[0].strip()
        topic = re.sub(r'^[#*\-•\s]+', '', first_line)[:90]
        if not topic:
            topic = f"{category} Interaction"

        summary = f"User: {user_text[:140].replace(chr(10), ' ')} | Result: {planner_texts[:160].replace(chr(10), ' ')}..."

        # Grounded rules / specifications extraction
        grounded_rules = []
        rule_matches = re.findall(r'(?:rule|must|note|step|error|fixed|configured|listen|port|endpoint|url):[^\.\n]+', combined_text, re.IGNORECASE)
        for rm in rule_matches[:3]:
            grounded_rules.append(rm.strip().capitalize())
        if not grounded_rules:
            grounded_rules.append(f"Recorded exchange in {conv_id} at step {turn['step']}.")

        card = {
            'card_id': f"RAG-TRANS-{card_idx:04d}",
            'category': category,
            'topic': topic,
            'source_file': f"transcript:{conv_id}",
            'page_number': turn['step'],
            'timestamp': turn['created_at'],
            'summary': summary,
            'key_entities': entities,
            'content': combined_text[:3000],
            'grounded_rules': grounded_rules,
            'tags': tags
        }
        cards.append(card)
        card_idx += 1

    return cards, card_idx

def process_artifacts(artifacts_dir: str, start_card_idx: int) -> Tuple[List[Dict[str, Any]], int]:
    cards = []
    card_idx = start_card_idx
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
                topic = lines[0].strip('#*` ') or f"{f} Part {s_idx+1}"
                category, tags = categorize_content(sec_str)
                entities = extract_entities(sec_str)

                grounded_rules = []
                rules = re.findall(r'(?:[0-9]+\.\s+|[-*]\s+)(?:[A-Z][^\.\n]+\.)', sec_str)
                for r in rules[:3]:
                    grounded_rules.append(r.strip('-*0123456789. '))

                if not grounded_rules:
                    grounded_rules.append(f"Specification derived from {f} section {s_idx+1}.")

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

def main():
    workspace = r"c:\Users\user\Documents\Perpetual"
    rag_dir = os.path.join(workspace, "rag_knowledge")
    cards_dir = os.path.join(rag_dir, "cards")
    index_dir = os.path.join(rag_dir, "index")
    os.makedirs(cards_dir, exist_ok=True)
    os.makedirs(index_dir, exist_ok=True)

    master_cards = []
    card_counter = 1

    # 1. Retain existing baseline cards if present
    existing_cards_file = os.path.join(cards_dir, "cards_master.json")
    if os.path.exists(existing_cards_file):
        try:
            with open(existing_cards_file, 'r', encoding='utf-8') as ef:
                prev_cards = json.load(ef)
                for pc in prev_cards:
                    if not pc.get('card_id', '').startswith(('RAG-TRANS-', 'RAG-SPEC-')):
                        master_cards.append(pc)
            print(f"Preserved {len(master_cards)} baseline workspace cards.")
        except Exception as e:
            print(f"Error reading previous cards: {e}")

    card_counter = len(master_cards) + 1

    # 2. Conversation 1: 41890625-6523-4286-8f79-b0e0cb6bdfdb ("Conversation Analysis And Reporting")
    c1_id = "41890625-6523-4286-8f79-b0e0cb6bdfdb"
    c1_transcript = os.path.join(r"C:\Users\user\.gemini\antigravity\brain", c1_id, ".system_generated", "logs", "transcript.jsonl")
    c1_artifacts = os.path.join(r"C:\Users\user\.gemini\antigravity\brain", c1_id)

    trans_cards_1, card_counter = process_transcript_file(c1_transcript, c1_id, card_counter)
    art_cards_1, card_counter = process_artifacts(c1_artifacts, card_counter)
    master_cards.extend(trans_cards_1)
    master_cards.extend(art_cards_1)

    # 3. Conversation 2: 4fd4d01b-aa25-451b-b58b-690a8ab4cfe4 (Current conversation)
    c2_id = "4fd4d01b-aa25-451b-b58b-690a8ab4cfe4"
    c2_transcript = os.path.join(r"C:\Users\user\.gemini\antigravity\brain", c2_id, ".system_generated", "logs", "transcript.jsonl")
    trans_cards_2, card_counter = process_transcript_file(c2_transcript, c2_id, card_counter)
    master_cards.extend(trans_cards_2)

    print(f"\nTotal Unified Cards Compiled: {len(master_cards)}")

    # 4. Save cards_master.json
    output_cards_path = os.path.join(cards_dir, "cards_master.json")
    with open(output_cards_path, "w", encoding="utf-8") as f:
        json.dump(master_cards, f, indent=2)
    print(f"Saved master cards database to: {output_cards_path}")

    # 5. Build vector index
    print("Pre-calculating normalized 256-dim vector embeddings...")
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
    print(f"Saved dense vector index to: {vector_index_path}")

    # 6. Generate formatted Markdown summary table
    summary_md_path = os.path.join(cards_dir, "cards_summary.md")
    with open(summary_md_path, "w", encoding="utf-8") as f:
        f.write("# Grounded RAG Knowledge Base - Conversation & Architecture Cards\n\n")
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
    print("RAGerizing execution finished successfully.")

if __name__ == "__main__":
    main()

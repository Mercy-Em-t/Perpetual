#!/usr/bin/env python3
"""
Packaging and Page-Count Cost Analysis for Perpetual Commerce Suite
Creates a clean ZIP archive and calculates printing costs at KES 3.00/page.
"""

import os
import sys
import json
import re
import math
import shutil
import zipfile
from datetime import datetime

CONV_ID = "41890625-6523-4286-8f79-b0e0cb6bdfdb"
BRAIN_DIR = os.path.join(r"C:\Users\user\.gemini\antigravity\brain", CONV_ID)
TRANSCRIPT_PATH = os.path.join(BRAIN_DIR, ".system_generated", "logs", "transcript.jsonl")
GATEWAY_DIR = r"D:\Savannah_Secure_Home_Server\perpetual_gateway"
EXPORT_DIR = r"D:\Savannah_Secure_Home_Server\perpetual_commerce_suite_export"
OUTPUT_ZIP = r"D:\Savannah_Secure_Home_Server\perpetual_commerce_suite_docs_and_code.zip"
ARTIFACT_ZIP = os.path.join(BRAIN_DIR, "perpetual_commerce_suite_docs_and_code.zip")

PRICE_PER_PAGE_KES = 3.00
WORDS_PER_A4_PAGE = 500   # Standard single-spaced A4 page (11pt font, 1-inch margins)
LINES_PER_A4_PAGE = 45    # Standard lines per page for code / structured tables

def clean_text(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r'<USER_REQUEST>[\s\S]*?</USER_REQUEST>', lambda m: m.group(0).replace('<USER_REQUEST>', '').replace('</USER_REQUEST>', ''), text)
    text = re.sub(r'<ADDITIONAL_METADATA>[\s\S]*?</ADDITIONAL_METADATA>', '', text)
    text = re.sub(r'<SYSTEM_MESSAGE>[\s\S]*?</SYSTEM_MESSAGE>', '', text)
    text = re.sub(r'<USER_SETTINGS_CHANGE>[\s\S]*?</USER_SETTINGS_CHANGE>', '', text)
    return text.strip()

def build_readable_transcript(transcript_in: str, md_out: str):
    print("Parsing raw transcript into clean, human-readable document...")
    turns = []
    current_turn = None

    with open(transcript_in, 'r', encoding='utf-8', errors='ignore') as f:
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

    with open(md_out, 'w', encoding='utf-8') as out:
        out.write("# Perpetual Autonomous WhatsApp Commerce Gateway\n")
        out.write("## Complete Human-Readable Conversation Transcript & Engineering Log\n")
        out.write(f"**Conversation Identifier:** `{CONV_ID}`  \n")
        out.write(f"**Total Interactive Exchanges:** `{len(turns)}` turns  \n")
        out.write(f"**Generated:** `{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`  \n\n")
        out.write("---\n\n")

        for idx, turn in enumerate(turns, 1):
            out.write(f"### Exchange #{idx:03d} (Step {turn['step']}) — {turn['created_at'][:19]}\n\n")
            out.write("#### 👤 USER REQUEST:\n")
            out.write(f"{turn['user']}\n\n")
            if turn['planner']:
                out.write("#### 🤖 AGENT EXECUTION & SOLUTION:\n")
                out.write(f"{chr(10).join(turn['planner'])}\n\n")
            if turn['tool_calls']:
                clean_tools = [t for t in turn['tool_calls'] if t][:5]
                out.write(f"**Tools Applied:** `{'` | `'.join(clean_tools)}`\n\n")
            out.write("---\n\n")

    print(f"Readable transcript compiled: {md_out} ({os.path.getsize(md_out)} bytes)")

def count_file_metrics(filepath: str):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception:
        return 0, 0, 0, 0

    lines = content.split('\n')
    line_count = len(lines)
    words = re.findall(r'\S+', content)
    word_count = len(words)
    char_count = len(content)

    # Word-based page estimate (Standard prose/docs: 500 words/page)
    pages_by_words = max(1, math.ceil(word_count / WORDS_PER_A4_PAGE))
    # Line-based page estimate (Structured code/tables: 45 lines/page)
    pages_by_lines = max(1, math.ceil(line_count / LINES_PER_A4_PAGE))

    # Balanced estimate: for code/tables, line count dominates; for prose, words dominate
    is_code = filepath.endswith(('.mjs', '.js', '.py', '.json', '.sql', '.jsonl'))
    pages = pages_by_lines if is_code else pages_by_words

    return word_count, line_count, char_count, pages

def main():
    if os.path.exists(EXPORT_DIR):
        shutil.rmtree(EXPORT_DIR)
    os.makedirs(EXPORT_DIR, exist_ok=True)

    sec_dirs = {
        '01_SAD_and_Architecture_Binders': os.path.join(EXPORT_DIR, '01_SAD_and_Architecture_Binders'),
        '02_Requirements_Engineering_SRS': os.path.join(EXPORT_DIR, '02_Requirements_Engineering_SRS'),
        '03_Operations_and_Intervention_Protocols': os.path.join(EXPORT_DIR, '03_Operations_and_Intervention_Protocols'),
        '04_Source_Code': os.path.join(EXPORT_DIR, '04_Source_Code'),
        '05_Grounded_RAG_Knowledge_Base': os.path.join(EXPORT_DIR, '05_Grounded_RAG_Knowledge_Base'),
        '06_Transcripts': os.path.join(EXPORT_DIR, '06_Transcripts'),
    }
    for d in sec_dirs.values():
        os.makedirs(d, exist_ok=True)

    # 1. Generate human-readable transcript
    readable_trans_path = os.path.join(sec_dirs['06_Transcripts'], 'conversation_transcript_readable.md')
    build_readable_transcript(TRANSCRIPT_PATH, readable_trans_path)

    # 2. Copy raw transcript
    shutil.copy2(TRANSCRIPT_PATH, os.path.join(sec_dirs['06_Transcripts'], 'raw_transcript.jsonl'))

    # 3. Categorize and copy markdown artifacts from brain
    print("Organizing architectural artifacts...")
    for f in os.listdir(BRAIN_DIR):
        if not f.endswith('.md'):
            continue
        src = os.path.join(BRAIN_DIR, f)
        fl = f.lower()
        if any(k in fl for k in ['sad', 'architecture', 'binder', 'walkthrough', 'systems_analysis']):
            dest = sec_dirs['01_SAD_and_Architecture_Binders']
        elif any(k in fl for k in ['srs', 'requirements', 'stage_', 'comparison', 'invariant']):
            dest = sec_dirs['02_Requirements_Engineering_SRS']
        elif any(k in fl for k in ['protocol', 'admin', 'manual', 'operations', 'dispute', 'audit', 'blackbox']):
            dest = sec_dirs['03_Operations_and_Intervention_Protocols']
        else:
            dest = sec_dirs['01_SAD_and_Architecture_Binders']
        shutil.copy2(src, os.path.join(dest, f))

    # 4. Copy source code files
    print("Copying gateway source code...")
    for f in os.listdir(GATEWAY_DIR):
        if f.endswith(('.mjs', '.js', '.json', '.env')):
            shutil.copy2(os.path.join(GATEWAY_DIR, f), os.path.join(sec_dirs['04_Source_Code'], f))

    # 5. Copy RAG knowledge files
    rag_cards_dir = os.path.join(GATEWAY_DIR, "rag_knowledge")
    if os.path.exists(rag_cards_dir):
        summary_file = os.path.join(rag_cards_dir, "cards", "cards_summary.md")
        master_file = os.path.join(rag_cards_dir, "cards", "cards_master.json")
        retriever_file = os.path.join(rag_cards_dir, "rag_retriever.py")
        if os.path.exists(summary_file):
            shutil.copy2(summary_file, os.path.join(sec_dirs['05_Grounded_RAG_Knowledge_Base'], 'cards_summary.md'))
        if os.path.exists(master_file):
            shutil.copy2(master_file, os.path.join(sec_dirs['05_Grounded_RAG_Knowledge_Base'], 'cards_master.json'))
        if os.path.exists(retriever_file):
            shutil.copy2(retriever_file, os.path.join(sec_dirs['05_Grounded_RAG_Knowledge_Base'], 'rag_retriever.py'))

    # 6. Build the ZIP archive
    print(f"Creating ZIP archive: {OUTPUT_ZIP}...")
    with zipfile.ZipFile(OUTPUT_ZIP, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(EXPORT_DIR):
            for file in files:
                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, EXPORT_DIR)
                zipf.write(abs_path, os.path.join("perpetual_commerce_suite", rel_path))

    zip_size_mb = os.path.getsize(OUTPUT_ZIP) / (1024 * 1024)
    print(f"ZIP Archive created: {OUTPUT_ZIP} ({zip_size_mb:.2f} MB)")

    # Copy to artifacts directory
    shutil.copy2(OUTPUT_ZIP, ARTIFACT_ZIP)
    print(f"Copied ZIP to artifacts directory: {ARTIFACT_ZIP}")

    # 7. Calculate file metrics and page counts
    print("\nCalculating page counts and print costs...")
    section_stats = {}
    detailed_table = []

    for sec_name, sec_path in sec_dirs.items():
        sec_words, sec_lines, sec_chars, sec_pages = 0, 0, 0, 0
        file_list = []
        for root, dirs, files in os.walk(sec_path):
            for file in sorted(files):
                fpath = os.path.join(root, file)
                w, l, c, p = count_file_metrics(fpath)
                sec_words += w
                sec_lines += l
                sec_chars += c
                sec_pages += p
                file_list.append({
                    'file': file,
                    'words': w,
                    'lines': l,
                    'pages': p
                })
        section_stats[sec_name] = {
            'words': sec_words,
            'lines': sec_lines,
            'chars': sec_chars,
            'pages': sec_pages,
            'files': file_list
        }

    # Print Report
    print("==================================================================")
    print("PERPETUAL COMMERCE SUITE - DETAILED PRINT PAGE & COST AUDIT")
    print("==================================================================")
    print(f"Printing Cost Rate: KES {PRICE_PER_PAGE_KES:.2f} per printed page\n")

    grand_total_pages = 0
    grand_total_words = 0

    print(f"{'Section Name':<42} | {'Files':<5} | {'Words':<9} | {'Lines':<8} | {'Est. Pages':<10} | {'Cost (KES)':<12}")
    print("-" * 96)

    for sname, sdata in section_stats.items():
        cost = sdata['pages'] * PRICE_PER_PAGE_KES
        print(f"{sname:<42} | {len(sdata['files']):<5} | {sdata['words']:<9,d} | {sdata['lines']:<8,d} | {sdata['pages']:<10,d} | KES {cost:<10,.2f}")
        grand_total_pages += sdata['pages']
        grand_total_words += sdata['words']

    print("-" * 96)
    grand_cost = grand_total_pages * PRICE_PER_PAGE_KES
    print(f"{'TOTAL ENTIRE SUITE (Including Raw JSON)':<42} | {'--':<5} | {grand_total_words:<9,d} | {'--':<8} | {grand_total_pages:<10,d} | KES {grand_cost:<10,.2f}\n")

    # Options Breakdown:
    # Option 1: Essential Engineering & Architecture Binders (Clean PDF/Print)
    opt1_pages = section_stats['01_SAD_and_Architecture_Binders']['pages'] + \
                 section_stats['02_Requirements_Engineering_SRS']['pages'] + \
                 section_stats['03_Operations_and_Intervention_Protocols']['pages']
    opt1_cost = opt1_pages * PRICE_PER_PAGE_KES

    # Option 2: Option 1 + Clean Human-Readable Transcript
    readable_trans_pages = 0
    for f in section_stats['06_Transcripts']['files']:
        if f['file'] == 'conversation_transcript_readable.md':
            readable_trans_pages = f['pages']
    opt2_pages = opt1_pages + readable_trans_pages
    opt2_cost = opt2_pages * PRICE_PER_PAGE_KES

    # Option 3: Full Project + Source Code + RAG Summary + Readable Transcript
    opt3_pages = opt1_pages + section_stats['04_Source_Code']['pages'] + \
                 section_stats['05_Grounded_RAG_Knowledge_Base']['pages'] + readable_trans_pages
    opt3_cost = opt3_pages * PRICE_PER_PAGE_KES

    # Save metrics JSON
    metrics_json_path = os.path.join(EXPORT_DIR, "printing_cost_breakdown.json")
    with open(metrics_json_path, 'w', encoding='utf-8') as mj:
        json.dump({
            'rate_per_page_kes': PRICE_PER_PAGE_KES,
            'sections': section_stats,
            'grand_total_pages': grand_total_pages,
            'grand_total_cost_kes': grand_cost,
            'options': {
                'option_1_essential_docs': {'pages': opt1_pages, 'cost_kes': opt1_cost},
                'option_2_docs_plus_readable_transcript': {'pages': opt2_pages, 'cost_kes': opt2_cost},
                'option_3_full_suite_clean': {'pages': opt3_pages, 'cost_kes': opt3_cost},
                'option_4_everything_inc_raw_json': {'pages': grand_total_pages, 'cost_kes': grand_cost}
            }
        }, mj, indent=2)

    print("=== PRINTING BUDGET RECOMMENDATIONS ===")
    print(f"1. OPTION 1: Master Architecture, SAD & SRS Binders (All 28 docs)")
    print(f"   -> Pages: {opt1_pages:,d} pages | Total Cost: KES {opt1_cost:,.2f}")
    print(f"2. OPTION 2: Architecture Binders + Clean Human-Readable Transcript")
    print(f"   -> Pages: {opt2_pages:,d} pages | Total Cost: KES {opt2_cost:,.2f}")
    print(f"3. OPTION 3: Full Clean Engineering Suite (Docs + Code + RAG + Transcript)")
    print(f"   -> Pages: {opt3_pages:,d} pages | Total Cost: KES {opt3_cost:,.2f}")
    print(f"4. OPTION 4: Everything (Including 11MB Raw JSON Logs)")
    print(f"   -> Pages: {grand_total_pages:,d} pages | Total Cost: KES {grand_cost:,.2f}")

if __name__ == "__main__":
    main()

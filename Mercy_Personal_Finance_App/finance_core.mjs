/**
 * finance_core.mjs
 * ================
 * Standalone & Dual-Synced Financial Intelligence Engine for Mercy's Personal Finance App.
 *
 * Syncs bidirectionally between:
 *   1. C:\Users\user\Documents\Mercy_Personal_Finance_App\personal_finance_ledger.json
 *   2. C:\Users\user\Documents\Perpetual\whatsapp_gateway\personal_finance_ledger.json
 *   3. C:\Users\user\Documents\Perpetual\Mercy_Personal_Finance_App\personal_finance_ledger.json
 *
 * Supports:
 *   - Multi-institution SMS parsing: MPESA, DTB, KCB, Equity, NCBA, Co-op, Safaricom, Okoa Jahazi, Fuliza
 *   - Custom transaction category overrides & notes (/api/recategorize)
 *   - Monthly category budgets with 80% / 100% alert status (/api/budgets)
 *   - Time-window & category filtering (?period=all|today|week|month&category=...)
 *   - CSV/Excel export (/api/export.csv)
 *   - Live Redmi Note 12 ADB SMS inbox sync (/api/sync-phone)
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";

export const APP_DIR = "C:\\Users\\user\\Documents\\Mercy_Personal_Finance_App";
export const MIRROR_APP_DIR = "C:\\Users\\user\\Documents\\Perpetual\\Mercy_Personal_Finance_App";
export const GATEWAY_DIR = "C:\\Users\\user\\Documents\\Perpetual\\whatsapp_gateway";

export const LEDGER_PATHS = [
  path.join(APP_DIR, "personal_finance_ledger.json"),
  path.join(GATEWAY_DIR, "personal_finance_ledger.json"),
  path.join(MIRROR_APP_DIR, "personal_finance_ledger.json")
];

export const BUDGETS_PATHS = [
  path.join(APP_DIR, "personal_finance_budgets.json"),
  path.join(GATEWAY_DIR, "personal_finance_budgets.json"),
  path.join(MIRROR_APP_DIR, "personal_finance_budgets.json")
];

export const ADB_PATH = "C:\\Users\\user\\Downloads\\scrcpy-win64-v3.3.4\\scrcpy-win64-v3.3.4\\adb.exe";

export const ALL_CATEGORIES = [
  "🛒 Groceries & Supermarkets",
  "🍽️ Food, Cafe & Dining",
  "🚕 Transport & Fuel",
  "💡 Utilities, Wi-Fi & Bills",
  "🏥 Health & Pharmacy",
  "📶 Airtime, Data & Okoa",
  "🎨 Business & Atelier Supplies",
  "🏧 Cash Withdrawals",
  "🏦 Bank Transfers (DTB)",
  "🤝 People & Family Transfers",
  "🛍️ Merchants & Till Purchases",
  "💰 Personal Income & Transfers In",
  "📌 General Expenses"
];

const DEFAULT_BUDGETS = {
  "🛒 Groceries & Supermarkets": 8000,
  "🍽️ Food, Cafe & Dining": 5000,
  "🚕 Transport & Fuel": 4500,
  "💡 Utilities, Wi-Fi & Bills": 6000,
  "📶 Airtime, Data & Okoa": 1500,
  "🤝 People & Family Transfers": 5000,
  "🏦 Bank Transfers (DTB)": 10000,
  "🛍️ Merchants & Till Purchases": 5000,
  "🎨 Business & Atelier Supplies": 10000
};

const CATEGORY_RULES = [
  { category: "🛒 Groceries & Supermarkets", pattern: /quick\s*mart|naivas|carrefour|cleanshelf|chandarana|magunas|tuskys|khetia|supermarket|mart|minimart|greenspoon|zucchini/i },
  { category: "🍽️ Food, Cafe & Dining", pattern: /java|kfc|artcaffe|cj's|cjs|glovo|uber\s*eats|bolt\s*food|restaurant|hotel|cafe|bakery|bistro|pizza|chicken|nyama|butchery|grill|eatery/i },
  { category: "🚕 Transport & Fuel", pattern: /uber|bolt|faras|little\s*cab|total\s*energies|shell|rubis|ola\s*energy|astrol|national\s*oil|sacco|matatu|bus|stage|parking|expressway|fuel|petrol/i },
  { category: "💡 Utilities, Wi-Fi & Bills", pattern: /kplc|kenya\s*power|zuku|safaricom\s*home|jtl|faiba|starlink|nairobi\s*water|water|gotv|dstv|showmax|netflix|spotify|rent|tokens/i },
  { category: "🏥 Health & Pharmacy", pattern: /goodlife|pharmacy|chemist|hospital|clinic|aga\s*khan|mater|nhif|shif|medical|lab|optica|dental/i },
  { category: "📶 Airtime, Data & Okoa", pattern: /safaricom\s*data|airtime|okoa\s*jahazi|okoa\s*chap|baze|bundle|tunukiwa|fuliza/i },
  { category: "🎨 Business & Atelier Supplies", pattern: /savannah\s*atelier|atelier|packaging|fabric|printing|stationery|hardware|Beads|Craft/i }
];

export function categorizeCounterparty(counterparty = "", rawText = "", txType = "") {
  if (txType === "DATA_BUNDLE" || txType === "OKOA_LOAN" || txType === "OKOA_USAGE" || txType === "FULIZA_LOAN") {
    return "📶 Airtime, Data & Okoa";
  }
  if (txType === "AGENT_WITHDRAWAL") {
    return "🏧 Cash Withdrawals";
  }
  const combined = `${counterparty} ${rawText}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(combined)) return rule.category;
  }
  if (txType === "BANK_TRANSFER") return "🏦 Bank Transfers (DTB)";
  if (txType === "SENT_TO_PERSON") return "🤝 People & Family Transfers";
  if (txType === "PAID_TO_MERCHANT" || txType === "PAYBILL") return "🛍️ Merchants & Till Purchases";
  if (txType === "PERSONAL_INFLOW") return "💰 Personal Income & Transfers In";
  return "📌 General Expenses";
}

/**
 * Parses an SMS from MPESA, DTB, KCB, Equity, Safaricom, Okoa Jahazi, or Fuliza into a structured financial record.
 */
export function parseFinancialSms(rawText = "", sender = "MPESA", timestampMs = Date.now(), smsId = null) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  // Extract M-Pesa / Bank / Fuliza transaction cost if present
  const feeMatch =
    text.match(/Transaction\s+cost,?\s*(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i) ||
    text.match(/The\s+fee\s+is\s+(?:Ksh\.?|KES\.?|Sh\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i) ||
    text.match(/Access\s+fee\s+charged\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i) ||
    text.match(/charges?\s+(?:of\s+)?(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const fee = feeMatch ? parseFloat(feeMatch[1].replace(/,/g, "")) : 0;

  // Extract M-Pesa balance if present
  const balMatch = text.match(/New\s+M-PESA\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const mpesaBalance = balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : null;

  const tillBalMatch = text.match(/New\s+(?:Account|Utility|Working(?:\s+Account)?)\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const tillBalance = tillBalMatch ? parseFloat(tillBalMatch[1].replace(/,/g, "")) : null;

  const okoaDebtMatch =
    text.match(/TOTAL\s+UNPAID\s+OKOA\s+JAHAZI\s+is\s+(?:Ksh\.?|KES\.?)?\s*([0-9,]+(?:\.[0-9]{2})?)/i) ||
    text.match(/Total\s+Fuliza\s+M-PESA\s+outstanding\s+amount\s+is\s+(?:Ksh\.?|KES\.?)?\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const okoaDebt = okoaDebtMatch ? parseFloat(okoaDebtMatch[1].replace(/,/g, "")) : null;

  const codeMatch = text.match(/\b([A-Z0-9]{10})\b\s*Confirmed/i);
  const isTillContext = /(?:Account|Utility|Working)\s+balance|Lipa\s+na\s+M-PESA\s+till/i.test(text);

  // 1. Business Till transaction (Till 5758419)
  if (codeMatch && isTillContext) {
    if (/received\s+from/i.test(text)) {
      const amtMatch = text.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+received\s+from/i);
      const partyMatch = text.match(/received\s+from\s+(?:(\+?\d{9,13})\s+)?([A-Z\s.'-]+?)(?:\.\s+New|\.\s+Account|$)/i);
      return {
        is_business_till: true,
        ref_code: codeMatch[1].toUpperCase(),
        direction: "TILL_INFLOW",
        tx_type: "TILL_RECEIPT",
        amount: amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : 0,
        fee,
        counterparty: partyMatch?.[2]?.trim() || "Customer",
        phone: partyMatch?.[1]?.trim() || null,
        category: "🏪 Business Till Inflow",
        till_balance: tillBalance,
        timestamp: new Date(timestampMs).toISOString(),
        raw_sms: text,
        sms_id: smsId
      };
    }

    if (/(?:sent\s+to|paid\s+to|withdrawn|Withdraw|transferred)/i.test(text)) {
      const amtMatch =
        text.match(/(?:Withdraw\s+)?(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+(?:sent\s+to|paid\s+to|withdrawn|from|transferred)/i) ||
        text.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
      const destMatch = text.match(/(?:sent\s+to|paid\s+to|from|transferred\s+to)\s+(.+?)(?:\s+on\s+\d|\.\s*on\s+|\.\s*New|\s+New\s+|$)/i);
      const rawDest = destMatch?.[1]?.trim() || "Till Withdrawal / Rollup";
      const phoneInDest = rawDest.match(/\b(\+?\d{9,13})\b/);
      return {
        is_business_till: true,
        ref_code: codeMatch[1].toUpperCase(),
        direction: "TILL_OUTFLOW",
        tx_type: "TILL_WITHDRAWAL",
        amount: amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : 0,
        fee,
        counterparty: rawDest.replace(/\b\+?\d{9,13}\b/, "").trim() || rawDest,
        phone: phoneInDest ? phoneInDest[1] : null,
        category: "📤 Business Till Outflow / Withdrawal",
        till_balance: tillBalance,
        timestamp: new Date(timestampMs).toISOString(),
        raw_sms: text,
        sms_id: smsId
      };
    }
  }

  // 2. M-Pesa Outgoing Buy Goods ("paid to <MERCHANT>.")
  if (codeMatch && /paid\s+to\s+/i.test(text)) {
    const code = codeMatch[1].toUpperCase();
    const amtMatch = text.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+paid\s+to/i);
    const merchMatch = text.match(/paid\s+to\s+(.+?)\.\s*on\s+/i) || text.match(/paid\s+to\s+(.+?)\./i);
    const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : 0;
    const counterparty = merchMatch ? merchMatch[1].trim() : "Merchant";
    return {
      is_business_till: false,
      ref_code: code,
      direction: "OUTFLOW",
      tx_type: "PAID_TO_MERCHANT",
      amount,
      fee,
      counterparty,
      category: categorizeCounterparty(counterparty, text, "PAID_TO_MERCHANT"),
      mpesa_balance: mpesaBalance,
      timestamp: new Date(timestampMs).toISOString(),
      raw_sms: text,
      sms_id: smsId
    };
  }

  // 3. M-Pesa Sent to Person or Paybill ("sent to <NAME/PAYBILL>")
  if (codeMatch && /sent\s+to\s+/i.test(text)) {
    const code = codeMatch[1].toUpperCase();
    const amtMatch = text.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+sent\s+to/i);
    const isPaybill = /for\s+account\s+/i.test(text);
    const recMatch = isPaybill
      ? text.match(/sent\s+to\s+(.+?)\s+for\s+account\s+(.+?)\s+on\s+/i)
      : text.match(/sent\s+to\s+(.+?)\s+on\s+\d/i);
    const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : 0;
    const counterparty = recMatch
      ? (isPaybill ? `${recMatch[1].trim()} (Acct: ${recMatch[2].trim()})` : recMatch[1].replace(/\s+\d{9,13}$/, "").trim())
      : "Recipient";
    const txType = isPaybill ? "PAYBILL" : "SENT_TO_PERSON";
    return {
      is_business_till: false,
      ref_code: code,
      direction: "OUTFLOW",
      tx_type: txType,
      amount,
      fee,
      counterparty,
      category: categorizeCounterparty(counterparty, text, txType),
      mpesa_balance: mpesaBalance,
      timestamp: new Date(timestampMs).toISOString(),
      raw_sms: text,
      sms_id: smsId
    };
  }

  // 4. M-Pesa Agent Withdrawal ("Withdraw Ksh... from ...")
  if (codeMatch && /Withdraw\s+(?:Ksh\.?|KES\.?)/i.test(text)) {
    const code = codeMatch[1].toUpperCase();
    const amtMatch = text.match(/Withdraw\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+from\s+(.+?)\s+New\s+M-PESA/i);
    const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : 0;
    const counterparty = amtMatch?.[2]?.trim() || "M-Pesa Agent";
    return {
      is_business_till: false,
      ref_code: code,
      direction: "OUTFLOW",
      tx_type: "AGENT_WITHDRAWAL",
      amount,
      fee,
      counterparty,
      category: "🏧 Cash Withdrawals",
      mpesa_balance: mpesaBalance,
      timestamp: new Date(timestampMs).toISOString(),
      raw_sms: text,
      sms_id: smsId
    };
  }

  // 5. Personal M-Pesa Received ("You have received Ksh... from ...")
  if (codeMatch && /You\s+have\s+received\s+(?:Ksh\.?|KES\.?)/i.test(text)) {
    const code = codeMatch[1].toUpperCase();
    const amtMatch = text.match(/You\s+have\s+received\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+from\s+(.+?)\s+on\s+\d/i);
    const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : 0;
    const counterparty = amtMatch ? amtMatch[2].replace(/\s+\d{9,13}$/, "").trim() : "Sender";
    return {
      is_business_till: false,
      ref_code: code,
      direction: "INFLOW",
      tx_type: "PERSONAL_INFLOW",
      amount,
      fee: 0,
      counterparty,
      category: "💰 Personal Income & Transfers In",
      mpesa_balance: mpesaBalance,
      timestamp: new Date(timestampMs).toISOString(),
      raw_sms: text,
      sms_id: smsId
    };
  }

  // 6. Bank Transfer (DTB / KCB / Equity / NCBA)
  if (/successfully\s+transferred\s+(?:KES|Ksh)\s*([0-9,]+(?:\.[0-9]{2})?)\s+to\s+/i.test(text) || /transferred\s+(?:KES|Ksh)\.?\s*([0-9,]+(?:\.[0-9]{2})?)\s+to\s+/i.test(text)) {
    const m =
      text.match(/successfully\s+transferred\s+(?:KES|Ksh)\s*([0-9,]+(?:\.[0-9]{2})?)\s+to\s+(.+?)\.\s*M-PESA\s+Ref:\s*([A-Z0-9]+)/i) ||
      text.match(/transferred\s+(?:KES|Ksh)\.?\s*([0-9,]+(?:\.[0-9]{2})?)\s+to\s+(.+?)(?:\.\s*(?:Ref|M-PESA\s+Ref)[:\s]*([A-Z0-9]+)|$)/i);
    if (m) {
      const amount = parseFloat(m[1].replace(/,/g, ""));
      const counterparty = m[2].replace(/\s+\d{9,13}$/, "").trim().toUpperCase();
      const refCode = (m[3] || `BANK-${smsId || timestampMs}`).toUpperCase();
      const bankLabel = /KCB/i.test(text) ? "KCB" : (/EQUITY/i.test(text) ? "Equity" : "DTB");
      return {
        is_business_till: false,
        ref_code: refCode,
        direction: "OUTFLOW",
        tx_type: "BANK_TRANSFER",
        amount,
        fee,
        counterparty: `${counterparty} (via ${bankLabel})`,
        category: categorizeCounterparty(counterparty, text, "BANK_TRANSFER"),
        timestamp: new Date(timestampMs).toISOString(),
        raw_sms: text,
        sms_id: smsId
      };
    }
  }

  // 7. Safaricom Data Bundle / Airtime Purchase ("You have purchased Sh20 (1GB valid 1Hr)")
  if (/You\s+have\s+purchased\s+(?:Sh|Ksh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)\s*\(([^)]+)\)/i.test(text)) {
    const m = text.match(/You\s+have\s+purchased\s+(?:Sh|Ksh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)\s*\(([^)]+)\)/i);
    const amount = parseFloat(m[1].replace(/,/g, ""));
    const bundleDesc = m[2].trim();
    return {
      is_business_till: false,
      ref_code: `DATA-${smsId || timestampMs}`,
      direction: "OUTFLOW",
      tx_type: "DATA_BUNDLE",
      amount,
      fee: 0,
      counterparty: `Safaricom Data (${bundleDesc})`,
      category: "📶 Airtime, Data & Okoa",
      timestamp: new Date(timestampMs).toISOString(),
      raw_sms: text,
      sms_id: smsId
    };
  }

  // 8. Okoa Jahazi Loan / Chap Chap Call Cost / Fuliza M-PESA
  if (/TOTAL\s+UNPAID\s+OKOA\s+JAHAZI/i.test(text) || /Okoa\s+Chap\s+Chap\s+request\s+was\s+successful/i.test(text) || /Fuliza\s+M-PESA\s+amount\s+is/i.test(text)) {
    const chapMatch = text.match(/call\s+costs\s+through\s+OKOA\s+was\s+(?:Ksh|Sh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
    const loanMatch = text.match(/You\s+have\s+received\s+(?:Ksh|Sh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)\.\s*The\s+fee\s+is\s+(?:Ksh|Sh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
    const fulizaMatch = text.match(/Fuliza\s+M-PESA\s+amount\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\.\s*Access\s+fee\s+charged\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);

    if (chapMatch) {
      const amount = parseFloat(chapMatch[1].replace(/,/g, ""));
      return {
        is_business_till: false,
        ref_code: `OKOA-CALL-${smsId || timestampMs}`,
        direction: "OUTFLOW",
        tx_type: "OKOA_USAGE",
        amount,
        fee: 0,
        counterparty: "Safaricom Okoa Chap Chap Call",
        category: "📶 Airtime, Data & Okoa",
        okoa_debt: okoaDebt,
        timestamp: new Date(timestampMs).toISOString(),
        raw_sms: text,
        sms_id: smsId
      };
    }
    if (loanMatch) {
      const principal = parseFloat(loanMatch[1].replace(/,/g, ""));
      const loanFee = parseFloat(loanMatch[2].replace(/,/g, ""));
      return {
        is_business_till: false,
        ref_code: `OKOA-LOAN-${smsId || timestampMs}`,
        direction: "LOAN_ADVANCE",
        tx_type: "OKOA_LOAN",
        amount: principal,
        fee: loanFee,
        counterparty: `Okoa Jahazi Advance (+Fee KES ${loanFee})`,
        category: "📶 Airtime, Data & Okoa",
        okoa_debt: okoaDebt,
        timestamp: new Date(timestampMs).toISOString(),
        raw_sms: text,
        sms_id: smsId
      };
    }
    if (fulizaMatch) {
      const principal = parseFloat(fulizaMatch[1].replace(/,/g, ""));
      const fulizaFee = parseFloat(fulizaMatch[2].replace(/,/g, ""));
      return {
        is_business_till: false,
        ref_code: codeMatch ? `${codeMatch[1].toUpperCase()}-FULIZA` : `FULIZA-${smsId || timestampMs}`,
        direction: "LOAN_ADVANCE",
        tx_type: "FULIZA_LOAN",
        amount: principal,
        fee: fulizaFee,
        counterparty: `Fuliza M-Pesa Overdraft (+Fee KES ${fulizaFee})`,
        category: "📶 Airtime, Data & Okoa",
        okoa_debt: okoaDebt,
        timestamp: new Date(timestampMs).toISOString(),
        raw_sms: text,
        sms_id: smsId
      };
    }
  }

  return null;
}

/**
 * Loads and merges transactions across both the WhatsApp Gateway ledger and the Standalone App ledger
 * so neither ever loses data and both stay 100% synchronized.
 */
export function loadPersonalLedger() {
  const byKey = new Map();

  for (const p of LEDGER_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const arr = JSON.parse(fs.readFileSync(p, "utf-8") || "[]");
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (!item || item.is_business_till) continue;
            const key = item.ref_code || (item.sms_id ? `SMS-${item.sms_id}` : `${item.timestamp}-${item.amount}`);
            const existing = byKey.get(key);
            if (!existing) {
              byKey.set(key, item);
            } else {
              // Preserve custom category override or notes if updated on either side
              if (item.user_modified && !existing.user_modified) {
                byKey.set(key, item);
              } else if (item.note && !existing.note) {
                existing.note = item.note;
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  const merged = Array.from(byKey.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Ensure all ledger copies are synced on disk
  writeSyncedLedgers(merged);
  return merged;
}

export function writeSyncedLedgers(ledger) {
  const serialized = JSON.stringify(ledger.slice(0, 2500), null, 2);
  for (const p of LEDGER_PATHS) {
    try {
      const dir = path.dirname(p);
      if (fs.existsSync(dir)) {
        fs.writeFileSync(p, serialized, "utf-8");
      }
    } catch (_) {}
  }
}

export function savePersonalTransaction(entry) {
  if (!entry || entry.is_business_till) return { saved: false, reason: "Not a personal transaction" };
  const ledger = loadPersonalLedger();
  const exists = ledger.find(
    (x) => (entry.ref_code && x.ref_code === entry.ref_code) || (entry.sms_id && x.sms_id === entry.sms_id)
  );
  if (exists) return { saved: false, duplicate: true, entry: exists };
  ledger.unshift(entry);
  ledger.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  writeSyncedLedgers(ledger);
  return { saved: true, entry };
}

export function recategorizeTransaction({ ref_code, sms_id, category, note }) {
  const ledger = loadPersonalLedger();
  let updated = null;
  for (const tx of ledger) {
    const matchRef = ref_code && tx.ref_code === ref_code;
    const matchSms = sms_id !== undefined && sms_id !== null && String(tx.sms_id) === String(sms_id);
    if (matchRef || matchSms) {
      if (category && category.trim()) {
        tx.category = category.trim();
        tx.user_modified = true;
      }
      if (note !== undefined) {
        tx.note = String(note || "").trim();
        tx.user_modified = true;
      }
      updated = tx;
      break;
    }
  }
  if (!updated) return { success: false, error: "Transaction not found" };
  writeSyncedLedgers(ledger);
  return { success: true, transaction: updated };
}

export function loadBudgets() {
  for (const p of BUDGETS_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8") || "{}");
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
          return { ...DEFAULT_BUDGETS, ...parsed };
        }
      }
    } catch (_) {}
  }
  saveBudgets(DEFAULT_BUDGETS);
  return { ...DEFAULT_BUDGETS };
}

export function saveBudgets(newBudgets = {}) {
  let current = {};
  for (const p of BUDGETS_PATHS) {
    try {
      if (fs.existsSync(p)) {
        current = JSON.parse(fs.readFileSync(p, "utf-8") || "{}");
        break;
      }
    } catch (_) {}
  }
  const merged = { ...DEFAULT_BUDGETS, ...current };
  for (const [k, v] of Object.entries(newBudgets)) {
    const num = Number(v);
    if (!Number.isNaN(num) && num >= 0) {
      merged[k] = num;
    }
  }
  const serialized = JSON.stringify(merged, null, 2);
  for (const p of BUDGETS_PATHS) {
    try {
      const dir = path.dirname(p);
      if (fs.existsSync(dir)) {
        fs.writeFileSync(p, serialized, "utf-8");
      }
    } catch (_) {}
  }
  return merged;
}

export function filterTransactionsByPeriod(ledger, period = "all", categoryFilter = "") {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  return ledger.filter((tx) => {
    if (categoryFilter && categoryFilter !== "all" && tx.category !== categoryFilter) {
      return false;
    }
    if (!period || period === "all") return true;
    const ts = new Date(tx.timestamp).getTime();
    if (period === "today") return ts >= startOfToday;
    if (period === "week") return ts >= startOfWeek;
    if (period === "month") return ts >= startOfMonth;
    return true;
  });
}

export function computeFinancialReport({ period = "all", category = "" } = {}) {
  const fullLedger = loadPersonalLedger();
  const budgets = loadBudgets();
  const filteredLedger = filterTransactionsByPeriod(fullLedger, period, category);

  // Also calculate current month's spending per category for accurate monthly budget alerts
  const monthLedger = filterTransactionsByPeriod(fullLedger, "month", "");
  const monthlySpentByCat = {};
  for (const tx of monthLedger) {
    if (tx.direction === "OUTFLOW") {
      const cat = tx.category || "📌 General Expenses";
      monthlySpentByCat[cat] = (monthlySpentByCat[cat] || 0) + (tx.amount || 0);
    }
  }

  let totalSpent = 0;
  let totalInflow = 0;
  let totalFees = 0;
  let latestMpesaBalance = null;
  let latestOkoaDebt = null;

  // Latest balances always come from the most recent chronological entry in the full ledger
  for (const tx of fullLedger) {
    if (latestMpesaBalance === null && typeof tx.mpesa_balance === "number") {
      latestMpesaBalance = tx.mpesa_balance;
    }
    if (latestOkoaDebt === null && typeof tx.okoa_debt === "number") {
      latestOkoaDebt = tx.okoa_debt;
    }
  }

  const byCategory = {};
  const byCounterparty = {};

  for (const tx of filteredLedger) {
    if (typeof tx.fee === "number" && tx.fee > 0) {
      totalFees += tx.fee;
    }
    if (tx.direction === "OUTFLOW") {
      totalSpent += tx.amount || 0;
      const cat = tx.category || "📌 General Expenses";
      byCategory[cat] = (byCategory[cat] || 0) + (tx.amount || 0);
      const cp = tx.counterparty || "Unknown";
      byCounterparty[cp] = (byCounterparty[cp] || 0) + (tx.amount || 0);
    } else if (tx.direction === "INFLOW") {
      totalInflow += tx.amount || 0;
    }
  }

  const categoryBreakdown = Object.entries(byCategory)
    .map(([cat, amount]) => {
      const budgetLimit = budgets[cat] || 0;
      const budgetUsedPct = budgetLimit > 0 ? Math.round((amount / budgetLimit) * 1000) / 10 : 0;
      const budgetStatus =
        budgetLimit <= 0
          ? "NO_BUDGET"
          : budgetUsedPct >= 100
          ? "OVER_BUDGET"
          : budgetUsedPct >= 80
          ? "NEAR_LIMIT"
          : "OK";
      return {
        category: cat,
        amount: Math.round(amount * 100) / 100,
        share_pct: totalSpent > 0 ? Math.round((amount / totalSpent) * 1000) / 10 : 0,
        budget_limit: budgetLimit,
        budget_used_pct: budgetUsedPct,
        budget_status: budgetStatus
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const budgetAlerts = Object.entries(budgets)
    .map(([cat, limit]) => {
      const spentMonth = Math.round((monthlySpentByCat[cat] || 0) * 100) / 100;
      const pct = limit > 0 ? Math.round((spentMonth / limit) * 1000) / 10 : 0;
      const status = limit <= 0 ? "NONE" : pct >= 100 ? "OVER_100" : pct >= 80 ? "WARNING_80" : "HEALTHY";
      return {
        category: cat,
        monthly_limit: limit,
        spent_this_month: spentMonth,
        remaining: Math.max(0, Math.round((limit - spentMonth) * 100) / 100),
        used_pct: pct,
        status
      };
    })
    .sort((a, b) => b.used_pct - a.used_pct);

  const topPayees = Object.entries(byCounterparty)
    .map(([counterparty, amount]) => ({
      counterparty,
      amount: Math.round(amount * 100) / 100
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 12);

  return {
    period,
    category_filter: category || "all",
    total_transactions: filteredLedger.length,
    all_time_transactions: fullLedger.length,
    total_spent: Math.round(totalSpent * 100) / 100,
    total_inflow: Math.round(totalInflow * 100) / 100,
    net_cashflow: Math.round((totalInflow - totalSpent - totalFees) * 100) / 100,
    total_fees_and_okoa_interest: Math.round(totalFees * 100) / 100,
    latest_mpesa_balance: latestMpesaBalance,
    latest_okoa_debt: latestOkoaDebt,
    available_categories: ALL_CATEGORIES,
    budgets,
    budget_alerts: budgetAlerts,
    category_breakdown: categoryBreakdown,
    top_payees: topPayees,
    transactions: filteredLedger
  };
}

export function generateCsvExport(period = "all", category = "") {
  const fullLedger = loadPersonalLedger();
  const rows = filterTransactionsByPeriod(fullLedger, period, category);
  const headers = [
    "Timestamp",
    "Ref Code",
    "Direction",
    "Type",
    "Category",
    "Counterparty",
    "Amount (KES)",
    "Fee / Okoa Charge (KES)",
    "M-Pesa Balance (KES)",
    "Okoa Debt (KES)",
    "Note",
    "Raw SMS"
  ];

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return "";
    const str = String(val).replace(/"/g, '""');
    return /[",\r\n]/.test(str) ? `"${str}"` : str;
  };

  const lines = [headers.join(",")];
  for (const tx of rows) {
    lines.push(
      [
        tx.timestamp,
        tx.ref_code,
        tx.direction,
        tx.tx_type,
        tx.category,
        tx.counterparty,
        tx.amount,
        tx.fee || 0,
        tx.mpesa_balance ?? "",
        tx.okoa_debt ?? "",
        tx.note || "",
        tx.raw_sms || ""
      ]
        .map(escapeCsv)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

/**
 * Connects to Redmi Note 12 via ADB (USB or Wireless) and imports the latest financial SMS messages.
 */
export function syncFromRedmiPhone(limit = 150) {
  return new Promise((resolve) => {
    if (!fs.existsSync(ADB_PATH)) {
      return resolve({
        success: false,
        connected: false,
        message: "ADB executable not found at configured path.",
        imported_count: 0,
        scanned_count: 0
      });
    }

    execFile(
      ADB_PATH,
      ["shell", `content query --uri content://sms/inbox --projection _id:address:date:body --sort 'date DESC' | head -n ${limit}`],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err || !stdout || !stdout.includes("Row: ")) {
          return resolve({
            success: false,
            connected: false,
            message: "Redmi Note 12 not currently reachable over ADB (USB/Wi-Fi). Using local synced ledger.",
            details: (stderr || err?.message || "").trim(),
            imported_count: 0,
            scanned_count: 0
          });
        }

        const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith("Row: "));
        let importedCount = 0;
        let duplicatesCount = 0;

        for (const line of lines) {
          const idMatch = line.match(/_id=(\d+)/);
          const addrMatch = line.match(/address=([^,]+),/);
          const dateMatch = line.match(/date=(\d+),/);
          const bodyMatch = line.match(/body=(.+)$/);
          if (idMatch && addrMatch && bodyMatch) {
            const id = parseInt(idMatch[1], 10);
            const address = addrMatch[1].trim();
            const date = dateMatch ? parseInt(dateMatch[1], 10) : Date.now();
            const body = bodyMatch[1].trim();

            const parsed = parseFinancialSms(body, address, date, id);
            if (parsed && !parsed.is_business_till) {
              const res = savePersonalTransaction(parsed);
              if (res.saved) importedCount++;
              else if (res.duplicate) duplicatesCount++;
            }
          }
        }

        resolve({
          success: true,
          connected: true,
          message: `Synced with Redmi Note 12! Scanned ${lines.length} SMS, imported ${importedCount} new financial records (${duplicatesCount} already in ledger).`,
          scanned_count: lines.length,
          imported_count: importedCount,
          duplicates_count: duplicatesCount
        });
      }
    );
  });
}

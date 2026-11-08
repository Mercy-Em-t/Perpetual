/**
 * finance_engine.mjs
 * ==================
 * Personal & Business M-Pesa / Bank / Okoa Jahazi Financial Intelligence Engine.
 * Automatically classifies incoming SMS messages into:
 *   1. BUSINESS_TILL_INFLOW (Till 5758419 customer payments)
 *   2. PERSONAL_FINANCE (Outgoing M-Pesa Buy Goods, Paybill, Send Money, Withdrawals,
 *      Personal Inflows, DTB Bank Transfers, Safaricom Bundles, Okoa Jahazi & Fuliza)
 */
import fs from "fs";
import path from "path";

const LEDGER_PATH = path.resolve(process.cwd(), "personal_finance_ledger.json");
const STANDALONE_LEDGER_PATHS = [
  "C:\\Users\\user\\Documents\\Mercy_Personal_Finance_App\\personal_finance_ledger.json",
  "C:\\Users\\user\\Documents\\Perpetual\\Mercy_Personal_Finance_App\\personal_finance_ledger.json"
];

const CATEGORY_RULES = [
  { category: "🛒 Groceries & Supermarkets", pattern: /quick\s*mart|naivas|carrefour|cleanshelf|chandarana|magunas|tuskys|khetia|supermarket|mart|minimart/i },
  { category: "🍽️ Food, Cafe & Dining", pattern: /java|kfc|artcaffe|cj's|cjs|glovo|uber\s*eats|bolt\s*food|restaurant|hotel|cafe|bakery|bistro|pizza|chicken|nyama|butchery/i },
  { category: "🚕 Transport & Fuel", pattern: /uber|bolt|faras|little\s*cab|total\s*energies|shell|rubis|ola\s*energy|astrol|national\s*oil|sacco|matatu|bus|stage|parking/i },
  { category: "💡 Utilities, Wi-Fi & Bills", pattern: /kplc|kenya\s*power|zuku|safaricom\s*home|jtl|faiba|starlink|nairobi\s*water|water|gotv|dstv|showmax|netflix|spotify|rent/i },
  { category: "🏥 Health & Pharmacy", pattern: /goodlife|pharmacy|chemist|hospital|clinic|aga\s*khan|mater|nhif|shif|medical|lab|optica/i },
  { category: "📶 Airtime, Data & Okoa", pattern: /safaricom\s*data|airtime|okoa\s*jahazi|okoa\s*chap|baze|bundle/i },
  { category: "🎨 Business & Atelier Supplies", pattern: /savannah\s*atelier|atelier|packaging|fabric|printing|stationery|hardware/i }
];

export function categorizeCounterparty(counterparty = "", rawText = "", txType = "") {
  if (txType === "DATA_BUNDLE" || txType === "OKOA_LOAN" || txType === "OKOA_USAGE") {
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
 * Parses an SMS from MPESA, DTB, Safaricom, or Okoa Jahazi into a structured financial record.
 */
export function parseFinancialSms(rawText = "", sender = "MPESA", timestampMs = Date.now(), smsId = null) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  // Extract M-Pesa transaction cost if present
  const feeMatch = text.match(/Transaction\s+cost,?\s*(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i) ||
                   text.match(/The\s+fee\s+is\s+(?:Ksh\.?|KES\.?|Sh\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i) ||
                   text.match(/Access\s+fee\s+charged\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const fee = feeMatch ? parseFloat(feeMatch[1].replace(/,/g, "")) : 0;

  // Extract M-Pesa balance if present
  const balMatch = text.match(/New\s+M-PESA\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const mpesaBalance = balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : null;

  const tillBalMatch = text.match(/New\s+(?:Account|Utility|Working(?:\s+Account)?)\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const tillBalance = tillBalMatch ? parseFloat(tillBalMatch[1].replace(/,/g, "")) : null;

  const okoaDebtMatch = text.match(/TOTAL\s+UNPAID\s+OKOA\s+JAHAZI\s+is\s+(?:Ksh\.?|KES\.?)?\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  const okoaDebt = okoaDebtMatch ? parseFloat(okoaDebtMatch[1].replace(/,/g, "")) : null;

  // 1. Check if this is a BUSINESS TILL transaction (Inflow OR Outflow/Withdrawal/Rollup on Till 5758419)
  const codeMatch = text.match(/\b([A-Z0-9]{10})\b\s*Confirmed/i);
  const isTillContext = /(?:Account|Utility|Working)\s+balance|Lipa\s+na\s+M-PESA\s+till/i.test(text);
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

    // Business Till Outflow (Money sent out / withdrawn / rolled up from the Till via *234#)
    if (/(?:sent\s+to|paid\s+to|withdrawn|Withdraw|transferred)/i.test(text)) {
      const amtMatch = text.match(/(?:Withdraw\s+)?(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+(?:sent\s+to|paid\s+to|withdrawn|from|transferred)/i) ||
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

  // 6. DTB Bank Transfer ("Dear ..., you have successfully transferred KES 500.00 to ian ambuko bulali ... M-PESA Ref: UK5HC0TLV7")
  if (/successfully\s+transferred\s+(?:KES|Ksh)\s*([0-9,]+(?:\.[0-9]{2})?)\s+to\s+/i.test(text)) {
    const m = text.match(/successfully\s+transferred\s+(?:KES|Ksh)\s*([0-9,]+(?:\.[0-9]{2})?)\s+to\s+(.+?)\.\s*M-PESA\s+Ref:\s*([A-Z0-9]+)/i);
    if (m) {
      const amount = parseFloat(m[1].replace(/,/g, ""));
      const counterparty = m[2].replace(/\s+\d{9,13}$/, "").trim().toUpperCase();
      const refCode = m[3].toUpperCase();
      return {
        is_business_till: false,
        ref_code: refCode,
        direction: "OUTFLOW",
        tx_type: "BANK_TRANSFER",
        amount,
        fee,
        counterparty: `${counterparty} (via DTB)`,
        category: categorizeCounterparty(counterparty, text, "BANK_TRANSFER"),
        timestamp: new Date(timestampMs).toISOString(),
        raw_sms: text,
        sms_id: smsId
      };
    }
  }

  // 7. Safaricom Data Bundle Purchase ("You have purchased Sh20 (1GB valid 1Hr)")
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

  // 8. Okoa Jahazi Loan / Chap Chap Call Cost
  if (/TOTAL\s+UNPAID\s+OKOA\s+JAHAZI/i.test(text) || /Okoa\s+Chap\s+Chap\s+request\s+was\s+successful/i.test(text)) {
    const chapMatch = text.match(/call\s+costs\s+through\s+OKOA\s+was\s+(?:Ksh|Sh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
    const loanMatch = text.match(/You\s+have\s+received\s+(?:Ksh|Sh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)\.\s*The\s+fee\s+is\s+(?:Ksh|Sh|KES)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
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
  }

  return null;
}

export function loadPersonalLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8") || "[]");
    }
  } catch (_) {}
  return [];
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
  const serialized = JSON.stringify(ledger.slice(0, 2000), null, 2);
  fs.writeFileSync(LEDGER_PATH, serialized, "utf-8");
  for (const sp of STANDALONE_LEDGER_PATHS) {
    try {
      if (fs.existsSync(path.dirname(sp))) {
        fs.writeFileSync(sp, serialized, "utf-8");
      }
    } catch (_) {}
  }
  return { saved: true, entry };
}

export function computeFinancialReport() {
  const ledger = loadPersonalLedger();
  let totalSpent = 0;
  let totalInflow = 0;
  let totalFees = 0;
  let latestMpesaBalance = null;
  let latestOkoaDebt = null;

  const byCategory = {};
  const byCounterparty = {};

  for (const tx of ledger) {
    if (latestMpesaBalance === null && typeof tx.mpesa_balance === "number") {
      latestMpesaBalance = tx.mpesa_balance;
    }
    if (latestOkoaDebt === null && typeof tx.okoa_debt === "number") {
      latestOkoaDebt = tx.okoa_debt;
    }
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
    .map(([category, amount]) => ({
      category,
      amount: Math.round(amount * 100) / 100,
      share_pct: totalSpent > 0 ? Math.round((amount / totalSpent) * 1000) / 10 : 0
    }))
    .sort((a, b) => b.amount - a.amount);

  const topPayees = Object.entries(byCounterparty)
    .map(([counterparty, amount]) => ({
      counterparty,
      amount: Math.round(amount * 100) / 100
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  return {
    total_transactions: ledger.length,
    total_spent: Math.round(totalSpent * 100) / 100,
    total_inflow: Math.round(totalInflow * 100) / 100,
    total_fees_and_okoa_interest: Math.round(totalFees * 100) / 100,
    latest_mpesa_balance: latestMpesaBalance,
    latest_okoa_debt: latestOkoaDebt,
    category_breakdown: categoryBreakdown,
    top_payees: topPayees,
    transactions: ledger
  };
}

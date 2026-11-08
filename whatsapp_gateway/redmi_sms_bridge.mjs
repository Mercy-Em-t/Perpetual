/**
 * redmi_sms_bridge.mjs
 * ====================
 * Autonomous Dual-Mode M-Pesa Till & Personal Financial Reporter Bridge
 * for Redmi Note 12 (94b0fd4c / Wireless ADB).
 *
 * 1. Routes Business Till 5758419 receipts ("received from ... Account/Utility balance")
 *    -> POST /api/till/receipt (auto-settles Supabase orders & alerts WhatsApp Ops).
 * 2. Routes Personal Financial SMS (MPESA paid/sent/withdrawn, DTB Bank, Safaricom Data,
 *    Okoa Jahazi) -> POST /api/finance/ingest (builds private Personal Financial Report).
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { parseFinancialSms, savePersonalTransaction } from "./finance_engine.mjs";

const ADB_PATH = "C:\\Users\\user\\Downloads\\scrcpy-win64-v3.3.4\\scrcpy-win64-v3.3.4\\adb.exe";
const TILL_WEBHOOK_URL = "http://127.0.0.1:5174/api/till/receipt";
const STATE_FILE = path.resolve(process.cwd(), "redmi_last_sms_id.json");

// Seed initial historical messages discovered on Redmi Note 12 so the report is populated immediately
const INITIAL_SEED_MESSAGES = [
  { id: 28452, sender: "MPESA", ts: 1793972158451, body: "UK6DC1DCIM Confirmed. Ksh1.00 paid to SAVANNAH ATELIER. on 6/11/26 at 4:35 PM.New M-PESA balance is Ksh66.65. Transaction cost, Ksh0.00. Amount you can transact within the day is 499,999.00. See all your balances now https://saf.cx/kWQpy" },
  { id: 28449, sender: "DTB", ts: 1793901955743, body: "Dear Mercy emurugat, you have successfully transferred KES 500.00 to  ian ambuko bulali 254712812250. M-PESA Ref: UK5HC0TLV7. Ref No: 518279111. DTB." },
  { id: 28447, sender: "Safaricom", ts: 1793901740063, body: "You have received Sh9.00. The fee is Sh1. Your debt of Sh10 should be paid by 2026-11-10. TOTAL UNPAID OKOA JAHAZI is 53.72. You can now Okoa Minutes to Call MORE for LESS. Just select Okoa minutes. Dial *131# to check your okoa limit." },
  { id: 28446, sender: "Okoa Jahazi", ts: 1793898944755, body: "Your Okoa Chap Chap request was successful. Your call costs through OKOA was Ksh 2.06 to be paid by 2026-11-11. To OPT OUT of Okoa chap chap dial *131*0#" },
  { id: 28444, sender: "Okoa Jahazi", ts: 1793894029498, body: "Your Okoa Chap Chap request was successful. Your call costs through OKOA was Ksh 4.74 to be paid by 2026-11-11. To OPT OUT of Okoa chap chap dial *131*0#" },
  { id: 28442, sender: "MPESA", ts: 1793889615426, body: "UK5DC18XFV Confirmed. Ksh100.00 sent to ELIUD  MWIGEMBE on 5/11/26 at 5:40 PM. New M-PESA balance is Ksh67.65. Transaction cost, Ksh0.00. Amount you can transact within the day is 499,658.00. See all your balances now https://saf.cx/kWQpy" },
  { id: 28441, sender: "MPESA", ts: 1793887363361, body: "UK5DC18KGH Confirmed. Ksh230.00 paid to Quick Mart Mfangano. on 5/11/26 at 5:02 PM.New M-PESA balance is Ksh167.65. Transaction cost, Ksh0.00. Amount you can transact within the day is 499,758.00. See all your balances now https://saf.cx/kWQpy" },
  { id: 28439, sender: "Safaricom", ts: 1793882037161, body: "Do more with Safaricom data. You have purchased Sh20 (1GB valid 1Hr). Enjoy FREE Unlimited entertainment today with BAZE at no extra cost. Watch now:https://bit.ly/PataBaze." },
  { id: 28438, sender: "Okoa Jahazi", ts: 1793882035062, body: "You have received Ksh20.00. The fee is KSH 2.23.Your debt of Ksh 22.23 should be paid by 10-11-2026.TOTAL UNPAID OKOA JAHAZI is 36.93. You can now Okoa Minutes to Call MORE for LESS. Just select Okoa minutes. Dial *131# to check your okoa limit." }
];

for (const m of INITIAL_SEED_MESSAGES) {
  const p = parseFinancialSms(m.body, m.sender, m.ts, m.id);
  if (p && !p.is_business_till) savePersonalTransaction(p);
}

let lastSeenId = 28453;
let didHistoricalBackfill = false;
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    if (saved.lastSeenId > lastSeenId) lastSeenId = saved.lastSeenId;
  } else {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSeenId }, null, 2));
  }
} catch (_) {}

function querySmsInbox(limit = 15) {
  return new Promise((resolve) => {
    execFile(
      ADB_PATH,
      ["shell", `content query --uri content://sms/inbox --projection _id:address:date:body --sort 'date DESC' | head -n ${limit}`],
      { timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith("Row: "));
        const parsed = [];
        for (const line of lines) {
          const idMatch = line.match(/_id=(\d+)/);
          const addrMatch = line.match(/address=([^,]+),/);
          const dateMatch = line.match(/date=(\d+),/);
          const bodyMatch = line.match(/body=(.+)$/);
          if (idMatch && addrMatch && bodyMatch) {
            parsed.push({
              id: parseInt(idMatch[1], 10),
              address: addrMatch[1].trim(),
              date: dateMatch ? parseInt(dateMatch[1], 10) : Date.now(),
              body: bodyMatch[1].trim()
            });
          }
        }
        resolve(parsed.sort((a, b) => a.id - b.id));
      }
    );
  });
}

async function pollLoop() {
  console.log(`[REDMI DUAL BRIDGE] Active! Watching Redmi Note 12 for Business Till & Personal Financial SMS (_id > ${lastSeenId})...`);
  while (true) {
    try {
      // On first successful connection to Redmi Note 12, backfill up to 150 historical financial SMS messages (Personal + Till)
      if (!didHistoricalBackfill) {
        const history = await querySmsInbox(150);
        if (history.length > 0) {
          let importedCount = 0;
          let tillBackfilledCount = 0;
          const poolPath = path.resolve(process.cwd(), "till_receipt_pool.json");
          let existingCodes = new Set();
          try {
            if (fs.existsSync(poolPath)) {
              const existingPool = JSON.parse(fs.readFileSync(poolPath, "utf-8") || "[]");
              existingCodes = new Set(existingPool.map(r => (r.code || "").toUpperCase()));
            }
          } catch (_) {}

          for (const msg of history) {
            const p = parseFinancialSms(msg.body, msg.address, msg.date, msg.id);
            if (p && !p.is_business_till) {
              const res = savePersonalTransaction(p);
              if (res.saved) importedCount++;
            } else if (p && p.is_business_till && p.reference && !existingCodes.has(p.reference.toUpperCase())) {
              existingCodes.add(p.reference.toUpperCase());
              tillBackfilledCount++;
              await fetch(TILL_WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ from: msg.address, sim: "REDMI_TILL_BACKFILL", text: msg.body })
              }).catch(() => {});
            }
          }
          didHistoricalBackfill = true;
          console.log(`[REDMI DUAL BRIDGE] Historical backfill complete: imported ${importedCount} personal & ${tillBackfilledCount} Till messages from Redmi Note 12.`);
        }
      }

      const messages = await querySmsInbox(12);
      for (const msg of messages) {
        if (msg.id > lastSeenId) {
          lastSeenId = msg.id;
          fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSeenId }, null, 2));

          const fin = parseFinancialSms(msg.body, msg.address, msg.date, msg.id);
          if (fin && fin.is_business_till) {
            console.log(`[REDMI DUAL BRIDGE] -> [BUSINESS TILL] (#${msg.id}): "${msg.body}"`);
            await fetch(TILL_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ from: msg.address, sim: "REDMI_TILL_SIM", text: msg.body })
            });
          } else if (fin && !fin.is_business_till) {
            const res = savePersonalTransaction(fin);
            console.log(`[REDMI DUAL BRIDGE] -> [PERSONAL FINANCE] (#${msg.id}) [${fin.category}]: KES ${fin.amount} (${fin.counterparty}) | Saved=${res.saved}`);
          } else {
            console.log(`[REDMI DUAL BRIDGE] Skipped non-financial SMS (#${msg.id} from ${msg.address})`);
          }
        }
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2500));
  }
}

pollLoop();

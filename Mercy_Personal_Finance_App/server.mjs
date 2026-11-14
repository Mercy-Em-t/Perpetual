/**
 * server.mjs
 * ==========
 * Standalone Personal Finance Application Server (Port 5180).
 * Binds to 0.0.0.0:5180 so it is accessible via:
 *   - Localhost: http://127.0.0.1:5180
 *   - Home Wi-Fi: http://192.168.100.32:5180
 *   - Tailscale: http://100.111.211.80:5180
 *
 * Bidirectional Ledger Sync:
 *   Keeps C:\Users\user\Documents\Perpetual\whatsapp_gateway\personal_finance_ledger.json
 *   and C:\Users\user\Documents\Mercy_Personal_Finance_App\personal_finance_ledger.json
 *   100% synchronized in real time.
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseFinancialSms,
  savePersonalTransaction,
  recategorizeTransaction,
  loadBudgets,
  saveBudgets,
  computeFinancialReport,
  generateCsvExport,
  syncFromRedmiPhone,
  loadPersonalLedger
} from "./finance_core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.FINANCE_PORT || 5180);

// Initial ledger merge & sync on startup
loadPersonalLedger();

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  // CORS headers so mobile PWA / Android WebView / cross-port :5174 can talk seamlessly
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1:5180"}`);
  const pathname = parsedUrl.pathname;

  try {
    // 1. GET /api/report (with ?period=all|today|week|month & ?category=...)
    if (req.method === "GET" && (pathname === "/api/report" || pathname === "/api/finance/report")) {
      const period = parsedUrl.searchParams.get("period") || "all";
      const category = parsedUrl.searchParams.get("category") || "";
      const report = computeFinancialReport({ period, category });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(200);
      return res.end(JSON.stringify(report));
    }

    // 2. POST /api/ingest (single or bulk SMS from MPESA, DTB, KCB, Equity, Safaricom, Okoa, Fuliza)
    if (req.method === "POST" && (pathname === "/api/ingest" || pathname === "/api/finance/ingest")) {
      const body = await parseJsonBody(req).catch(() => ({}));
      let items = [];

      if (Array.isArray(body.messages)) {
        items = body.messages;
      } else if (typeof body.bulk_text === "string" && body.bulk_text.trim()) {
        // Split bulk pasted SMS blocks by double newline or individual "Confirmed" / "Dear " / "You have " lines
        const blocks = body.bulk_text
          .split(/\r?\n\s*\r?\n|\r?\n(?=[A-Z0-9]{10}\s+Confirmed|Dear\s+|You\s+have\s+|Do\s+more\s+with|Your\s+Okoa)/i)
          .map((s) => s.trim())
          .filter(Boolean);
        items = blocks.map((b) => ({ text: b, from: body.from || "MPESA" }));
      } else {
        items = [body];
      }

      let addedCount = 0;
      let duplicateCount = 0;
      const parsedResults = [];

      for (const item of items) {
        const text = item.text || item.body || item.sms || "";
        const sender = item.from || item.sender || item.address || "MPESA";
        const ts = item.timestamp || item.date || Date.now();
        const smsId = item.id || item.sms_id || null;
        const p = parseFinancialSms(text, sender, ts, smsId);
        if (p && !p.is_business_till) {
          const r = savePersonalTransaction(p);
          if (r.saved) addedCount++;
          else if (r.duplicate) duplicateCount++;
          parsedResults.push({ ...p, saved: r.saved, duplicate: Boolean(r.duplicate) });
        } else if (p && p.is_business_till) {
          parsedResults.push({ ...p, saved: false, skipped_reason: "Business Till 5758419 receipt (excluded from Personal Finance)" });
        }
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(200);
      return res.end(
        JSON.stringify({
          success: true,
          added_count: addedCount,
          duplicate_count: duplicateCount,
          parsed: parsedResults,
          report: computeFinancialReport()
        })
      );
    }

    // 3. POST /api/recategorize (Re-assign category or add custom note/budget tag)
    if (req.method === "POST" && pathname === "/api/recategorize") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const result = recategorizeTransaction({
        ref_code: body.ref_code,
        sms_id: body.sms_id,
        category: body.category,
        note: body.note
      });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(result.success ? 200 : 404);
      return res.end(
        JSON.stringify({
          ...result,
          report: computeFinancialReport({
            period: body.period || "all",
            category: body.category_filter || ""
          })
        })
      );
    }

    // 4. GET /api/budgets & POST /api/budgets (Monthly category budget limits & 80%/100% alerts)
    if (pathname === "/api/budgets") {
      if (req.method === "GET") {
        const budgets = loadBudgets();
        const report = computeFinancialReport({ period: "month" });
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            success: true,
            budgets,
            budget_alerts: report.budget_alerts
          })
        );
      }
      if (req.method === "POST") {
        const body = await parseJsonBody(req).catch(() => ({}));
        const payload = body.budgets || (body.category ? { [body.category]: body.limit ?? body.amount } : body);
        const updatedBudgets = saveBudgets(payload);
        const report = computeFinancialReport({ period: body.period || "all" });
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            success: true,
            budgets: updatedBudgets,
            budget_alerts: report.budget_alerts,
            report
          })
        );
      }
    }

    // 5. GET /api/export.csv (1-click CSV/Excel download of all categorized transactions)
    if (req.method === "GET" && pathname === "/api/export.csv") {
      const period = parsedUrl.searchParams.get("period") || "all";
      const category = parsedUrl.searchParams.get("category") || "";
      const csv = generateCsvExport(period, category);
      const filename = `Mercy_Personal_Finance_${period}_${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.writeHead(200);
      return res.end("\uFEFF" + csv); // UTF-8 BOM for clean Excel rendering of emojis
    }

    // 6. POST /api/sync-phone (Live ADB SMS pull from Redmi Note 12)
    if (req.method === "POST" && pathname === "/api/sync-phone") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const limit = Number(body.limit) || 150;
      const syncRes = await syncFromRedmiPhone(limit);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ...syncRes,
          report: computeFinancialReport({
            period: body.period || "all"
          })
        })
      );
    }

    // 7. Static PWA Assets (public/index.html, public/manifest.json, public/sw.js, public/icon.svg)
    let safeRel = pathname === "/" || pathname === "/finance-app" ? "/index.html" : pathname;
    safeRel = path.normalize(safeRel).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(PUBLIC_DIR, safeRel);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
      res.writeHead(200);
      return fs.createReadStream(filePath).pipe(res);
    }

    // Fallback to SPA index.html
    const indexHtml = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexHtml)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      return fs.createReadStream(indexHtml).pipe(res);
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`========================================================================`);
  console.log(`💎 MERCY PERSONAL FINANCE APP — STANDALONE SERVER ACTIVE (PORT ${PORT})`);
  console.log(`   • Local Desktop : http://127.0.0.1:${PORT}`);
  console.log(`   • Home Wi-Fi    : http://192.168.100.32:${PORT}`);
  console.log(`   • Tailscale VPN : http://100.111.211.80:${PORT}`);
  console.log(`   • Synced Ledger : C:\\Users\\user\\Documents\\Perpetual\\whatsapp_gateway\\personal_finance_ledger.json`);
  console.log(`========================================================================`);
});

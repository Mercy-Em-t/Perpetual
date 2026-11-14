/**
 * Unified Vercel Serverless Microservice Entrypoint ("Monolambda" Pattern)
 * =========================================================================
 * - Uses 1 Serverless Function slot (out of 12 on Vercel Hobby)
 * - Zero heavy external npm dependencies (< 150 KB bundle, near-zero Functions Storage)
 * - Serves:
 *   1. GET /storefront (and GET / when Accept: text/html) -> templates/storefront.html
 *   2. GET /api/v1/storefront/:slug/catalog (Edge cached: s-maxage=10, stale-while-revalidate=50)
 *   3. POST /api/v1/storefront/checkout (Blind Checkout Crypto + Atomic Order Guard Hold)
 *   4. POST /api/v1/storefront/release-hold & /api/v1/storefront/quote
 *   5. POST /api/order/verify-payment, /api/checkout, GET /api/order/status
 *   6. POST /api/v1/till/sms-webhook & GET /health
 */

import fs from "node:fs";
import path from "node:path";
import { createHttpRouter } from "../whatsapp_gateway/http_routes.mjs";

const GROUPS = {
  general: { name: "perpetua", jid: process.env.WA_GENERAL_JID || null },
  helpdesk: { name: "Perpetua - IT Helpdesk", jid: process.env.WA_HELPDESK_JID || null },
  adminOversight: { name: "Perpetua - Admin Oversight", jid: process.env.WA_ADMIN_JID || null },
};

// Optional remote Baileys worker bridge: if an always-on Baileys socket is running
// on a Linux worker (e.g. BAILEYS_WORKER_URL), forward WhatsApp messages to it non-blockingly.
async function safeSendMessage(jid, content) {
  const workerUrl = process.env.BAILEYS_WORKER_URL;
  if (!workerUrl || !jid) return false;
  try {
    await fetch(`${workerUrl.replace(/\/$/, "")}/api/notify-Custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetJid: jid, message: content?.text || "" }),
      signal: AbortSignal.timeout(2500),
    });
    return true;
  } catch (_) {
    return false;
  }
}

const router = createHttpRouter({
  GROUPS,
  getConnectionState: () => (process.env.BAILEYS_WORKER_URL ? "hybrid-worker" : "serverless-http"),
  getBotJid: () => null,
  safeSendMessage,
  getSock: () => null,
});

export default async function handler(req, res) {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);

  // Serve Unified Storefront WebApp on /storefront (or / for browser HTML requests)
  if (
    req.method === "GET" &&
    (parsedUrl.pathname === "/storefront" ||
      (parsedUrl.pathname === "/" && String(req.headers?.accept || "").includes("text/html")))
  ) {
    const storefrontPath = path.resolve(process.cwd(), "templates", "storefront.html");
    if (fs.existsSync(storefrontPath)) {
      let html = fs.readFileSync(storefrontPath, "utf-8");
      // Rewrite hardcoded localhost:5174 API calls to same-origin when hosted on Vercel
      html = html.replace(/http:\/\/localhost:5174/g, "").replace(/http:\/\/127\.0\.0\.1:5174/g, "");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
      res.writeHead(200);
      return res.end(html);
    }
  }

  return router(req, res);
}

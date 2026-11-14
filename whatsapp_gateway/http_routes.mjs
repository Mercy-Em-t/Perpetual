/**
 * HTTP IPC Router for WhatsApp Gateway & TMS Whitelabel Microservice
 *
 * Route Index (see ./routes/INDEX.md for full details):
 * - ./routes/ops_groups_and_support.mjs : /health, /groups, /api/groups/*, /api/shops/provision, /api/support/*, /api/sentinel/*, /api/notify-*, /api/eod-report, /api/broadcast-*
 * - ./routes/orders.mjs                 : /order, /api/order, /api/checkout, /api/order/verify-payment, /api/verify-payment, /api/order/status
 * - ./routes/till_finance.mjs           : /api/till/*, /acoustic-modem, /till-app, /api/finance/*, /finance-app
 * - ./routes/storefront.mjs             : /api/v1/storefront/:slug/catalog, /api/v1/storefront/checkout, /api/v1/storefront/release-hold, /api/v1/storefront/quote, /api/v1/merchant/orders/:id/advance
 * - tryServeWhitelabelSpa()             : Serves built tms-whitelabel-core/dist SPA on / and client routes
 */
import fs from "node:fs";
import path from "node:path";
import { OrderGuard } from "./order_guard.mjs";
import { handleOpsGroupsAndSupportRoutes } from "./routes/ops_groups_and_support.mjs";
import { handleOrdersRoutes } from "./routes/orders.mjs";
import { handleTillFinanceRoutes } from "./routes/till_finance.mjs";
import { handleStorefrontRoutes } from "./routes/storefront.mjs";

if (process.env.NODE_ENV === "production") {
  const missing = ["PII_ENCRYPTION_KEY", "ORDER_GUARD_KEY", "ORDER_GUARD_HMAC_SECRET"].filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`[FATAL] Missing required production Order Guard keys: ${missing.join(", ")}`);
  }
}

const PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || "dev-pii-encryption-key-isolated";
const ORDER_GUARD_KEY = process.env.ORDER_GUARD_KEY || "dev-order-guard-inspector-key";
const ORDER_GUARD_HMAC_SECRET = process.env.ORDER_GUARD_HMAC_SECRET || "dev-order-guard-hmac";

export const sharedOrderGuard = new OrderGuard({
  inspectorKey: ORDER_GUARD_KEY,
  hmacSecret: ORDER_GUARD_HMAC_SECRET
});
sharedOrderGuard.startSweeper(60_000);

function getWhitelabelDistDir() {
  const candidates = [
    process.env.TMS_WHITELABEL_DIST,
    path.resolve(import.meta.dirname, "..", "..", "Quality assurance", "tms-whitelabel-core", "dist"),
    path.resolve(import.meta.dirname, "..", "tms-whitelabel-core", "dist"),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) || null;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function tryServeWhitelabelSpa(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname.startsWith("/api/") || pathname === "/health" || pathname === "/groups") return false;

  const distDir = getWhitelabelDistDir();
  if (!distDir) return false;

  const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(distDir, relPath);
  if (!resolved.startsWith(path.resolve(distDir))) return false;

  let targetFile = null;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    targetFile = resolved;
  } else if (!path.extname(relPath)) {
    const indexHtml = path.join(distDir, "index.html");
    if (fs.existsSync(indexHtml)) targetFile = indexHtml;
  }

  if (!targetFile) return false;

  const ext = path.extname(targetFile).toLowerCase();
  res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
  res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable");
  res.writeHead(200);
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(fs.readFileSync(targetFile));
  }
  return true;
}

export function createHttpRouter({ GROUPS, getConnectionState, getBotJid, safeSendMessage, getSock }) {
  return async function handleHttpRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "HEAD") {
      res.writeHead(200);
      return res.end();
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // GET / (Serve TMS Whitelabel SPA for browsers, or JSON service info for API probes)
    if (req.method === "GET" && (parsedUrl.pathname === "/" || parsedUrl.pathname === "")) {
      const acceptsHtml = String(req.headers.accept || "").includes("text/html");
      if (acceptsHtml && tryServeWhitelabelSpa(req, res, "/")) {
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      return res.end(JSON.stringify({
        service: "TMS WhatsApp Operations Gateway",
        status: "active",
        port: 5174,
        health: "http://127.0.0.1:5174/health",
        groups: "http://127.0.0.1:5174/groups"
      }, null, 2));
    }

    const ctx = {
      req,
      res,
      parsedUrl,
      GROUPS,
      getConnectionState,
      getBotJid,
      safeSendMessage,
      getSock,
      sharedOrderGuard,
      PII_ENCRYPTION_KEY,
      ORDER_GUARD_KEY,
      ORDER_GUARD_HMAC_SECRET,
    };

    if (await handleOpsGroupsAndSupportRoutes(ctx) || res.writableEnded) return;
    if (await handleOrdersRoutes(ctx) || res.writableEnded) return;
    if (await handleTillFinanceRoutes(ctx) || res.writableEnded) return;
    if (await handleStorefrontRoutes(ctx) || res.writableEnded) return;

    // Serve built TMS Whitelabel SPA & static assets when available
    if (tryServeWhitelabelSpa(req, res, parsedUrl.pathname)) {
      return;
    }

    // Fallback 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  };
}

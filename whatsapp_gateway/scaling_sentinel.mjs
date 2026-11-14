/**
 * Scaling & Upgrade Sentinel
 *
 * Continuously watches pilot scaling boundaries (active shop count, hourly order
 * velocity, Supabase REST probe latency, and unresolved support backlog).
 * When metrics approach "dangerous territory", it immediately dispatches a
 * "there and then" advisory via WhatsApp (Admin Oversight + IT Helpdesk), opens
 * a tracked Support Incident Ticket, and sends an advisory email via the
 * configured temporal mail bridge (ALERT_EMAIL_WEBHOOK_URL or RESEND_API_KEY).
 */
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROUPS } from "./config.mjs";
import { createSupportTicket, listSupportTickets } from "./support_tickets.mjs";

const CHECK_INTERVAL_MS = parseInt(process.env.SCALING_SENTINEL_INTERVAL_MS || "300000", 10); // 5 min default
const ALERT_COOLDOWN_MS = parseInt(process.env.SCALING_ALERT_COOLDOWN_MS || String(6 * 60 * 60 * 1000), 10); // 6h cooldown

export const SCALING_THRESHOLDS = {
  shopsWarning: parseInt(process.env.SCALE_SHOPS_WARN || "15", 10),
  shopsCritical: parseInt(process.env.SCALE_SHOPS_CRIT || "30", 10),
  ordersPerHourWarning: parseInt(process.env.SCALE_ORDERS_HR_WARN || "60", 10),
  ordersPerHourCritical: parseInt(process.env.SCALE_ORDERS_HR_CRIT || "150", 10),
  latencyWarningMs: parseInt(process.env.SCALE_LATENCY_WARN_MS || "250", 10),
  latencyCriticalMs: parseInt(process.env.SCALE_LATENCY_CRIT_MS || "600", 10),
  targetBackendUrl: process.env.PRODUCTION_CORE_API_URL || "https://api.tmsavannah.com"
};

let lastAlertByLevel = { WARNING: 0, CRITICAL: 0 };
let lastReport = null;
let sentinelTimer = null;

async function supabaseGet(pathWithQuery) {
  const key = SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const url = `${SUPABASE_URL.replace(/\/$/, "")}${pathWithQuery}`;
  const start = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact"
    }
  });
  const latencyMs = Date.now() - start;
  const contentRange = res.headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  const exactCount = match ? parseInt(match[1], 10) : null;

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  return { ok: res.ok, status: res.status, latencyMs, exactCount, data };
}

async function dispatchEmailAdvisory({ level, subject, textBody, htmlBody }) {
  const webhookUrl = process.env.ALERT_EMAIL_WEBHOOK_URL;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.ADMIN_ALERT_EMAIL || "ops@tmsavannah.com";

  // 1. Temporal Bridge / Google Apps Script Email Webhook
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: toEmail,
          subject,
          text: textBody,
          html: htmlBody,
          level,
          source: "TMS Scaling Sentinel"
        })
      });
      if (res.ok) {
        console.log(`[SCALING SENTINEL] 📧 Advisory email sent via temporal webhook to ${toEmail}`);
        return { sent: true, channel: "webhook", to: toEmail };
      }
      console.warn(`[SCALING SENTINEL] Email webhook returned ${res.status}`);
    } catch (err) {
      console.warn("[SCALING SENTINEL] Email webhook failed:", err.message);
    }
  }

  // 2. Direct Resend API fallback
  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendKey}`
        },
        body: JSON.stringify({
          from: process.env.ALERT_EMAIL_FROM || "Sentinel <sentinel@tmsavannah.com>",
          to: [toEmail],
          subject,
          text: textBody,
          html: htmlBody
        })
      });
      if (res.ok) {
        console.log(`[SCALING SENTINEL] 📧 Advisory email sent via Resend to ${toEmail}`);
        return { sent: true, channel: "resend", to: toEmail };
      }
      console.warn(`[SCALING SENTINEL] Resend returned ${res.status}`);
    } catch (err) {
      console.warn("[SCALING SENTINEL] Resend failed:", err.message);
    }
  }

  console.log("[SCALING SENTINEL] ℹ️ No ALERT_EMAIL_WEBHOOK_URL or RESEND_API_KEY configured; email advisory logged only.");
  return { sent: false, reason: "no_email_provider_configured" };
}

export async function runScalingCheck({ safeSendMessage = null, forceAlert = false } = {}) {
  const checkedAt = new Date().toISOString();
  const triggers = [];
  let level = "HEALTHY";

  let activeShops = 0;
  let ordersLastHour = 0;
  let probeLatencyMs = 0;
  let probeStatus = 200;

  try {
    // 1. Measure Supabase REST latency & active shops count
    const shopsRes = await supabaseGet("/rest/v1/shops?select=id&limit=1");
    probeLatencyMs = shopsRes.latencyMs;
    probeStatus = shopsRes.status;
    activeShops = shopsRes.exactCount ?? (Array.isArray(shopsRes.data) ? shopsRes.data.length : 0);

    if (!shopsRes.ok) {
      level = "CRITICAL";
      triggers.push(`Supabase REST probe returned HTTP ${shopsRes.status}`);
    } else if (probeLatencyMs >= SCALING_THRESHOLDS.latencyCriticalMs) {
      level = "CRITICAL";
      triggers.push(`Supabase latency ${probeLatencyMs}ms >= ${SCALING_THRESHOLDS.latencyCriticalMs}ms critical limit`);
    } else if (probeLatencyMs >= SCALING_THRESHOLDS.latencyWarningMs) {
      if (level !== "CRITICAL") level = "WARNING";
      triggers.push(`Supabase latency ${probeLatencyMs}ms >= ${SCALING_THRESHOLDS.latencyWarningMs}ms warning limit`);
    }

    if (activeShops >= SCALING_THRESHOLDS.shopsCritical) {
      level = "CRITICAL";
      triggers.push(`Active shops (${activeShops}) reached critical pilot ceiling (${SCALING_THRESHOLDS.shopsCritical}+)`);
    } else if (activeShops >= SCALING_THRESHOLDS.shopsWarning) {
      if (level !== "CRITICAL") level = "WARNING";
      triggers.push(`Active shops (${activeShops}) crossed warning threshold (${SCALING_THRESHOLDS.shopsWarning})`);
    }

    // 2. Measure hourly order velocity
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const ordersRes = await supabaseGet(`/rest/v1/orders?select=id&created_at=gte.${encodeURIComponent(oneHourAgo)}&limit=1`);
    ordersLastHour = ordersRes.exactCount ?? 0;

    if (ordersLastHour >= SCALING_THRESHOLDS.ordersPerHourCritical) {
      level = "CRITICAL";
      triggers.push(`Order velocity ${ordersLastHour}/hr >= ${SCALING_THRESHOLDS.ordersPerHourCritical}/hr critical limit`);
    } else if (ordersLastHour >= SCALING_THRESHOLDS.ordersPerHourWarning) {
      if (level !== "CRITICAL") level = "WARNING";
      triggers.push(`Order velocity ${ordersLastHour}/hr >= ${SCALING_THRESHOLDS.ordersPerHourWarning}/hr warning limit`);
    }
  } catch (err) {
    const isNetworkOffline =
      /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err.message || "");
    level = isNetworkOffline ? "OFFLINE" : "CRITICAL";
    triggers.push(
      isNetworkOffline
        ? `Local network / DNS unreachable (${err.message})`
        : `Telemetry probe exception: ${err.message}`
    );
  }

  const openTickets = listSupportTickets({ status: "ACTIVE" });

  const report = {
    checkedAt,
    level,
    metrics: {
      activeShops,
      ordersLastHour,
      probeLatencyMs,
      probeStatus,
      openSupportTickets: openTickets.length
    },
    thresholds: SCALING_THRESHOLDS,
    triggers,
    upgradeRecommended: level === "WARNING" || level === "CRITICAL"
  };

  lastReport = report;

  // Dispatch "there and then" advisories only when entering scaling warning/critical territory
  const now = Date.now();
  const shouldAlert =
    forceAlert ||
    ((level === "WARNING" || level === "CRITICAL") &&
      now - (lastAlertByLevel[level] || 0) >= ALERT_COOLDOWN_MS);

  if (shouldAlert) {
    lastAlertByLevel[level] = now;

    const ticket = createSupportTicket({
      title: `[${level}] Scaling Upgrade Advisory (${activeShops} shops, ${probeLatencyMs}ms)`,
      description:
        `Triggers: ${triggers.join("; ") || "Manual diagnostic check"}. ` +
        `Action: Switch storefront API base URL to ${SCALING_THRESHOLDS.targetBackendUrl} with Cloudflare Edge Caching.`,
      source: "SCALING_SENTINEL",
      severity: level === "CRITICAL" ? "CRITICAL" : "HIGH",
      reportedBy: "Scaling Sentinel"
    });

    const headline =
      level === "CRITICAL"
        ? "🚨 *DANGEROUS TERRITORY — UPGRADE INFRASTRUCTURE NOW*"
        : "⚠️ *SCALING ADVISORY — APPROACHING PILOT CEILING*";

    const whatsappMsg =
      `${headline}\n\n` +
      `• *Status:* ${level}\n` +
      `• *Active Shops:* ${activeShops} / ${SCALING_THRESHOLDS.shopsCritical} (50-shop Edge target)\n` +
      `• *Orders (Last 1h):* ${ordersLastHour} / ${SCALING_THRESHOLDS.ordersPerHourCritical}\n` +
      `• *Supabase Latency:* ${probeLatencyMs}ms (HTTP ${probeStatus})\n` +
      `• *Open Support Tickets:* ${openTickets.length}\n\n` +
      `*Detected Triggers:*\n` +
      (triggers.length ? triggers.map((t) => `  - ${t}`).join("\n") : "  - Manual check requested") +
      `\n\n*Recommended Upgrade Action:*\n` +
      `1. Route storefront reads to \`${SCALING_THRESHOLDS.targetBackendUrl}\`\n` +
      `2. Enable Cloudflare Edge Caching so N concurrent shoppers do not generate N direct DB hits\n\n` +
      `🎫 *Tracked Ticket:* \`${ticket.id}\`\n` +
      `_In Perpetua - IT Helpdesk: \`!claim ${ticket.id}\` or \`!resolve ${ticket.id} <notes>\`_`;

    if (typeof safeSendMessage === "function") {
      if (GROUPS.adminOversight?.jid) {
        await safeSendMessage(GROUPS.adminOversight.jid, { text: whatsappMsg });
      }
      if (GROUPS.itHelpdesk?.jid) {
        await safeSendMessage(GROUPS.itHelpdesk.jid, { text: whatsappMsg });
      }
    }

    const emailSubject = `[${level}] TMS Scaling Sentinel: Time to Upgrade to ${SCALING_THRESHOLDS.targetBackendUrl}`;
    const emailResult = await dispatchEmailAdvisory({
      level,
      subject: emailSubject,
      textBody: whatsappMsg.replace(/[*_`]/g, ""),
      htmlBody: `<pre style="font-family:monospace;white-space:pre-wrap;">${whatsappMsg.replace(/[*_`]/g, "")}</pre>`
    });

    report.alertDispatched = { ticketId: ticket.id, email: emailResult };
  }

  return report;
}

export function getLastScalingReport() {
  return lastReport;
}

export function startScalingSentinel(safeSendMessage) {
  if (sentinelTimer) {
    clearInterval(sentinelTimer);
  }
  console.log(
    `[SCALING SENTINEL] 🛡️ Active (Interval: ${Math.round(CHECK_INTERVAL_MS / 1000)}s | ` +
    `Shops warn/crit: ${SCALING_THRESHOLDS.shopsWarning}/${SCALING_THRESHOLDS.shopsCritical} | ` +
    `Latency warn/crit: ${SCALING_THRESHOLDS.latencyWarningMs}ms/${SCALING_THRESHOLDS.latencyCriticalMs}ms)`
  );

  // Run initial check 15 seconds after startup, then on interval
  setTimeout(() => {
    runScalingCheck({ safeSendMessage }).catch((err) =>
      console.warn("[SCALING SENTINEL] Initial check error:", err.message)
    );
  }, 15000);

  sentinelTimer = setInterval(() => {
    runScalingCheck({ safeSendMessage }).catch((err) =>
      console.warn("[SCALING SENTINEL] Periodic check error:", err.message)
    );
  }, CHECK_INTERVAL_MS);

  return sentinelTimer;
}

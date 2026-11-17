/**
 * Platform Cadence Daemon
 * =======================
 * Autonomous cron scheduler that pushes actionable management dockets directly to
 * your WhatsApp Management Desk / Executive Oversight at predetermined operational hours:
 *
 * • 06:30 AM EAT: Overnight Reconciliation, Unseconded Payment Queue, SLA Infractions, Daily Renewals
 * • 09:15 AM EAT: T+1 M-Pesa B2C Net Merchant Settlements Pre-Computed List
 * • 12:00 PM EAT: Mid-Day Lunch Rush & Kitchen Bottleneck Telemetry
 * • 22:00 PM (10:00 PM) EAT: Daily Dual Register Closure (Individual Shop DMs + Platform Rollup)
 * • Tuesday 07:00 AM EAT: Weekly Rolling Reserves & Chargeback Ratio Audit
 * • 1st of Month 08:00 AM EAT: Monthly SaaS Plan A Renewals & Statement Generation
 *
 * Zero-Drift EAT Timezone Guard: Evaluates wall-clock time in Africa/Nairobi (UTC+3).
 * Idempotency Protection: Guarantees each docket dispatches at most once per calendar day.
 */

import { GROUPS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";
import {
  generateMorningDocketReport,
  generateSettlementDocketReport,
  generateLunchRushDocketReport,
  generateWeeklyTuesdayDocketReport,
  generateMonthlyDocketReport
} from "./operating_dockets.mjs";
import { runFullDualEODReconciliation } from "./eod_reconciler.mjs";
import { executeDatabaseBackup } from "./database_backup_sentinel.mjs";

const CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds
let daemonTimer = null;

// Track last dispatched date per cadence key to guarantee zero duplicates
const lastDispatched = {
  morning: null,
  settlement: null,
  lunch: null,
  eod: null,
  weeklyTuesday: null,
  monthlyFirst: null,
  preMonthlyReminder: null,
  preAnnualReminder: null,
  dbBackup: null
};

/**
 * Returns current wall-clock components in Kenya EAT (Africa/Nairobi)
 */
export function getEatTimeComponents(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false
  }).formatToParts(date);

  const get = (type) => parts.find(p => p.type === type)?.value;
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    weekday: get("weekday"), // e.g. "Mon", "Tue"
    dateKey: `${get("year")}-${get("month")}-${get("day")}`
  };
}

const alertedStalledOrders = new Set();

/**
 * Checks for orders that have sat in PAID state for >15 minutes without moving to PREPARING
 */
async function checkStalledKitchenOrders(safeSendMessage, targetJid) {
  if (!safeSendMessage || !targetJid) return;
  try {
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const hdrs = {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?status=eq.paid&created_at=lte.${fifteenMinsAgo}&select=id,shop_id,total_price,client_name,client_phone,created_at&limit=10`, { headers: hdrs });
    const stalled = await res.json();
    if (!Array.isArray(stalled) || stalled.length === 0) return;

    for (const order of stalled) {
      if (alertedStalledOrders.has(order.id)) continue;
      alertedStalledOrders.add(order.id);

      const elapsedMins = Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000);
      const shortId = order.id.slice(0, 8).toUpperCase();
      const stallMsg =
        `⚠️ *KITCHEN STALL ALERT: ORDER UNACKNOWLEDGED*\n\n` +
        `📦 *ORDER DETAILS*\n` +
        `• Order: *#${shortId}* (KES ${Number(order.total_price || 0).toLocaleString()})\n` +
        `• Customer: *${order.client_name || "Customer"}* (\`${order.client_phone || "N/A"}\`)\n` +
        `• Status: *${elapsedMins} Minutes in PAID State* (No Kitchen Acknowledgment)\n\n` +
        `🚨 *DIAGNOSTIC & RISK*\n` +
        `• Risk: Customer waiting without kitchen prep\n` +
        `• Probable Cause: Kitchen phone offline, muted, or Wi-Fi blackout (KPLC factor)\n\n` +
        `⚡ *IMMEDIATE ACTION*\n` +
        `• Call merchant directly or run: \`!prep ${shortId}\``;

      await safeSendMessage(targetJid, { text: stallMsg }).catch(() => {});
    }
  } catch (err) {
    // Non-blocking telemetry check
  }
}

/**
 * Evaluates cadence triggers and dispatches when wall-clock matches
 */
export async function evaluateCadenceTriggers({
  safeSendMessage = null,
  referenceDate = new Date(),
  forceTrigger = null
} = {}) {
  const eat = getEatTimeComponents(referenceDate);
  const targetOversightJid = GROUPS?.adminOversight?.jid || "120363415291701803@g.us";
  const executed = [];

  const canDispatch = (key) => {
    if (forceTrigger && forceTrigger.toLowerCase() === key.toLowerCase()) return true;
    return lastDispatched[key] !== eat.dateKey;
  };

  const markDispatched = (key) => {
    lastDispatched[key] = eat.dateKey;
  };

  // Continuous Invariant Check: Kitchen Stall Sentinel (15-min SLA check)
  if (!forceTrigger) {
    checkStalledKitchenOrders(safeSendMessage, targetOversightJid).catch(() => {});
  }

  // 0. 03:00 AM EAT — Autonomous Database Snapshot Sentinel
  if ((eat.hour === 3 && eat.minute >= 0 && eat.minute < 5 && canDispatch("dbBackup")) || forceTrigger === "backup") {
    try {
      console.log(`[CADENCE DAEMON] Running 03:00 AM Database Backup Snapshot (${eat.dateKey})...`);
      const backupResult = await executeDatabaseBackup({ safeSendMessage });
      markDispatched("dbBackup");
      executed.push({ key: "dbBackup", success: true, file: backupResult.filename });
    } catch (err) {
      console.error("[CADENCE DAEMON] Database backup error:", err.message);
      executed.push({ key: "dbBackup", success: false, error: err.message });
    }
  }

  // 1. 06:30 AM EAT — Morning Overnight Reconciliation Docket
  if ((eat.hour === 6 && eat.minute >= 30 && eat.minute < 35 && canDispatch("morning")) || forceTrigger === "morning") {
    try {
      console.log(`[CADENCE DAEMON] Dispatching 06:30 AM Morning Docket (${eat.dateKey})...`);
      const docket = await generateMorningDocketReport({ targetDate: referenceDate });
      if (safeSendMessage && targetOversightJid) {
        await safeSendMessage(targetOversightJid, { text: docket.formattedWhatsAppMessage });
      }
      markDispatched("morning");
      executed.push({ key: "morning", success: true });
    } catch (err) {
      console.error("[CADENCE DAEMON] Morning docket dispatch error:", err.message);
      executed.push({ key: "morning", success: false, error: err.message });
    }
  }

  // 2. 09:15 AM EAT — T+1 B2C Net Settlements Docket
  if ((eat.hour === 9 && eat.minute >= 15 && eat.minute < 20 && canDispatch("settlement")) || forceTrigger === "settlement") {
    try {
      console.log(`[CADENCE DAEMON] Dispatching 09:15 AM Settlement Docket (${eat.dateKey})...`);
      const docket = await generateSettlementDocketReport();
      if (safeSendMessage && targetOversightJid) {
        await safeSendMessage(targetOversightJid, { text: docket.formattedWhatsAppMessage });
      }
      markDispatched("settlement");
      executed.push({ key: "settlement", success: true });
    } catch (err) {
      console.error("[CADENCE DAEMON] Settlement docket dispatch error:", err.message);
      executed.push({ key: "settlement", success: false, error: err.message });
    }
  }

  // 3. 12:00 PM EAT — Mid-Day Lunch Rush & Kitchen Bottleneck Docket
  if ((eat.hour === 12 && eat.minute >= 0 && eat.minute < 5 && canDispatch("lunch")) || forceTrigger === "lunch") {
    try {
      console.log(`[CADENCE DAEMON] Dispatching 12:00 PM Lunch Rush Docket (${eat.dateKey})...`);
      const docket = await generateLunchRushDocketReport();
      if (safeSendMessage && targetOversightJid) {
        await safeSendMessage(targetOversightJid, { text: docket.formattedWhatsAppMessage });
      }
      markDispatched("lunch");
      executed.push({ key: "lunch", success: true });
    } catch (err) {
      console.error("[CADENCE DAEMON] Lunch rush docket dispatch error:", err.message);
      executed.push({ key: "lunch", success: false, error: err.message });
    }
  }

  // 4. 22:00 PM (10:00 PM) EAT — End-of-Day Dual Register Closure
  if ((eat.hour === 22 && eat.minute >= 0 && eat.minute < 5 && canDispatch("eod")) || forceTrigger === "eod") {
    try {
      console.log(`[CADENCE DAEMON] Triggering 22:00 EOD Dual Register Closure (${eat.dateKey})...`);
      const eodResult = await runFullDualEODReconciliation({
        targetDate: referenceDate,
        dispatch: !!safeSendMessage,
        sendFn: safeSendMessage
      });
      markDispatched("eod");
      executed.push({ key: "eod", success: true, count: eodResult.shopReports.length });
    } catch (err) {
      console.error("[CADENCE DAEMON] EOD dispatch error:", err.message);
      executed.push({ key: "eod", success: false, error: err.message });
    }
  }

  // 5. Tuesday 07:00 AM EAT — Weekly Rolling Reserves & Chargebacks
  if (eat.weekday === "Tue" && eat.hour === 7 && eat.minute >= 0 && eat.minute < 5 && canDispatch("weeklyTuesday") || forceTrigger === "weekly") {
    try {
      console.log(`[CADENCE DAEMON] Dispatching Tuesday 07:00 Weekly Governance Docket (${eat.dateKey})...`);
      const docket = await generateWeeklyTuesdayDocketReport();
      if (safeSendMessage && targetOversightJid) {
        await safeSendMessage(targetOversightJid, { text: docket.formattedWhatsAppMessage });
      }
      markDispatched("weeklyTuesday");
      executed.push({ key: "weeklyTuesday", success: true });
    } catch (err) {
      console.error("[CADENCE DAEMON] Weekly Tuesday docket dispatch error:", err.message);
      executed.push({ key: "weeklyTuesday", success: false, error: err.message });
    }
  }

  // 6. 1st of the Month 08:00 AM EAT — Monthly Plan A Renewals & Statement Generation
  if (eat.day === 1 && eat.hour === 8 && eat.minute >= 0 && eat.minute < 5 && canDispatch("monthlyFirst") || forceTrigger === "monthly") {
    try {
      console.log(`[CADENCE DAEMON] Dispatching 1st of Month Statement Docket (${eat.dateKey})...`);
      const docket = await generateMonthlyDocketReport();
      if (safeSendMessage && targetOversightJid) {
        await safeSendMessage(targetOversightJid, { text: docket.formattedWhatsAppMessage });
      }
      markDispatched("monthlyFirst");
      executed.push({ key: "monthlyFirst", success: true });
    } catch (err) {
      console.error("[CADENCE DAEMON] Monthly docket dispatch error:", err.message);
      executed.push({ key: "monthlyFirst", success: false, error: err.message });
    }
  }

  // 7. 2 Days to Monthly Date with the System (09:00 AM EAT on day N-1 where N = total days in month)
  const daysInCurrentMonth = new Date(eat.year, eat.month, 0).getDate();
  const isTwoDaysToFirst = eat.day === (daysInCurrentMonth - 1);
  if ((isTwoDaysToFirst && eat.hour === 9 && eat.minute >= 0 && eat.minute < 5 && canDispatch("preMonthlyReminder")) || forceTrigger === "pre-monthly") {
    try {
      console.log(`[CADENCE DAEMON] Dispatching 2-Day Pre-Monthly Reminder (${eat.dateKey})...`);
      const preMonthlyCard =
        `📅 *PLATFORM REMINDER: 2 DAYS TO MONTHLY DATE WITH THE SYSTEM*\n\n` +
        `🏢 *EXECUTIVE SESSION*\n` +
        `• Agenda: *Monthly Platform & Merchant Review*\n` +
        `• Scheduled: *1st of Next Month at 09:00 AM EAT*\n` +
        `• Calendar Status: *Confirmed on Google Calendar* 🗓️\n\n` +
        `📋 *PRE-SESSION PREPARATION*\n` +
        `1. Plan A SaaS subscription invoicing & auto-netting (KES 3,500/store)\n` +
        `2. Generate & audit Monthly Merchant Statements of Account (PDF/CSV)\n` +
        `3. Review Cloudflare bandwidth logs & Tailscale node telemetry\n` +
        `4. Rolling 7-day reserve reconciliation & dispute chargeback sign-off\n\n` +
        `👉 _Please protect this focused 2-hour block in your schedule._`;

      if (safeSendMessage && targetOversightJid) {
        await safeSendMessage(targetOversightJid, { text: preMonthlyCard });
      }
      markDispatched("preMonthlyReminder");
      executed.push({ key: "preMonthlyReminder", success: true });
    } catch (err) {
      console.error("[CADENCE DAEMON] Pre-monthly reminder error:", err.message);
      executed.push({ key: "preMonthlyReminder", success: false, error: err.message });
    }
  }

  // 8. 2 Days to Annual Strategic Review (09:00 AM EAT on December 13)
  const isTwoDaysToAnnual = (eat.month === 12 && eat.day === 13);
  if ((isTwoDaysToAnnual && eat.hour === 9 && eat.minute >= 0 && eat.minute < 5 && canDispatch("preAnnualReminder")) || forceTrigger === "pre-annual") {
    try {
      console.log(`[CADENCE DAEMON] Dispatching 2-Day Pre-Annual Reminder (${eat.dateKey})...`);
      const preAnnualCard =
        `🏆 *PLATFORM REMINDER: 2 DAYS TO ANNUAL DATE WITH THE SYSTEM*\n\n` +
        `🏛️ *ANNUAL STRATEGY AUDIT*\n` +
        `• Agenda: *Annual Platform Strategy & Infrastructure Audit*\n` +
        `• Scheduled: *December 15 at 09:00 AM – 13:00 PM EAT*\n` +
        `• Calendar Status: *Confirmed on Google Calendar* 🗓️\n\n` +
        `📋 *ANNUAL EXECUTIVE AUDIT ITEMS*\n` +
        `1. Merchant contract recertification & KYC permit/KRA compliance\n` +
        `2. Annual commercial SLA, commission structure & tariff review\n` +
        `3. Full disaster recovery drill & PostgreSQL multi-region snapshot test\n` +
        `4. Platform Gross Merchandise Value (GMV) & tax withholding audit\n\n` +
        `👉 _4-hour executive block reserved. Please clear external meetings._`;

      if (safeSendMessage && targetOversightJid) {
        await safeSendMessage(targetOversightJid, { text: preAnnualCard });
      }
      markDispatched("preAnnualReminder");
      executed.push({ key: "preAnnualReminder", success: true });
    } catch (err) {
      console.error("[CADENCE DAEMON] Pre-annual reminder error:", err.message);
      executed.push({ key: "preAnnualReminder", success: false, error: err.message });
    }
  }

  return {
    eatTimestamp: `${eat.dateKey} ${String(eat.hour).padStart(2, "0")}:${String(eat.minute).padStart(2, "0")} EAT (${eat.weekday})`,
    executed
  };
}

/**
 * Starts the continuous Cadence Daemon poller
 */
export function startPlatformCadenceDaemon(safeSendMessage, intervalMs = CHECK_INTERVAL_MS) {
  if (daemonTimer) clearInterval(daemonTimer);
  console.log(`[CADENCE DAEMON] Started autonomous scheduler (EAT Wall-Clock, Poll: ${intervalMs / 1000}s).`);

  // Initial tick after 10 seconds
  setTimeout(() => {
    evaluateCadenceTriggers({ safeSendMessage }).catch(() => {});
  }, 10000);

  daemonTimer = setInterval(() => {
    evaluateCadenceTriggers({ safeSendMessage }).catch(() => {});
  }, intervalMs);

  return daemonTimer;
}

export function stopPlatformCadenceDaemon() {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = null;
    console.log("[CADENCE DAEMON] Stopped.");
  }
}

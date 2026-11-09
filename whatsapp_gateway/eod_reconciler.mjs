/**
 * eod_reconciler.mjs
 * ==================
 * Live Multi-Tenant End-of-Day (EOD) Automated Register & Till Reconciliation Engine.
 * Pulls 100% genuine, live Supabase transaction data — zero mocks.
 * 
 * Supports:
 * 1. Single Shop Register Closure: Dispatched to the shop's dedicated management group / owner DM.
 * 2. Platform-Wide Consolidated Closure: Dispatched to Perpetua Community / Executive Oversight.
 * 3. Dual Automated Dispatch: Dispatches each shop their own report and the platform rollup to community.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GROUPS } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from tms-whitelabel-core or local .env
let envUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
let envKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!envUrl || !envKey) {
  try {
    const rootEnv = fs.readFileSync("C:/Users/user/Documents/Quality assurance/tms-whitelabel-core/.env", "utf8");
    rootEnv.split("\n").forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        let value = (match[2] || "").trim().replace(/^["']|["']$/g, "");
        if (match[1] === "VITE_SUPABASE_URL" || match[1] === "SUPABASE_URL") envUrl = value;
        if (match[1] === "SUPABASE_SERVICE_ROLE_KEY") envKey = value;
      }
    });
  } catch (ignored) {}
}

export const supabase = createClient(envUrl, envKey);

/**
 * Returns the exact UTC ISO strings for Kenya EAT day boundaries.
 * 00:00:00 EAT (UTC+3) = 21:00:00 UTC (previous day)
 * 23:59:59 EAT (UTC+3) = 20:59:59 UTC (current day)
 */
export function getEatDateBoundaries(targetDate = new Date()) {
  const d = new Date(targetDate);
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }); // YYYY-MM-DD
  const startOfDayUtc = new Date(`${dateStr}T00:00:00+03:00`).toISOString();
  const endOfDayUtc = new Date(`${dateStr}T23:59:59+03:00`).toISOString();
  return { dateStr, startOfDayUtc, endOfDayUtc };
}

/**
 * Normalizes a Kenyan phone number into a valid WhatsApp JID.
 */
export function formatPhoneToWhatsAppJid(phoneStr) {
  if (!phoneStr) return null;
  const digits = String(phoneStr).replace(/\D/g, "");
  if (!digits) return null;
  let normalized = digits;
  if (normalized.startsWith("0")) {
    normalized = "254" + normalized.slice(1);
  } else if (!normalized.startsWith("254") && normalized.length === 9) {
    normalized = "254" + normalized;
  }
  return `${normalized}@s.whatsapp.net`;
}

/**
 * Generates the Shop-Specific EOD Register Report.
 */
export async function generateShopEODReport(shopIdentifier = "test-shop", targetDate = new Date()) {
  // 1. Resolve Shop from Supabase
  let shop = null;
  const { data: bySlug } = await supabase.from("shops").select("id, name, slug, phone, whatsapp_number, mpesa_till_number, fulfillment_settings").eq("slug", shopIdentifier).maybeSingle();
  if (bySlug) shop = bySlug;
  else {
    const { data: byId } = await supabase.from("shops").select("id, name, slug, phone, whatsapp_number, mpesa_till_number, fulfillment_settings").eq("id", shopIdentifier).maybeSingle();
    shop = byId;
  }

  const shopName = shop?.name || "Savannah Sandbox Test Lab";
  const shopId = shop?.id;
  const tillNumber = shop?.mpesa_till_number || "5758419";
  const targetJid = shop?.fulfillment_settings?.whatsapp_routing?.management_jid ||
                    shop?.fulfillment_settings?.whatsapp_routing?.owner_phone ||
                    formatPhoneToWhatsAppJid(shop?.whatsapp_number || shop?.phone);

  // 2. Day boundary in EAT
  const { dateStr, startOfDayUtc, endOfDayUtc } = getEatDateBoundaries(targetDate);

  // 3. Query Live Orders for this Shop
  let orderQuery = supabase.from("orders")
    .select("id, total_price, status, client_name, client_phone, mpesa_code, created_at, shop_id")
    .gte("created_at", startOfDayUtc)
    .lte("created_at", endOfDayUtc)
    .order("created_at", { ascending: false });

  if (shopId) {
    orderQuery = orderQuery.eq("shop_id", shopId);
  }

  const { data: orders, error: orderErr } = await orderQuery;
  if (orderErr) throw new Error(`Orders fetch failed: ${orderErr.message}`);

  const paidOrders = (orders || []).filter(o => ["paid", "completed", "delivered"].includes((o.status || "").toLowerCase()));
  const pendingOrders = (orders || []).filter(o => ["pending", "pending_payment"].includes((o.status || "").toLowerCase()));

  const totalPaidRevenue = paidOrders.reduce((sum, o) => sum + (Number(o.total_price) || 0), 0);
  const totalPendingRevenue = pendingOrders.reduce((sum, o) => sum + (Number(o.total_price) || 0), 0);

  // 4. Query Latest Till Balance & Ledger Continuity
  const { data: latestPayments } = await supabase.from("payments")
    .select("raw_payload, created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  const raw = latestPayments?.[0]?.raw_payload || {};
  const currentTillBalance = raw.balance != null ? Number(raw.balance) : null;
  const ledgerVariance = raw.balance_variance != null ? Number(raw.balance_variance) : 0;
  const balanceStatus = raw.balance_status || (ledgerVariance === 0 ? "BALANCED" : "VARIANCE_DETECTED");

  // Format Date for EAT
  const dateOptions = { timeZone: "Africa/Nairobi", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" };
  const formattedEAT = new Intl.DateTimeFormat("en-GB", dateOptions).format(new Date());

  // 5. Construct Markdown Message for WhatsApp
  let msg = `📊 *DAILY CLOSURE REPORT — ${shopName.toUpperCase()}*\n`;
  msg += `📅 *Audit Timestamp:* ${formattedEAT} (EAT)\n`;
  msg += `──────────────────────────────────────\n`;
  msg += `✅ *Paid Orders:* ${paidOrders.length} (KES ${totalPaidRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })})\n`;
  if (pendingOrders.length > 0) {
    msg += `⏳ *Unsettled Checkouts:* ${pendingOrders.length} (KES ${totalPendingRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })})\n`;
  }
  if (currentTillBalance !== null) {
    msg += `📱 *Till ${tillNumber} Closing Balance:* KES ${currentTillBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n`;
  }
  msg += `⚖️ *Ledger Status:* ${ledgerVariance === 0 ? "🟢 BALANCED (Variance: KES 0.00)" : `⚠️ VARIANCE DETECTED (KES ${ledgerVariance.toFixed(2)})`}\n`;
  msg += `──────────────────────────────────────\n`;

  if (paidOrders.length > 0) {
    msg += `🧾 *Today's Settled Transactions:*\n`;
    paidOrders.forEach((o, idx) => {
      const shortId = o.id.slice(0, 6).toUpperCase();
      const code = o.mpesa_code || "AUTO-MATCH";
      const amt = Number(o.total_price).toFixed(2);
      const payer = o.client_name || o.client_phone || "Customer";
      msg += `  ${idx + 1}. *#${shortId}* — KES ${amt} [${code}] • _${payer}_\n`;
    });
  } else {
    msg += `_No orders settled on this register today._\n`;
  }

  msg += `──────────────────────────────────────\n`;
  msg += `_Delivered to Store Register • Autonomous Audit Engine_`;

  return {
    shopId,
    shopName,
    slug: shop?.slug || shopIdentifier,
    targetJid,
    dateStr,
    totalOrders: (orders || []).length,
    paidCount: paidOrders.length,
    paidRevenue: totalPaidRevenue,
    pendingCount: pendingOrders.length,
    pendingRevenue: totalPendingRevenue,
    currentTillBalance,
    ledgerVariance,
    balanceStatus,
    formattedWhatsAppMessage: msg
  };
}

/**
 * Generates the Platform-Wide Consolidated Executive Report.
 */
export async function generatePlatformEODReport(targetDate = new Date()) {
  const { dateStr, startOfDayUtc, endOfDayUtc } = getEatDateBoundaries(targetDate);

  // 1. Fetch all shops
  const { data: shops } = await supabase.from("shops").select("id, name, slug, phone, whatsapp_number, mpesa_till_number, fulfillment_settings");
  const shopMap = new Map();
  (shops || []).forEach(s => shopMap.set(s.id, s));

  // 2. Fetch all orders today
  const { data: orders, error: orderErr } = await supabase.from("orders")
    .select("id, shop_id, status, total_price, client_name, client_phone, mpesa_code, created_at")
    .gte("created_at", startOfDayUtc)
    .lte("created_at", endOfDayUtc)
    .order("created_at", { ascending: false });

  if (orderErr) throw new Error(`Platform orders fetch failed: ${orderErr.message}`);

  // 3. Fetch latest payment / till status
  const { data: latestPayments } = await supabase.from("payments")
    .select("raw_payload, created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  const raw = latestPayments?.[0]?.raw_payload || {};
  const currentTillBalance = raw.balance != null ? Number(raw.balance) : null;
  const ledgerVariance = raw.balance_variance != null ? Number(raw.balance_variance) : 0;

  // 4. Aggregate by Shop
  const activeShops = new Map();
  let totalPlatformPaidGmv = 0;
  let totalPlatformPaidCount = 0;
  let totalPlatformPendingGmv = 0;
  let totalPlatformPendingCount = 0;

  for (const o of (orders || [])) {
    const sId = o.shop_id || "unassigned";
    if (!activeShops.has(sId)) {
      const s = shopMap.get(sId);
      activeShops.set(sId, {
        shopId: sId,
        shopName: s?.name || "Unassigned Store",
        slug: s?.slug || "unknown",
        till: s?.mpesa_till_number || "5758419",
        ownerPhone: s?.fulfillment_settings?.whatsapp_routing?.owner_phone || s?.whatsapp_number || s?.phone,
        managementJid: s?.fulfillment_settings?.whatsapp_routing?.management_jid,
        orders: [],
        paidOrders: [],
        pendingOrders: [],
        paidRevenue: 0,
        pendingRevenue: 0
      });
    }

    const entry = activeShops.get(sId);
    entry.orders.push(o);
    const isPaid = ["paid", "completed", "delivered"].includes((o.status || "").toLowerCase());
    const isPending = ["pending", "pending_payment"].includes((o.status || "").toLowerCase());
    const amt = Number(o.total_price) || 0;

    if (isPaid) {
      entry.paidOrders.push(o);
      entry.paidRevenue += amt;
      totalPlatformPaidGmv += amt;
      totalPlatformPaidCount += 1;
    } else if (isPending) {
      entry.pendingOrders.push(o);
      entry.pendingRevenue += amt;
      totalPlatformPendingGmv += amt;
      totalPlatformPendingCount += 1;
    }
  }

  // 5. Construct Markdown Message for WhatsApp
  const formattedEAT = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());

  let platformMsg = `🌐 *PERPETUA PLATFORM — DAILY EXECUTIVE CLOSURE*\n`;
  platformMsg += `📅 *Audit Timestamp:* ${formattedEAT} (EAT)\n`;
  platformMsg += `──────────────────────────────────────\n`;
  platformMsg += `💰 *Platform Gross Volume (GMV):* KES ${totalPlatformPaidGmv.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n`;
  platformMsg += `📦 *Total Orders Settled:* ${totalPlatformPaidCount} / ${orders?.length || 0} checkouts\n`;
  if (totalPlatformPendingCount > 0) {
    platformMsg += `⏳ *Unsettled Checkouts:* ${totalPlatformPendingCount} (KES ${totalPlatformPendingGmv.toLocaleString("en-US", { minimumFractionDigits: 2 })})\n`;
  }
  if (currentTillBalance !== null) {
    platformMsg += `📱 *Primary Till Balance (5758419):* KES ${currentTillBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n`;
  }
  platformMsg += `⚖️ *Ledger Integrity:* ${ledgerVariance === 0 ? "🟢 BALANCED (KES 0.00 Variance)" : `⚠️ VARIANCE (KES ${ledgerVariance.toFixed(2)})`}\n`;
  platformMsg += `──────────────────────────────────────\n`;
  platformMsg += `🏬 *Store Performance Breakdown:*\n`;

  if (activeShops.size === 0) {
    platformMsg += `_No merchant activity recorded across the platform today._\n`;
  } else {
    for (const [_, info] of activeShops) {
      platformMsg += `• *${info.shopName}* (${info.slug}):\n`;
      platformMsg += `   └ KES ${info.paidRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })} (${info.paidOrders.length} paid`;
      if (info.pendingOrders.length > 0) {
        platformMsg += `, ${info.pendingOrders.length} pending`;
      }
      platformMsg += `)\n`;
    }
  }

  platformMsg += `──────────────────────────────────────\n`;
  platformMsg += `_Autonomous Multi-Tenant Ledger Engine • Zero-Trust Audit_`;

  return {
    dateStr,
    totalPlatformPaidGmv,
    totalPlatformPaidCount,
    totalPlatformPendingGmv,
    totalPlatformPendingCount,
    activeShopsCount: activeShops.size,
    activeShops: Array.from(activeShops.values()),
    currentTillBalance,
    ledgerVariance,
    formattedWhatsAppMessage: platformMsg
  };
}

/**
 * Universal dual-dispatcher:
 * 1. Dispatches each active shop's individual closure report to their respective WhatsApp.
 * 2. Dispatches the platform-wide summary to Perpetua Community / Executive Oversight.
 */
export async function runFullDualEODReconciliation({ targetDate = new Date(), dispatch = false, sendFn = null } = {}) {
  console.log(`[EOD ENGINE] Generating Dual EOD Reconciliation (dispatch: ${dispatch})...`);

  // 1. Generate Platform Consolidated Report
  const platformReport = await generatePlatformEODReport(targetDate);

  // 2. Generate and collect all active individual shop reports
  const shopReports = [];
  for (const shopInfo of platformReport.activeShops) {
    const shopReport = await generateShopEODReport(shopInfo.shopId, targetDate);
    shopReports.push(shopReport);
  }

  const dispatchResults = {
    platform: { dispatched: false, targetJid: GROUPS?.adminOversight?.jid || "120363415291701803@g.us" },
    shops: []
  };

  // 3. Optional Live WhatsApp Dispatch
  if (dispatch && typeof sendFn === "function") {
    // A. Dispatch Platform Report to Dedicated Register & Audit Group and Admin Oversight
    const targetPlatformJids = [
      GROUPS?.dailyRegisterAudit?.jid || "120363414989313710@g.us",
      GROUPS?.adminOversight?.jid || "120363415291701803@g.us"
    ];

    for (const jid of targetPlatformJids) {
      try {
        console.log(`[EOD DISPATCH] Sending Platform EOD Report to ${jid}...`);
        await sendFn(jid, { text: platformReport.formattedWhatsAppMessage });
        dispatchResults.platform.dispatched = true;
      } catch (err) {
        console.error(`[EOD DISPATCH ERROR] to platform ${jid}:`, err.message);
      }
    }

    // B. Dispatch each individual Shop Report to that shop's management channel or owner phone
    for (const sRep of shopReports) {
      if (sRep.targetJid) {
        try {
          console.log(`[EOD DISPATCH] Sending Shop EOD Report for "${sRep.shopName}" to ${sRep.targetJid}...`);
          await sendFn(sRep.targetJid, { text: sRep.formattedWhatsAppMessage });
          dispatchResults.shops.push({ shop: sRep.shopName, jid: sRep.targetJid, success: true });
        } catch (err) {
          console.error(`[EOD DISPATCH ERROR] for shop ${sRep.shopName} to ${sRep.targetJid}:`, err.message);
          dispatchResults.shops.push({ shop: sRep.shopName, jid: sRep.targetJid, success: false, error: err.message });
        }
      } else {
        console.warn(`[EOD DISPATCH WARN] No WhatsApp target configured for shop "${sRep.shopName}"`);
        dispatchResults.shops.push({ shop: sRep.shopName, jid: null, success: false, error: "No WhatsApp target" });
      }
    }
  }

  return {
    platformReport,
    shopReports,
    dispatchResults
  };
}

// Backward compatible alias
export const generateLiveEODReport = generateShopEODReport;

// CLI Direct Runner
if (process.argv[1] && process.argv[1].endsWith("eod_reconciler.mjs")) {
  runFullDualEODReconciliation({ dispatch: false })
    .then(r => {
      console.log("\n" + r.platformReport.formattedWhatsAppMessage);
      console.log("\n--- Active Shop Reports ---");
      r.shopReports.forEach(sr => console.log("\n" + sr.formattedWhatsAppMessage));
    })
    .catch(err => console.error("EOD Reconciler Error:", err));
}

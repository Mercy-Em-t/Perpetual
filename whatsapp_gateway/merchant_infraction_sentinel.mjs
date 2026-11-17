/**
 * Merchant Infraction & SLA Governance Sentinel
 * =============================================
 * Autonomous policy enforcement engine conforming to the Platform Operations Handbook:
 *
 * 1. Rule 1 (Operational SLA): 3 unfulfilled / cancelled orders in 7 days
 *    -> Temporary catalog suspension (24-hour review).
 * 2. Rule 2 (Quality & Chargeback): Refund rate > 4% of gross orders over 30 days
 *    -> Mandatory management review & probationary audit.
 *
 * Supports real-time trailing window scans, automated catalog toggling,
 * historical pilot test sweeps, and formatted WhatsApp executive dockets.
 */

import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROUPS } from "./config.mjs";
import { getAllShops } from "./tenant_resolver.mjs";
import { getEatDateBoundaries } from "./eod_reconciler.mjs";

const dbHdrs = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

export const SLA_THRESHOLDS = {
  unfulfilled7dCritical: 3,      // 3 unfulfilled/cancelled in 7 days -> Suspension
  unfulfilled7dWarning: 2,       // 2 unfulfilled in 7 days -> Warning
  refundRate30dCriticalPercent: 4.0, // > 4.0% refund rate -> Mandatory Review
  minOrderCountForRefundRate: 1   // Minimum orders to evaluate rate
};

/**
 * Sweeps all shops or a specific tenant for SLA infractions.
 */
export async function runMerchantInfractionAudit({
  auditAllTime = false,
  autoSuspend = false,
  targetShopSlug = null,
  actorName = "InfractionSentinel"
} = {}) {
  const allShops = await getAllShops(true);
  const targetShops = targetShopSlug
    ? allShops.filter(s => s.slug?.toLowerCase() === targetShopSlug.toLowerCase() || s.name?.toLowerCase().includes(targetShopSlug.toLowerCase()))
    : allShops;

  if (targetShops.length === 0) {
    return {
      success: false,
      error: `Shop "${targetShopSlug}" not found in registered directory.`
    };
  }

  // Fetch all orders
  const ordersRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=id,shop_id,status,total_price,client_name,client_phone,notes,created_at&order=created_at.desc`, { headers: dbHdrs });
  if (!ordersRes.ok) {
    throw new Error(`Failed to query orders from Supabase: ${ordersRes.statusText}`);
  }
  const allOrders = (await ordersRes.json()) || [];

  const now = Date.now();
  const MS_7D = 7 * 24 * 60 * 60 * 1000;
  const MS_30D = 30 * 24 * 60 * 60 * 1000;

  const results = [];
  const suspensionsTriggered = [];

  for (const shop of targetShops) {
    const shopOrders = allOrders.filter(o => o.shop_id === shop.id);

    // Filter by temporal window (or all time if requested for test sweeps)
    const orders7d = auditAllTime
      ? shopOrders
      : shopOrders.filter(o => now - new Date(o.created_at).getTime() <= MS_7D);

    const orders30d = auditAllTime
      ? shopOrders
      : shopOrders.filter(o => now - new Date(o.created_at).getTime() <= MS_30D);

    // Unfulfilled orders in 7 days: expired, cancelled, abandoned, or refunded
    const unfulfilled7d = orders7d.filter(o =>
      o.status === "expired" ||
      o.status === "cancelled" ||
      o.status === "abandoned" ||
      o.status === "refunded" ||
      (o.notes && /(?:unfulfilled|cancelled|refund|spoiled|cold)/i.test(o.notes))
    );

    // Refunded / disputed orders in 30 days
    const refunded30d = orders30d.filter(o =>
      o.status === "refunded" ||
      (o.notes && /(?:refund|voucher issued|dispute)/i.test(o.notes))
    );

    const paid30d = orders30d.filter(o => o.status === "paid" || o.status === "dispatched");
    const total30d = orders30d.length;

    // Refund rate: (refunded / total orders) * 100
    const refundRate = total30d > 0
      ? ((refunded30d.length / total30d) * 100)
      : 0;

    // Evaluate Rule 1: 3 unfulfilled in 7 days
    let rule1State = "COMPLIANT";
    if (unfulfilled7d.length >= SLA_THRESHOLDS.unfulfilled7dCritical) {
      rule1State = "BREACH_CRITICAL";
    } else if (unfulfilled7d.length >= SLA_THRESHOLDS.unfulfilled7dWarning) {
      rule1State = "WARNING_AT_RISK";
    }

    // Evaluate Rule 2: Refund rate > 4% in 30 days
    let rule2State = "COMPLIANT";
    if (total30d >= SLA_THRESHOLDS.minOrderCountForRefundRate && refundRate > SLA_THRESHOLDS.refundRate30dCriticalPercent) {
      rule2State = "BREACH_CRITICAL";
    }

    const hasBreach = rule1State === "BREACH_CRITICAL" || rule2State === "BREACH_CRITICAL";
    const hasWarning = rule1State === "WARNING_AT_RISK";

    // Auto-suspension execution if requested and breached
    let autoSuspendedNow = false;
    if (autoSuspend && rule1State === "BREACH_CRITICAL" && shop.is_active) {
      try {
        await suspendShopCatalog(shop.id, `${unfulfilled7d.length} unfulfilled orders in 7 days`, actorName);
        autoSuspendedNow = true;
        suspensionsTriggered.push(shop.name);
      } catch (err) {
        console.error(`[INFRACTION SENTINEL] Auto-suspend failed for ${shop.name}:`, err.message);
      }
    }

    results.push({
      shopId: shop.id,
      shopName: shop.name,
      shopSlug: shop.slug,
      isActive: shop.is_active,
      totalOrdersLifetime: shopOrders.length,
      orders7dCount: orders7d.length,
      unfulfilled7dCount: unfulfilled7d.length,
      unfulfilled7dOrders: unfulfilled7d.map(o => ({
        id: o.id,
        shortId: o.id.slice(0, 8),
        status: o.status,
        amount: Number(o.total_price || 0),
        client: o.client_name || "Customer",
        notes: o.notes || ""
      })),
      orders30dCount: total30d,
      refunded30dCount: refunded30d.length,
      paid30dCount: paid30d.length,
      refundRatePercent: parseFloat(refundRate.toFixed(1)),
      rule1State,
      rule2State,
      hasBreach,
      hasWarning,
      autoSuspendedNow
    });
  }

  // Sort: Critical breaches first, then warnings, then compliant
  results.sort((a, b) => {
    if (a.hasBreach && !b.hasBreach) return -1;
    if (!a.hasBreach && b.hasBreach) return 1;
    if (a.hasWarning && !b.hasWarning) return -1;
    if (!a.hasWarning && b.hasWarning) return 1;
    return b.unfulfilled7dCount - a.unfulfilled7dCount;
  });

  const formattedWhatsAppMessage = formatInfractionDocketCard(results, auditAllTime, autoSuspend);

  return {
    success: true,
    scannedAt: new Date().toISOString(),
    auditMode: auditAllTime ? "ALL_TIME_SWEEP" : "TRAILING_SLA_WINDOW",
    totalShopsScanned: targetShops.length,
    breachCount: results.filter(r => r.hasBreach).length,
    warningCount: results.filter(r => r.hasWarning).length,
    suspensionsTriggered,
    results,
    formattedWhatsAppMessage
  };
}

/**
 * Formats a high-density, actionable WhatsApp Decision Docket
 */
export function formatInfractionDocketCard(results, isAllTime = false, autoSuspended = false) {
  const breaches = results.filter(r => r.hasBreach);
  const warnings = results.filter(r => r.hasWarning && !r.hasBreach);
  const compliant = results.filter(r => !r.hasBreach && !r.hasWarning);

  const timeLabel = new Date().toLocaleString("en-GB", {
    timeZone: "Africa/Nairobi",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });

  let card = `🛡️ *MERCHANT INFRACTION & SLA GOVERNANCE DOCKET*\n`;
  card += `_Audit: ${timeLabel} EAT • Mode: ${isAllTime ? "Complete Historical Sweep" : "Trailing 7D/30D Window"}_\n\n`;

  card += `📊 *PLATFORM HEALTH*\n`;
  card += `• Tenants Audited: *${results.length} Stores*\n`;
  card += `• SLA Governance: *${breaches.length} Critical Breaches* | *${warnings.length} Warnings*\n\n`;

  if (breaches.length > 0) {
    card += `🚨 *CRITICAL SLA BREACHES (ACTION REQUIRED)*\n\n`;
    breaches.forEach((b, i) => {
      const activeBadge = b.isActive ? "🟢 Active" : "🔴 Suspended";
      card += `*${i + 1}. ${b.shopName}* (\`${b.shopSlug}\`) [${activeBadge}]\n`;

      if (b.rule1State === "BREACH_CRITICAL") {
        card += `   • 7-Day Unfulfilled: *${b.unfulfilled7dCount} Orders* (Threshold: ≥ 3 in 7d)\n`;
        const ids = b.unfulfilled7dOrders.slice(0, 3).map(o => `#${o.shortId}`).join(", ");
        card += `     _Flagged Orders:_ ${ids}\n`;
        card += `     _SLA Penalty:_ Temporary Catalog Suspension (24-Hour Review)\n`;
      }

      if (b.rule2State === "BREACH_CRITICAL") {
        card += `   • Refund Rate: *${b.refundRatePercent}%* (${b.refunded30dCount}/${b.orders30dCount} orders) [Threshold: > 4%]\n`;
        card += `     _SLA Penalty:_ Mandatory Executive Audit & Meeting\n`;
      }

      if (b.autoSuspendedNow) {
        card += `   • 🛑 _ACTION:_ Catalog automatically marked INACTIVE.\n`;
      }
      card += `\n`;
    });
  }

  if (warnings.length > 0) {
    card += `🟡 *STORES AT RISK (APPROACHING LIMIT)*\n\n`;
    warnings.forEach((w, i) => {
      card += `*${i + 1}. ${w.shopName}* (\`${w.shopSlug}\`)\n`;
      card += `   • Unfulfilled: *${w.unfulfilled7dCount} / 3 orders* (1 more triggers suspension)\n\n`;
    });
  }

  if (compliant.length > 0) {
    card += `🟢 *COMPLIANT STORES (${compliant.length})*\n`;
    const names = compliant.slice(0, 6).map(c => `• ${c.shopName}`).join("\n");
    card += `${names}\n`;
    if (compliant.length > 6) {
      card += `_...and ${compliant.length - 6} other compliant stores._\n\n`;
    } else {
      card += `\n`;
    }
  }

  card += `⚡ *ADMIN SHORTCUTS*\n`;
  if (breaches.length > 0) {
    const firstBreach = breaches[0];
    card += `• \`!suspend ${firstBreach.shopSlug} 3 unfulfilled orders\`\n`;
    card += `• \`!reinstate ${firstBreach.shopSlug} Resolved with merchant\`\n`;
  }
  card += `• \`!infractions <slug>\` — Drill down single store\n`;
  card += `• \`!infractions all\` — Sweep entire platform`;

  return card;
}

/**
 * Suspends a shop's catalog and marks it inactive in Supabase
 */
export async function suspendShopCatalog(shopIdOrSlug, reason = "Quality SLA Infraction Review", actorName = "Admin") {
  const allShops = await getAllShops(true);
  const matched = allShops.find(s => s.id === shopIdOrSlug || s.slug?.toLowerCase() === shopIdOrSlug.toLowerCase());

  if (!matched) {
    throw new Error(`Shop "${shopIdOrSlug}" not found.`);
  }

  const currentSettings = matched.fulfillment_settings || {};
  const updatedSettings = {
    ...currentSettings,
    quality_suspension: {
      is_suspended: true,
      reason,
      suspended_at: new Date().toISOString(),
      suspended_by: actorName,
      review_deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }
  };

  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${matched.id}`, {
    method: "PATCH",
    headers: { ...dbHdrs, "Prefer": "return=minimal" },
    body: JSON.stringify({
      is_active: false,
      is_online: false,
      fulfillment_settings: updatedSettings
    })
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => "");
    throw new Error(`Failed to update shop active status: ${errText}`);
  }

  // Refresh cache
  await getAllShops(true);

  return {
    success: true,
    shopId: matched.id,
    shopName: matched.name,
    shopSlug: matched.slug,
    is_active: false,
    reason,
    merchantSettings: updatedSettings,
    targetJids: [
      currentSettings.whatsapp_routing?.operations_jid,
      currentSettings.whatsapp_routing?.management_jid,
      currentSettings.whatsapp_routing?.owner_phone ? (currentSettings.whatsapp_routing.owner_phone.includes("@") ? currentSettings.whatsapp_routing.owner_phone : `${currentSettings.whatsapp_routing.owner_phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`) : null,
      matched.whatsapp_number ? `${matched.whatsapp_number.replace(/[^0-9]/g, "")}@s.whatsapp.net` : null
    ].filter(Boolean)
  };
}

/**
 * Reinstates a shop's catalog and re-enables it
 */
export async function reinstateShopCatalog(shopIdOrSlug, reason = "Management review approved", actorName = "Admin") {
  const allShops = await getAllShops(true);
  const matched = allShops.find(s => s.id === shopIdOrSlug || s.slug?.toLowerCase() === shopIdOrSlug.toLowerCase());

  if (!matched) {
    throw new Error(`Shop "${shopIdOrSlug}" not found.`);
  }

  const currentSettings = matched.fulfillment_settings || {};
  const updatedSettings = {
    ...currentSettings,
    quality_suspension: {
      is_suspended: false,
      reinstated_at: new Date().toISOString(),
      reinstated_by: actorName,
      reason
    }
  };

  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${matched.id}`, {
    method: "PATCH",
    headers: { ...dbHdrs, "Prefer": "return=minimal" },
    body: JSON.stringify({
      is_active: true,
      is_online: true,
      fulfillment_settings: updatedSettings
    })
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => "");
    throw new Error(`Failed to reinstate shop: ${errText}`);
  }

  // Refresh cache
  await getAllShops(true);

  return {
    success: true,
    shopId: matched.id,
    shopName: matched.name,
    shopSlug: matched.slug,
    is_active: true,
    reason,
    merchantSettings: updatedSettings,
    targetJids: [
      currentSettings.whatsapp_routing?.operations_jid,
      currentSettings.whatsapp_routing?.management_jid,
      currentSettings.whatsapp_routing?.owner_phone ? (currentSettings.whatsapp_routing.owner_phone.includes("@") ? currentSettings.whatsapp_routing.owner_phone : `${currentSettings.whatsapp_routing.owner_phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`) : null,
      matched.whatsapp_number ? `${matched.whatsapp_number.replace(/[^0-9]/g, "")}@s.whatsapp.net` : null
    ].filter(Boolean)
  };
}

/**
 * Records merchant remediation notes submitted by merchant operator
 */
export async function submitMerchantRemediation(shopIdOrSlug, notes = "", actorName = "Merchant", senderId = "") {
  const allShops = await getAllShops(true);
  const matched = allShops.find(s => s.id === shopIdOrSlug || s.slug?.toLowerCase() === shopIdOrSlug.toLowerCase());

  if (!matched) {
    throw new Error(`Shop "${shopIdOrSlug}" not found.`);
  }

  const currentSettings = matched.fulfillment_settings || {};
  const suspensionInfo = currentSettings.quality_suspension || { is_suspended: !matched.is_active };

  const updatedSettings = {
    ...currentSettings,
    quality_suspension: {
      ...suspensionInfo,
      remediation_submission: {
        submitted_at: new Date().toISOString(),
        submitted_by: senderId,
        actor_name: actorName,
        notes,
        status: "PENDING_MANAGER_REVIEW"
      }
    }
  };

  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${matched.id}`, {
    method: "PATCH",
    headers: { ...dbHdrs, "Prefer": "return=minimal" },
    body: JSON.stringify({
      fulfillment_settings: updatedSettings
    })
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => "");
    throw new Error(`Failed to submit remediation: ${errText}`);
  }

  await getAllShops(true);

  return {
    success: true,
    shopId: matched.id,
    shopName: matched.name,
    shopSlug: matched.slug,
    notes,
    actorName
  };
}

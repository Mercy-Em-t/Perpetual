/**
 * Ghost Payment Watcher Sentinel
 * ===============================
 * Automatically monitors provisionally cleared orders and alerts management
 * if the official Safaricom Till SMS fails to arrive within 60 minutes.
 * 
 * Enforces Zero Ghost Payments:
 * 1. Checks orders where status='paid' and internal_status='PROVISIONALLY_CLEARED'.
 * 2. If unseconded after 60 minutes, flags internal_status='GHOST_PAYMENT_SUSPECT'.
 * 3. Dispatches high-priority WhatsApp warnings to Finance Audit & Executive Oversight.
 */

import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROUPS } from "./config.mjs";

const DEFAULT_GHOST_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const CHECK_INTERVAL_MS = 5 * 60 * 1000;         // Check every 5 minutes

const dbHdrs = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

let watcherTimer = null;
let lastCheckTime = 0;

/**
 * Scans Supabase for unseconded provisional orders older than timeoutMs.
 */
export async function scanForGhostPayments({
  timeoutMs = DEFAULT_GHOST_TIMEOUT_MS,
  safeSendMessage = null
} = {}) {
  lastCheckTime = Date.now();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[GHOST SENTINEL] Missing Supabase credentials; skipping scan.");
    return { count: 0, suspects: [] };
  }

  const cutoffTime = new Date(Date.now() - timeoutMs).toISOString();

  try {
    // Query orders that were provisionally cleared but never transitioned to FULLY_SECONDED
    const queryUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&internal_status=eq.PROVISIONALLY_CLEARED&updated_at=lte.${cutoffTime}&select=id,shop_id,total_price,client_phone,client_name,created_at,updated_at,mpesa_code,internal_status,notes`;
    const res = await fetch(queryUrl, { headers: dbHdrs });
    if (!res.ok) {
      console.warn(`[GHOST SENTINEL] Query failed (${res.status}): ${await res.text()}`);
      return { count: 0, suspects: [] };
    }

    const suspects = await res.json();
    if (!Array.isArray(suspects) || suspects.length === 0) {
      return { count: 0, suspects: [] };
    }

    console.log(`[GHOST SENTINEL] Found ${suspects.length} unseconded order(s) past ${Math.round(timeoutMs / 60000)}m timeout.`);

    for (const order of suspects) {
      // Avoid spamming if alert was already stamped in notes
      if (order.notes && order.notes.includes("GHOST_PAYMENT_WARNED")) {
        continue;
      }

      const elapsedMins = Math.round((Date.now() - new Date(order.updated_at || order.created_at).getTime()) / 60000);
      const shortId = order.id.slice(0, 8).toUpperCase();
      const code = order.mpesa_code || "UNKNOWN";
      const amount = Number(order.total_price || 0).toFixed(2);
      const customer = order.client_name || "Customer";
      const phone = order.client_phone || "N/A";

      // 1. Mark order as GHOST_PAYMENT_SUSPECT and stamp notes
      const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      const warningTag = `• [${timeStr} GHOST-SENTINEL]: Unseconded after ${elapsedMins}m. Flagged GHOST_PAYMENT_WARNED.`;
      const newNotes = order.notes ? `${order.notes}\n${warningTag}` : warningTag;

      await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
        method: "PATCH",
        headers: { ...dbHdrs, Prefer: "return=minimal" },
        body: JSON.stringify({
          internal_status: "GHOST_PAYMENT_SUSPECT",
          notes: newNotes
        })
      });

      // 2. Dispatch WhatsApp Alert to Finance Audit & Executive Oversight
      if (safeSendMessage) {
        const alertCard =
          `🚨 *[GHOST PAYMENT WARNING — TILL SMS MISSING (${elapsedMins}m)]*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `• *Order:* #${shortId} (${customer})\n` +
          `• *Amount:* KES ${amount}\n` +
          `• *Claimed M-Pesa Code:* \`${code}\`\n` +
          `• *Customer Phone:* ${phone}\n` +
          `• *Cleared Provisionally:* ${elapsedMins} minutes ago\n` +
          `• *Status:* ⚠️ NO OFFICIAL SAFARICOM TILL SMS RECORDED\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `⚡ *Immediate Action Required:*\n` +
          `1. Check the physical Till phone statement for receipt \`${code}\`.\n` +
          `2. If missing, contact customer at ${phone} to request the original SMS.\n` +
          `3. If verified on statement, second manually: \`!second ${shortId} ${code}\``;

        const targetJids = [
          GROUPS?.dailyRegisterAudit?.jid,
          GROUPS?.adminOversight?.jid,
          GROUPS?.itHelpdesk?.jid,
          GROUPS?.general?.jid
        ].filter(Boolean);

        for (const jid of targetJids) {
          try {
            await safeSendMessage(jid, { text: alertCard });
          } catch (sendErr) {
            console.warn(`[GHOST SENTINEL] Failed to alert ${jid}:`, sendErr.message);
          }
        }
      }
    }

    return { count: suspects.length, suspects };
  } catch (err) {
    console.error("[GHOST SENTINEL ERROR]", err);
    return { count: 0, error: err.message };
  }
}

/**
 * Starts the continuous Ghost Payment Sentinel background poller.
 */
export function startGhostPaymentSentinel(safeSendMessage, intervalMs = CHECK_INTERVAL_MS) {
  if (watcherTimer) clearInterval(watcherTimer);
  console.log(`[GHOST SENTINEL] Started daemon (Interval: ${Math.round(intervalMs / 1000)}s, Timeout: 60m).`);
  
  // Initial check after 30 seconds
  setTimeout(() => {
    scanForGhostPayments({ safeSendMessage }).catch(() => {});
  }, 30000);

  watcherTimer = setInterval(() => {
    scanForGhostPayments({ safeSendMessage }).catch(() => {});
  }, intervalMs);

  return watcherTimer;
}

export function stopGhostPaymentSentinel() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}

/**
 * customer_notifier.mjs
 * =====================
 * Autonomous WhatsApp Order Confirmation Engine for Customers.
 * 
 * Delivers immediate transactional proof to the customer's personal WhatsApp
 * the instant /api/till/receipt or Supabase marks their order as PAID.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAllShops } from "./tenant_resolver.mjs";
import { formatPhoneToWhatsAppJid } from "./eod_reconciler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
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

const supabase = createClient(envUrl, envKey);

// Rolling deduplication cache (holds up to 1000 order IDs to prevent double confirmation)
const notifiedOrdersCache = new Set();

/**
 * Constructs the friendly customer-facing WhatsApp order confirmation message.
 */
export function buildCustomerConfirmationCard(order, shop) {
  const rawName = (order.client_name || "").trim();
  const firstName = rawName.split(/\s+/)[0] || "Customer";
  const capitalizedName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

  const shortRef = (order.id || "").slice(0, 6).toUpperCase();
  const mpesaRef = order.mpesa_code || "PAID";
  const totalAmt = Number(order.total_price || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const shopName = shop?.name || "Savannah Store";
  const shopSlug = shop?.slug || "test-shop";

  const trackingUrl = `https://updatedtms-whitelabel-core.vercel.app/s/${shopSlug}/track/${order.id}`;

  let text = `Hi ${capitalizedName}! 🎉 Payment *KES ${totalAmt}* received (Ref: \`${mpesaRef}\`).\n\n`;
  text += `Your *${shopName}* order *#${shortRef}* is confirmed and is being prepared.\n\n`;
  text += `📍 *Track your order here in real-time:*\n${trackingUrl}\n\n`;
  text += `_Thank you for choosing ${shopName}!_`;

  return text;
}

/**
 * Dispatches an instant confirmation to the customer's personal WhatsApp.
 */
export async function sendCustomerOrderConfirmation(orderOrId, sendFn) {
  if (!orderOrId || typeof sendFn !== "function") return null;

  try {
    let order = orderOrId;
    if (typeof orderOrId === "string") {
      const { data, error } = await supabase
        .from("orders")
        .select("id, client_name, client_phone, total_price, status, mpesa_code, shop_id, created_at")
        .eq("id", orderOrId)
        .maybeSingle();

      if (error || !data) {
        console.warn(`[CUSTOMER NOTIFIER] Could not find order ${orderOrId}:`, error?.message);
        return null;
      }
      order = data;
    }

    if (notifiedOrdersCache.has(order.id)) {
      console.log(`[CUSTOMER NOTIFIER] Order ${order.id} already received confirmation (cached). Skipping.`);
      return { skipped: true, reason: "ALREADY_NOTIFIED" };
    }

    // Resolve Customer WhatsApp JID
    const phone = order.client_phone;
    const customerJid = formatPhoneToWhatsAppJid(phone);
    if (!customerJid) {
      console.warn(`[CUSTOMER NOTIFIER] Order ${order.id} has invalid client_phone: "${phone}"`);
      return { skipped: true, reason: "INVALID_PHONE" };
    }

    // Resolve Shop
    const shops = await getAllShops();
    const shop = (shops || []).find(s => s.id === order.shop_id) || null;

    const message = buildCustomerConfirmationCard(order, shop);

    console.log(`[CUSTOMER NOTIFIER] Sending confirmation to customer ${customerJid} for Order #${order.id.slice(0, 6)}...`);
    const sendResult = await sendFn(customerJid, { text: message });

    if (sendResult) {
      notifiedOrdersCache.add(order.id);
      if (notifiedOrdersCache.size > 2000) {
        const oldest = notifiedOrdersCache.values().next().value;
        notifiedOrdersCache.delete(oldest);
      }

      // Log to events table
      try {
        await supabase.from("events").insert({
          shop_id: order.shop_id || "345ca611-9e1d-4c8f-97ec-d7416a2d97d7",
          event_type: "customer_order_confirmation_sent",
          device_id: "whatsapp_perpetual_gateway",
          device_info: {
            order_id: order.id,
            customer_phone: phone,
            customer_jid: customerJid,
            mpesa_code: order.mpesa_code,
            amount: order.total_price
          },
          timestamp: new Date().toISOString()
        });
      } catch (logErr) {
        console.warn("[CUSTOMER NOTIFIER LOG WARN]", logErr.message);
      }

      return { success: true, jid: customerJid, orderId: order.id, message };
    }

    return { success: false, error: "Send returned null" };
  } catch (err) {
    console.error("[CUSTOMER NOTIFIER ERROR]", err);
    return { success: false, error: err.message };
  }
}

/**
 * Initializes the Supabase Realtime Listener to automatically catch
 * ANY order settling to 'paid' across the entire platform.
 */
export function startRealtimePaymentSentinel(sendFn) {
  if (typeof sendFn !== "function") {
    console.warn("[PAYMENT SENTINEL] Cannot start: sendFn is missing.");
    return null;
  }

  console.log("[PAYMENT SENTINEL] 📡 Listening to Supabase Realtime orders for payment clearance...");

  const channel = supabase
    .channel("perpetual_customer_order_settlements")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "orders"
      },
      async (payload) => {
        const newOrder = payload.new;
        const oldOrder = payload.old;

        // Transition Guard: ONLY fire when the order transitions into 'paid'
        const isNowPaid = newOrder && ["paid", "completed"].includes((newOrder.status || "").toLowerCase());
        const wasAlreadyPaid = oldOrder && ["paid", "completed"].includes((oldOrder.status || "").toLowerCase());

        if (isNowPaid && !wasAlreadyPaid) {
          console.log(`[PAYMENT SENTINEL] ⚡ Order ${newOrder.id} transitioned to PAID! Triggering customer WhatsApp confirmation...`);
          await sendCustomerOrderConfirmation(newOrder, sendFn);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[PAYMENT SENTINEL] Realtime subscription status: ${status}`);
    });

  return channel;
}

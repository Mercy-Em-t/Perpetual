/**
 * ==============================================================================
 * TMS LEASED FEATURE - MESSAGE BROADCASTER & RECEIVER BRIDGE
 * ==============================================================================
 * 
 * Provides decoupled, real-time message broadcasting and receiving across
 * browser tabs, workers, and storefront components using native BroadcastChannel
 * with CustomEvent fallback.
 * 
 * Architecture:
 *   [Worker / Event Sender]
 *          │
 *          ▼ (receives payload)
 *   [broadcastLeaseMessage()]
 *          │
 *          ▼ (broadcasts across channel)
 *   [createLeaseReceiver()]
 *          │
 *          ▼
 *   [Receiver / Storefront Canvas] (drops or plugs chunks on the fly)
 * ==============================================================================
 */

const CHANNEL_NAME = "tms_lease_broadcast_channel";

/**
 * Broadcasts a message to all active receivers
 * @param {Object} message - { type, tenantId, chunkId, status, timestamp, details }
 */
export function broadcastLeaseMessage(message) {
  const payload = {
    reporter: message.reporter || "Lease Lifecycle Operator",
    ...message,
    id: message.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: message.timestamp || new Date().toISOString(),
  };

  // 1. Cross-Tab & Window Broadcast via BroadcastChannel API
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(payload);
      channel.close();
    } catch (err) {
      console.warn("BroadcastChannel error:", err);
    }
  }

  // 2. In-Window Broadcast via DOM CustomEvent
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("tms:lease:message", { detail: payload })
    );
  }

  // 3. Local IPC to Headless WhatsApp Gateway (Port 5174)
  // Guarded so automated Vitest unit tests or explicit `skipWhatsAppIpc` calls do not spam live WhatsApp
  const isAutomatedTestRun =
    typeof process !== "undefined" &&
    process?.env &&
    (process.env.VITEST === "true" || process.env.NODE_ENV === "test");

  if (
    typeof fetch !== "undefined" &&
    payload.type === "ORDER_PLACED" &&
    !payload.skipWhatsAppIpc &&
    !isAutomatedTestRun
  ) {
    const waBase =
      (typeof import.meta !== "undefined" && import.meta.env?.VITE_WHATSAPP_SERVICE_URL) ||
      (typeof process !== "undefined" && process?.env?.WHATSAPP_SERVICE_URL) ||
      "https://wa.tmsavannah.com";
    fetch(`${waBase.replace(/\/$/, "")}/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  return payload;
}

/**
 * Transforms a lease message into a clean tabular structure suitable for console.table or UI tables
 * @param {Object} msg - The lease message payload
 * @returns {Object} Tabulated representation
 */
export function tabulateLeaseMessage(msg) {
  return {
    "Message ID": msg.id || "N/A",
    "Reporter / Sender": msg.reporter || "Lease Lifecycle Operator",
    "Action / Type": msg.type || "UNKNOWN",
    "Tenant (Noun)": msg.tenantName ? `${msg.tenantName} (${msg.tenantId})` : (msg.tenantId || "ALL"),
    "Target Chunk (Object)": msg.chunkName || msg.chunkId || "N/A",
    "Lease Status": msg.status || "N/A",
    "Channel": "BroadcastChannel & CustomEvent",
    "Timestamp": msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString(),
    "Summary / Details": msg.summary || msg.details || ""
  };
}

/**
 * Prints one or more lease messages in a structured tabulated format
 * @param {Object|Array} messageOrList 
 */
export function logTabulatedReport(messageOrList) {
  const items = Array.isArray(messageOrList) ? messageOrList : [messageOrList];
  const tableData = items.map(tabulateLeaseMessage);
  if (typeof console !== "undefined" && console.table) {
    console.table(tableData);
  }
  return tableData;
}

/**
 * Creates a receiver subscriber that listens for incoming broadcast messages
 * @param {Function} onMessageReceived - Callback invoked when a message arrives
 * @returns {Function} unsubscribe - Function to disconnect the receiver
 */
export function createLeaseReceiver(onMessageReceived) {
  let broadcastChannel = null;

  // 1. Listen via BroadcastChannel (other tabs / background workers)
  if (typeof BroadcastChannel !== "undefined") {
    try {
      broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
      broadcastChannel.onmessage = (event) => {
        if (event.data && onMessageReceived) {
          onMessageReceived(event.data);
        }
      };
    } catch (err) {
      console.warn("Failed to create BroadcastChannel receiver:", err);
    }
  }

  // 2. Listen via DOM CustomEvent (current window)
  const domListener = (event) => {
    if (event.detail && onMessageReceived) {
      onMessageReceived(event.detail);
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("tms:lease:message", domListener);
  }

  // Return clean teardown function
  return function disconnectReceiver() {
    if (broadcastChannel) {
      broadcastChannel.close();
      broadcastChannel = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("tms:lease:message", domListener);
    }
  };
}

/**
 * ==============================================================================
 * BIDIRECTIONAL REQUEST-REPLY MESSAGE PROTOCOL (ACTOR MODEL)
 * ==============================================================================
 * Enables any caller (storefront cart, checkout, or admin UI) to send an
 * asynchronous message to a localized tenant module, and awaits the module's
 * reply without tight file/code imports.
 */

/**
 * Sends a message request to a tenant module and awaits its reply
 * @param {string} targetTenant - e.g. "leahs-kitchen", "brunchbox", etc.
 * @param {string} action - e.g. "EVALUATE_CUTOFF", "PROCESS_ORDER", "FETCH_MENU"
 * @param {Object} payload - Input payload for the action
 * @param {number} timeoutMs - Timeout before fallback resolution (default 3000ms)
 * @returns {Promise<Object>} The module's reply payload
 */
export async function sendModuleRequest(targetTenant, action, payload = {}, timeoutMs = 3000) {
  const correlationId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        resolve({
          success: false,
          timeout: true,
          error: `Request "${action}" to tenant "${targetTenant}" timed out after ${timeoutMs}ms.`
        });
      }
    }, timeoutMs);

    const unsubscribe = createLeaseReceiver((msg) => {
      if (msg.type === "MODULE_REPLY" && msg.correlationId === correlationId) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(msg.response || { success: true });
        }
      }
    });

    broadcastLeaseMessage({
      type: "MODULE_REQUEST",
      correlationId,
      targetTenant,
      action,
      payload
    });
  });
}

/**
 * Registers an autonomous handler for a specific tenant module
 * @param {string} tenantId - e.g. "leahs-kitchen"
 * @param {Function} handlerFn - async ({ action, payload, correlationId }) => response
 * @returns {Function} unsubscribe function
 */
export function registerModuleHandler(tenantId, handlerFn) {
  return createLeaseReceiver(async (msg) => {
    if (msg.type === "MODULE_REQUEST" && msg.targetTenant === tenantId && msg.correlationId) {
      try {
        const response = await handlerFn({
          action: msg.action,
          payload: msg.payload,
          correlationId: msg.correlationId
        });

        broadcastLeaseMessage({
          type: "MODULE_REPLY",
          correlationId: msg.correlationId,
          targetTenant: tenantId,
          action: msg.action,
          response: response || { success: true }
        });
      } catch (err) {
        broadcastLeaseMessage({
          type: "MODULE_REPLY",
          correlationId: msg.correlationId,
          targetTenant: tenantId,
          action: msg.action,
          response: { success: false, error: err.message || String(err) }
        });
      }
    }
  });
}


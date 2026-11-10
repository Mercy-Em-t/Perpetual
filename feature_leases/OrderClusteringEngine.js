/**
 * ==============================================================================
 * TMS LEASED FEATURE - ORDER CLUSTERING & EXECUTIVE PREP DIGEST ENGINE
 * ==============================================================================
 * Solves "Notification Fatigue" and empowers kitchen staff by consolidating
 * multiple clustered orders into an aggregated Executive Prep Summary Sheet.
 * 
 * Capabilities:
 * 1. Line Item Aggregation: Sums quantities across orders (e.g. "8x Coconut Stew").
 * 2. Dispatch Manifest: Organizes orders by collection gate, table, or delivery point.
 * 3. Financial Batch Totals: Computes total gross revenue for the cluster.
 * 4. WhatsApp Table Formatting: Emits WhatsApp-formatted monospace / box tables.
 * ==============================================================================
 */

/**
 * Aggregates a list of orders into a kitchen preparation & dispatch summary
 * @param {Object} options
 * @param {Array<Object>} options.orders - Array of order objects/metadata
 * @param {string} [options.shopName="Leah's Kitchen"] - Tenant or shop name
 * @param {string} [options.batchId] - Unique batch identifier
 * @returns {string} WhatsApp-formatted executive prep summary
 */
export function formatClusteredPrepDigest({ orders = [], shopName = "Leah's Kitchen", batchId = null }) {
  if (!orders || orders.length === 0) {
    return `ℹ️ *[${shopName.toUpperCase()}] BATCH SUMMARY: No orders in active window.*`;
  }

  const now = new Date();
  const timeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateFormatted = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const activeBatchId = batchId || `BATCH-${now.getTime().toString().slice(-6)}`;

  // 1. Aggregate Prep Quantities across all orders (Sorted highest qty first)
  const itemMap = new Map();
  let totalRevenue = 0;
  let totalPortionsAcrossBatch = 0;

  for (const order of orders) {
    const meta = order.metadata || order;
    const items = meta.items || [];
    const amount = Number(meta.totalAmount || meta.totalPrice || meta.total || 0);
    totalRevenue += amount;

    for (const item of items) {
      const name = item.name || "Special Item";
      const qty = Number(item.quantity || item.qty || 1);
      totalPortionsAcrossBatch += qty;
      const current = itemMap.get(name) || { qty: 0, price: Number(item.price || 0) };
      current.qty += qty;
      itemMap.set(name, current);
    }
  }

  const sortedDishes = Array.from(itemMap.entries()).sort((a, b) => b[1].qty - a[1].qty);

  // Build Mobile-First Stage 1 Kitchen Stove Cook Sheet (Zero horizontal wrap on phones)
  const prepLines = [];
  prepLines.push(`🔥 *STAGE 1 — KITCHEN PREP TOTALS (${totalPortionsAcrossBatch} Portions to Cook)*`);
  for (const [name, data] of sortedDishes) {
    prepLines.push(`• \`${data.qty}x\`  *${name}*`);
  }

  // 2. Build Stage 2 Customer Packing Slips (What to Pack for Who, Grouped by Gate)
  const packingSlips = generatePackingSlips(orders);
  const manifestLines = [];
  manifestLines.push(`🛍️ *STAGE 2 — CUSTOMER BAGS (${orders.length} Bags • Who Gets What)*`);

  // Group slips by collection gate so kitchen staff can pack gate-by-gate into delivery crates
  const gateGroups = new Map();
  for (const slip of packingSlips) {
    if (!gateGroups.has(slip.gate)) {
      gateGroups.set(slip.gate, []);
    }
    gateGroups.get(slip.gate).push(slip);
  }

  for (const [gate, slips] of gateGroups.entries()) {
    manifestLines.push("");
    manifestLines.push(`📍 *${gate.toUpperCase()} — ${slips.length} ${slips.length === 1 ? 'Bag' : 'Bags'}*`);
    for (const slip of slips) {
      const gracePill = slip.gracePeriodApproved
        ? `⚡ _Grace (${slip.graceBackoff?.sliceAllocationMinutes ? `${slip.graceBackoff.sliceAllocationMinutes}m Backoff Slice` : "15m Window"})_`
        : `🕒 _Standard_`;

      manifestLines.push(
        `> 🏷️ \`${slip.bagLabel}\`  •  *${slip.customerName}* (\`${slip.customerPhone}\`)`
      );
      manifestLines.push(
        `> 🧾 Order \`#${slip.orderId}\`  •  ${gracePill}`
      );
      for (const item of slip.items) {
        manifestLines.push(`  ☐ \`${item.quantity}x\` *${item.name}*`);
        if (item.notes) {
          manifestLines.push(`      _↳ Note: ${item.notes}_`);
        }
      }
      if (slip.notes) {
        manifestLines.push(`  📝 _Order Note: ${slip.notes}_`);
      }
      manifestLines.push(
        `  💰 *Bag Total: KES ${slip.totalAmount.toLocaleString()}* _(${slip.totalPortionsInBag} ${slip.totalPortionsInBag === 1 ? 'portion' : 'portions'} in bag)_`
      );
      manifestLines.push("");
    }
  }

  // Assemble Complete Mobile-First Executive Document with Native WhatsApp Blockquotes & Command Chips
  const document = [
    `> 👩🏾‍🍳 *[${shopName.toUpperCase()}] EXECUTIVE KITCHEN PREP DIGEST*`,
    `> 🏷️ \`${activeBatchId}\`  •  📦 *${orders.length} Orders (${totalPortionsAcrossBatch} Portions)*`,
    `> 🕒 _${timeFormatted}, ${dateFormatted}_`,
    "",
    ...prepLines,
    "",
    ...manifestLines,
    `> 💰 *TOTAL BATCH REVENUE:* *KES ${totalRevenue.toLocaleString()}*`,
    `> ✅ *STATUS:* *READY TO COOK & PACK BY GATE*`,
    `> 💬 *Shop Quick Reply:* \`PACKED BAG-01\` • \`SOLD OUT <Dish>\` • \`STATUS\``
  ];

  return document.join("\n");
}

/**
 * Generates structured per-customer Bagging & Packing Slips ("What to Pack for Who")
 * Assigns each order a sequential Bag Label (BAG-01, BAG-02, ...) and itemizes contents.
 * @param {Array<Object>} orders
 * @returns {Array<Object>}
 */
export function generatePackingSlips(orders = []) {
  if (!Array.isArray(orders)) return [];

  return orders.map((order, index) => {
    const meta = order.metadata || order;
    const bagNumber = String(index + 1).padStart(2, "0");
    const bagLabel = `BAG-${bagNumber}`;
    const orderId = String(meta.orderId || `ORD-${index + 1}`);
    const shortId = orderId.includes("-") ? orderId.split("-")[0].toUpperCase() : orderId;
    const customerName = meta.customer?.name || meta.clientName || "Guest";
    const customerPhone = meta.customer?.phone || meta.clientPhone || "N/A";
    const gate =
      meta.pickupGate ||
      meta.deliveryAddress ||
      meta.tableNumber ||
      meta.fulfillmentType ||
      "Main Kitchen Counter";
    const totalAmount = Number(meta.totalAmount || meta.totalPrice || meta.total || 0);
    const rawItems = Array.isArray(meta.items) ? meta.items : [];

    const items = rawItems.map((i) => ({
      name: i.name || "Special Item",
      quantity: Number(i.quantity || i.qty || 1),
      price: Number(i.price || 0),
      notes: i.notes || i.specialInstructions || ""
    }));

    const totalPortionsInBag = items.reduce((sum, i) => sum + i.quantity, 0);

    return {
      bagLabel,
      orderId,
      shortId,
      customerName,
      customerPhone,
      gate,
      items,
      totalPortionsInBag,
      totalAmount,
      gracePeriodApproved: Boolean(meta.gracePeriodApproved),
      graceBackoff: meta.graceBackoff || null,
      notes: meta.notes || meta.specialInstructions || ""
    };
  });
}

/**
 * In-memory sliding window manager for order clustering
 */
export class OrderClusteringEngine {
  constructor(options = {}) {
    this.shopName = options.shopName || "Leah's Kitchen";
    this.clusterThreshold = options.clusterThreshold || 3; // Trigger digest after 3 clustered orders
    this.orders = [];
    this.batchCounter = 1;
  }

  /**
   * Adds an order to the active cluster
   * @param {Object} order
   * @returns {number} Active cluster size
   */
  addOrder(order) {
    if (!order) return this.orders.length;
    this.orders.push({
      ...order,
      receivedAt: Date.now(),
    });
    return this.orders.length;
  }

  /**
   * Checks if the cluster has reached the threshold to trigger an executive summary
   * @returns {boolean}
   */
  isClusterReady() {
    return this.orders.length >= this.clusterThreshold;
  }

  /**
   * Returns current un-dispatched orders
   * @returns {Array<Object>}
   */
  getOrders() {
    return [...this.orders];
  }

  /**
   * Clears the current cluster and returns the formatted summary
   * @returns {{ digestText: string, orderCount: number, batchId: string }}
   */
  flush() {
    if (this.orders.length === 0) {
      return null;
    }
    const batchId = `BATCH-${this.batchCounter++}`;
    const digestText = formatClusteredPrepDigest({
      orders: this.orders,
      shopName: this.shopName,
      batchId,
    });
    const orderCount = this.orders.length;
    this.orders = [];
    return { digestText, orderCount, batchId };
  }

  /**
   * Returns a structured telemetry snapshot for diagnostics
   */
  tabulate() {
    return this.orders.map((o, idx) => {
      const meta = o.metadata || o;
      return {
        Index: idx + 1,
        OrderId: meta.orderId || "N/A",
        Customer: meta.customer?.name || meta.clientName || "Guest",
        Destination: meta.deliveryAddress || meta.tableNumber || "Counter",
        Amount: meta.totalAmount || meta.totalPrice || 0,
      };
    });
  }
}

export const defaultOrderClusteringEngine = new OrderClusteringEngine({
  shopName: "Leah's Kitchen",
  clusterThreshold: 3,
});

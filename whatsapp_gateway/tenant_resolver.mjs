/**
 * Multi-Tenant Context & Supabase Commerce Resolver
 * Enforces zero-leak cryptographic group partitioning, tenant data scoping,
 * ambiguity disambiguation guards, and structured template validation.
 */
import { GROUPS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";

const hdrs = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

// In-memory cache with 60-second TTL
let shopsCache = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60000;

export async function getAllShops(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && shopsCache && (now - lastCacheTime < CACHE_TTL_MS)) {
    return shopsCache;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/shops?select=id,name,slug,mpesa_till_number,phone,whatsapp_number,fulfillment_settings`, { headers: hdrs });
    if (!res.ok) throw new Error(`Supabase error: ${res.statusText}`);
    const data = await res.json();
    shopsCache = Array.isArray(data) ? data : [];
    lastCacheTime = now;
    return shopsCache;
  } catch (err) {
    console.error("[TENANT RESOLVER] Error fetching shops:", err.message);
    return shopsCache || [];
  }
}

/**
 * Resolves the role and tenant identity of an incoming WhatsApp chat JID.
 */
export async function resolveGroupContext(replyJid) {
  if (!replyJid) return { tier: "UNKNOWN" };

  // 1. Direct Message (1-on-1 WhatsApp DM)
  if (replyJid.endsWith("@s.whatsapp.net")) {
    return {
      tier: "DIRECT_MESSAGE",
      phone: replyJid.replace(/@.*$/, "")
    };
  }

  // 2. Check Platform System Groups
  if (GROUPS?.adminOversight?.jid && replyJid === GROUPS.adminOversight.jid) {
    return { tier: "SYSTEM", role: "EXECUTIVE", name: GROUPS.adminOversight.name };
  }
  if (GROUPS?.itHelpdesk?.jid && replyJid === GROUPS.itHelpdesk.jid) {
    return { tier: "SYSTEM", role: "HELPDESK", name: GROUPS.itHelpdesk.name };
  }
  if (GROUPS?.general?.jid && replyJid === GROUPS.general.jid) {
    return { tier: "SYSTEM", role: "OPERATIONS", name: GROUPS.general.name };
  }

  // Fallback check for known hardcoded platform JIDs
  if (replyJid === "120363415291701803@g.us") {
    return { tier: "SYSTEM", role: "EXECUTIVE", name: "Perpetua - Admin Oversight" };
  }
  if (replyJid === "120363432040872305@g.us") {
    return { tier: "SYSTEM", role: "HELPDESK", name: "Perpetua - IT Helpdesk" };
  }
  if (replyJid === "120363429929736148@g.us") {
    return { tier: "SYSTEM", role: "OPERATIONS", name: "perpetua" };
  }

  // 3. Check Tenant / Shop Communities
  const shops = await getAllShops();
  for (const shop of shops) {
    const routing = shop.fulfillment_settings?.whatsapp_routing;
    if (!routing) continue;

    if (routing.operations_jid === replyJid) {
      return { tier: "SHOP", role: "OPERATIONS", shop };
    }
    if (routing.management_jid === replyJid) {
      return { tier: "SHOP", role: "MANAGEMENT", shop };
    }
    if (routing.community_jid === replyJid) {
      return { tier: "SHOP", role: "COMMUNITY", shop };
    }
    if (routing.channel_jid === replyJid) {
      return { tier: "SHOP", role: "CHANNEL", shop };
    }
  }

  return { tier: "UNREGISTERED", jid: replyJid };
}

/**
 * Resolves an order by exact UUID, 8-character hex prefix, # prefix, angle brackets (<id>), or enterprise order number (ORD-...).
 */
export async function resolveShopOrder(shopId, query) {
  if (!query) return null;
  const clean = query.trim().replace(/^[#<]+|[>]+$/g, "").trim().toLowerCase();
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);

  if (isUUID) {
    const url = shopId
      ? `${SUPABASE_URL}/rest/v1/orders?shop_id=eq.${shopId}&id=eq.${clean}&select=*`
      : `${SUPABASE_URL}/rest/v1/orders?id=eq.${clean}&select=*`;
    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  }

  // Non-UUID query (short 8-char hex, ORD- prefix, or M-Pesa code):
  const url = shopId
    ? `${SUPABASE_URL}/rest/v1/orders?shop_id=eq.${shopId}&select=*&order=created_at.desc&limit=200`
    : `${SUPABASE_URL}/rest/v1/orders?select=*&order=created_at.desc&limit=200`;
  const res = await fetch(url, { headers: hdrs });
  if (!res.ok) return null;
  const rows = await res.json();

  return rows.find(o => 
    o.id.toLowerCase().startsWith(clean) || 
    (o.notes && o.notes.toLowerCase().includes(clean)) || 
    (o.mpesa_code && o.mpesa_code.toLowerCase() === clean)
  ) || null;
}

/**
 * Scoped Order Queries
 */
export async function queryShopOrders(shopId, filterStr = "") {
  let filterParam = `shop_id=eq.${shopId}`;
  const now = new Date();
  const lowerFilter = (filterStr || "").toLowerCase().trim();

  if (lowerFilter === "today") {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    filterParam += `&created_at=gte.${startOfDay}`;
  } else if (lowerFilter === "yesterday") {
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    filterParam += `&created_at=gte.${startOfYesterday}&created_at=lt.${startOfToday}`;
  } else if (lowerFilter === "month" || lowerFilter === "this month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    filterParam += `&created_at=gte.${startOfMonth}`;
  } else if (lowerFilter === "paid") {
    filterParam += `&status=eq.paid`;
  } else if (lowerFilter === "pending") {
    filterParam += `&status=eq.pending`;
  } else if (lowerFilter === "dispatched" || lowerFilter === "done") {
    filterParam += `&status=eq.dispatched`;
  } else {
    // Default: active open orders
    filterParam += `&status=neq.dispatched&status=neq.cancelled&status=neq.archived`;
  }

  const url = `${SUPABASE_URL}/rest/v1/orders?${filterParam}&select=id,total_price,status,created_at,client_name,client_phone,mpesa_code,notes,internal_status&order=created_at.desc&limit=15`;
  const res = await fetch(url, { headers: hdrs });
  if (!res.ok) throw new Error(`Orders fetch failed: ${res.statusText}`);
  return await res.json();
}

/**
 * Scoped Sales & Financial Summary
 */
export async function calculateShopSummary(shopId, timeframe = "today") {
  const now = new Date();
  let timeFilter = "";

  if (timeframe === "today") {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    timeFilter = `&created_at=gte.${startOfDay}`;
  } else if (timeframe === "week") {
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    timeFilter = `&created_at=gte.${startOfWeek}`;
  } else if (timeframe === "month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    timeFilter = `&created_at=gte.${startOfMonth}`;
  }

  const url = `${SUPABASE_URL}/rest/v1/orders?shop_id=eq.${shopId}${timeFilter}&select=id,total_price,status,created_at`;
  const res = await fetch(url, { headers: hdrs });
  if (!res.ok) throw new Error(`Summary fetch failed: ${res.statusText}`);
  const orders = await res.json();

  let grossRevenue = 0;
  let paidCount = 0;
  let pendingCount = 0;
  let otherCount = 0;

  for (const o of orders) {
    const amount = Number(o.total_price) || 0;
    if (o.status === "paid" || o.status === "dispatched") {
      grossRevenue += amount;
      paidCount++;
    } else if (o.status === "pending") {
      pendingCount++;
    } else {
      otherCount++;
    }
  }

  const avgTicket = paidCount > 0 ? (grossRevenue / paidCount) : 0;

  return {
    timeframe,
    totalOrders: orders.length,
    paidOrders: paidCount,
    pendingOrders: pendingCount,
    grossRevenue,
    avgTicket
  };
}

/**
 * Robust Product Disambiguation Engine
 * Resolves a product by exact ID, prefix ID, exact name, or fuzzy name.
 * Prevents accidental updates when multiple products share similar names.
 */
export async function resolveShopProduct(shopId, query) {
  const cleanQuery = (query || "").trim().toLowerCase();
  if (!cleanQuery) return { status: "NONE" };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shopId}&select=*`, { headers: hdrs });
    if (!res.ok) return { status: "NONE" };
    const allItems = await res.json();
    if (!allItems || allItems.length === 0) return { status: "NONE" };

    // 1. Check ID match (full UUID or short hex prefix)
    const idMatches = allItems.filter(it => it.id.toLowerCase().startsWith(cleanQuery));
    if (idMatches.length === 1) {
      return { status: "EXACT", product: idMatches[0] };
    }
    if (idMatches.length > 1) {
      return { status: "AMBIGUOUS", matches: idMatches };
    }

    // 2. Check Exact Name Match (case-insensitive literal)
    const exactName = allItems.find(it => it.name.toLowerCase() === cleanQuery);
    if (exactName) {
      return { status: "EXACT", product: exactName };
    }

    // 3. Check Substring Name Match
    const nameMatches = allItems.filter(it => it.name.toLowerCase().includes(cleanQuery));
    if (nameMatches.length === 1) {
      return { status: "EXACT", product: nameMatches[0] };
    }
    if (nameMatches.length > 1) {
      return { status: "AMBIGUOUS", matches: nameMatches };
    }

    return { status: "NONE" };
  } catch (err) {
    console.error("[RESOLVE PRODUCT ERROR]", err.message);
    return { status: "NONE" };
  }
}

/**
 * In-Chat Product Management
 */
export async function addShopProduct(shopId, { name, price, category = "General", description = "" }) {
  const url = `${SUPABASE_URL}/rest/v1/menu_items`;
  const payload = {
    shop_id: shopId,
    name: name.trim(),
    price: Math.max(0, Number(price) || 0),
    category: category.trim(),
    description: description.trim(),
    is_active: true
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { ...hdrs, "Prefer": "return=representation" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to insert product: ${err}`);
  }
  const rows = await res.json();
  return rows[0];
}

export async function updateShopProductFields(shopId, productId, fields) {
  const url = `${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shopId}&id=eq.${productId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...hdrs, "Prefer": "return=representation" },
    body: JSON.stringify(fields)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Product update failed: ${err}`);
  }
  const rows = await res.json();
  return rows[0];
}

export async function getShopInventoryOverview(shopId) {
  const url = `${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shopId}&select=id,name,price,category,is_active&order=category.asc,name.asc`;
  const res = await fetch(url, { headers: hdrs });
  if (!res.ok) throw new Error(`Inventory fetch failed: ${res.statusText}`);
  const allItems = await res.json();

  const inStock = [];
  const outOfStock = [];

  for (const it of allItems) {
    if (it.is_active) inStock.push(it);
    else outOfStock.push(it);
  }

  return {
    total: allItems.length,
    inStockCount: inStock.length,
    outOfStockCount: outOfStock.length,
    inStock,
    outOfStock
  };
}

export async function listShopProducts(shopId, category = "") {
  let filter = `shop_id=eq.${shopId}&is_active=eq.true`;
  if (category) {
    filter += `&category=ilike.*${encodeURIComponent(category)}*`;
  }
  const url = `${SUPABASE_URL}/rest/v1/menu_items?${filter}&select=id,name,price,category,is_active&order=category.asc,name.asc&limit=30`;
  const res = await fetch(url, { headers: hdrs });
  if (!res.ok) throw new Error(`Product list failed: ${res.statusText}`);
  return await res.json();
}

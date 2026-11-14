/**
 * Storefront v1 Blackbox Catalog, Blind Order Guard Checkout, Quote & Merchant FSM Routes
 * Extracted from http_routes.mjs (see routes/INDEX.md)
 */
import { parseJsonBody } from "../http_helpers.mjs";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config.mjs";
import { getAllShops } from "../tenant_resolver.mjs";
import { sealCheckoutEnvelope, unsealWithKey } from "../blind_checkout_crypto.mjs";

export async function handleStorefrontRoutes({
  req,
  res,
  parsedUrl,
  GROUPS,
  safeSendMessage,
  sharedOrderGuard,
  PII_ENCRYPTION_KEY,
  ORDER_GUARD_KEY,
  ORDER_GUARD_HMAC_SECRET,
}) {
    const storefrontCatalogMatch = parsedUrl.pathname.match(/^\/api\/v1\/storefront\/([^\/]+)\/catalog$/);
    if (req.method === "GET" && storefrontCatalogMatch) {
      const slug = storefrontCatalogMatch[1];
      try {
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const hdrs = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };

        let shop = null;
        let items = [];
        let promotions = [];

        try {
          const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?slug=eq.${slug}&select=id,name,slug,phone,whatsapp_number,mpesa_till_number,logo_url,tagline,operating_hours,appearance_config,fulfillment_settings,operational_region`, {
            headers: hdrs,
            signal: AbortSignal.timeout(4000)
          });
          const shops = await shopRes.json();
          if (Array.isArray(shops) && shops.length > 0) {
            shop = shops[0];
            const [itemsRes, promoRes] = await Promise.all([
              fetch(`${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shop.id}&is_active=eq.true&select=id,name,description,price,category,image_url,is_active,attributes`, { headers: hdrs }),
              fetch(`${SUPABASE_URL}/rest/v1/promotions?shop_id=eq.${shop.id}&is_active=eq.true&select=id,name,description,discount_type,discount_value,min_items,bundle_price`, { headers: hdrs })
            ]);
            items = await itemsRes.json();
            promotions = await promoRes.json();
          }
        } catch (_) {}

        // Local config fallback (works offline or for newly provisioned local shops like keby254)
        if (!shop) {
          const fsMod = await import("fs");
          const pathMod = await import("path");
          const rootCfgPath = pathMod.resolve(import.meta.dirname, "..", "config", "shops", `${slug}.json`);
          const cwdCfgPath = pathMod.resolve(process.cwd(), "config", "shops", `${slug}.json`);
          const localCfgPath = fsMod.existsSync(rootCfgPath) ? rootCfgPath : cwdCfgPath;
          if (fsMod.existsSync(localCfgPath)) {
            const cfg = JSON.parse(fsMod.readFileSync(localCfgPath, "utf-8"));
            shop = {
              id: cfg.shop_id,
              slug: cfg.shop_slug || slug,
              name: cfg.name || slug,
              tagline: cfg.tagline || "",
              mpesa_till_number: cfg.mpesa_till_number || null,
              appearance_config: { logo_emoji: cfg.logo_emoji || "🏬" }
            };
            items = Array.isArray(cfg.catalog) ? cfg.catalog : [];
          }
        }

        if (!shop) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: "Shop not found" }));
        }
        const shopId = shop.id;
        const categories = Array.from(new Set((items || []).map(i => i.category).filter(Boolean))).sort();

        // Enrich with live daily buyable pool from Order Guard
        const stockSummary = await sharedOrderGuard.getDailyStockSummary(shopId);
        const poolMap = new Map(stockSummary.items.map(s => [s.item_id.toLowerCase(), s]));
        const enrichedItems = (items || []).map(it => {
          const pool = poolMap.get(String(it.id).toLowerCase()) || poolMap.get(String(it.name).toLowerCase());
          return {
            ...it,
            available_today: pool ? pool.available : null,
            daily_cap: pool ? pool.daily_cap : null,
            max_per_order: pool ? pool.max_per_order : null
          };
        });

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          shop,
          categories,
          items: enrichedItems,
          promotions: promotions || [],
          sale_date_eat: stockSummary.sale_date
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2. POST /api/v1/storefront/checkout (Blind Checkout Inspector + Atomic Hold + Till Gate)
    if (req.method === "POST" && parsedUrl.pathname === "/api/v1/storefront/checkout") {
      try {
        const body = await parseJsonBody(req);
        const { shop_id, shop_slug, items } = body;
        if ((!shop_id && !shop_slug) || !Array.isArray(items) || items.length === 0) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "shop_id (or shop_slug) and non-empty items are required." }));
        }

        // Resolve canonical shop.id (UUID) so policies/pools/catalog always share one key
        let resolvedShop = null;
        try {
          const allShops = await getAllShops();
          resolvedShop = allShops.find(s => s.id === shop_id || s.slug === shop_slug) || null;
        } catch (_) {}
        if (!resolvedShop && shop_slug) {
          try {
            const fsMod = await import("fs");
            const pathMod = await import("path");
            const moduleRelativeCfgPath = pathMod.resolve(import.meta.dirname, "..", "config", "shops", `${shop_slug}.json`);
            const cwdRelativeCfgPath = pathMod.resolve(process.cwd(), "config", "shops", `${shop_slug}.json`);
            const localCfgPath = fsMod.existsSync(moduleRelativeCfgPath) ? moduleRelativeCfgPath : cwdRelativeCfgPath;
            if (fsMod.existsSync(localCfgPath)) {
              const cfg = JSON.parse(fsMod.readFileSync(localCfgPath, "utf-8"));
              resolvedShop = { id: cfg.shop_id, slug: cfg.shop_slug, name: cfg.name, mpesa_till_number: cfg.mpesa_till_number };
            }
          } catch (_) {}
        }
        const canonicalShopId = resolvedShop?.id || shop_id || shop_slug;

        // Fetch authoritative menu_items prices from Supabase to prevent client price tampering
        const itemIds = items.map(i => i.id || i.item_id).filter(Boolean);
        let authPriceMap = new Map();
        if (itemIds.length > 0 && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            const uuidIds = itemIds.filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
            if (uuidIds.length > 0) {
              const hdrs = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
              const itemRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?id=in.(${uuidIds.join(",")})&select=id,name,price`, { headers: hdrs });
              const dbItems = await itemRes.json();
              if (Array.isArray(dbItems)) {
                authPriceMap = new Map(dbItems.map(i => [i.id, i]));
              }
            }
          } catch (_) {}
        }

        const sanitizedItems = items.map(it => {
          const dbIt = authPriceMap.get(it.id || it.item_id);
          return {
            ...it,
            name: dbIt ? dbIt.name : it.name,
            unit_price: dbIt ? Number(dbIt.price) : Number(it.unit_price ?? it.price ?? 0)
          };
        });

        // Split-key encryption: PII is sealed with PII_ENCRYPTION_KEY (Order Guard cannot decrypt it).
        // Only items + canonical shop_id + blind customer_hash are readable by Order Guard.
        const envelope = sealCheckoutEnvelope({ ...body, shop_id: canonicalShopId, items: sanitizedItems }, {
          piiKey: PII_ENCRYPTION_KEY,
          inspectorKey: ORDER_GUARD_KEY,
          hmacSecret: ORDER_GUARD_HMAC_SECRET
        });

        const verdict = await sharedOrderGuard.inspectAndReserve(envelope);

        if (verdict.decision === "REJECTED") {
          res.writeHead(409);
          return res.end(JSON.stringify({
            success: false,
            ...verdict,
            can_show_payment: false
          }));
        }

        if (verdict.decision === "NEEDS_APPROVAL") {
          // Outer layer decrypts PII only to notify shop management & oversight on WhatsApp
          const pii = unsealWithKey(envelope.pii_sealed, PII_ENCRYPTION_KEY, "pii");
          if (safeSendMessage) {
            const mgmtJid = resolvedShop?.fulfillment_settings?.whatsapp_routing?.management_jid;
            const adminJid = GROUPS?.adminOversight?.jid || "120363415291701803@g.us";
            const targets = new Set([mgmtJid, adminJid].filter(Boolean));
            const itemLines = verdict.items.map(i => `  • ${i.qty}x ${i.name}`).join("\n");
            const approvalMsg =
              `🛡️ *[ORDER GUARD: APPROVAL REQUIRED]* \`${verdict.order_id}\`\n` +
              `• Store: ${resolvedShop?.name || canonicalShopId}\n` +
              `• Customer: ${pii.customer_name || "Unknown"} (${pii.customer_phone || "N/A"})\n` +
              `• Value: KES ${Number(verdict.total_value || 0).toLocaleString()}\n` +
              `• Reason: ${verdict.code}\n` +
              `• Items:\n${itemLines}\n\n` +
              `👉 Reply \`!approve-order ${verdict.order_id}\` or \`!decline-order ${verdict.order_id}\``;
            for (const jid of targets) {
              safeSendMessage(jid, { text: approvalMsg });
            }
          }
          res.writeHead(202);
          return res.end(JSON.stringify({
            success: false,
            ...verdict,
            can_show_payment: false
          }));
        }

        // Approved or Trimmed Surebet: return Till number only AFTER stock is locked!
        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          ...verdict,
          mpesa_till_number: resolvedShop?.mpesa_till_number || null
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2a. POST /api/v1/storefront/release-hold (Release abandoned checkout back to pool)
    if (req.method === "POST" && parsedUrl.pathname === "/api/v1/storefront/release-hold") {
      try {
        const body = await parseJsonBody(req);
        if (!body.order_id) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "order_id is required." }));
        }
        const result = await sharedOrderGuard.releaseOrder(body.order_id, body.reason || "CANCELLED");
        res.writeHead(200);
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2. POST /api/v1/storefront/quote (Pure Server-Side Pricing Engine)
    if (req.method === "POST" && parsedUrl.pathname === "/api/v1/storefront/quote") {
      try {
        const body = await parseJsonBody(req);
        const { shop_id, items, fulfillment_type, coupon_code } = body;
        if (!shop_id || !Array.isArray(items) || items.length === 0) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Invalid quote request: shop_id and items are required." }));
        }

        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const hdrs = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };

        // Fetch actual prices from menu_items to prevent client price tampering
        const itemIds = items.map(i => i.id).filter(Boolean);
        const itemRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?id=in.(${itemIds.join(",")})&select=id,name,price`, { headers: hdrs });
        const dbItems = await itemRes.json();
        const priceMap = new Map((dbItems || []).map(i => [i.id, i]));

        let grossSubtotal = 0;
        const evaluatedItems = [];
        for (const it of items) {
          const dbItem = priceMap.get(it.id);
          const unitPrice = dbItem ? Number(dbItem.price) : 0;
          const qty = Number(it.quantity) || 1;
          grossSubtotal += (unitPrice * qty);
          evaluatedItems.append ? evaluatedItems.append(it) : evaluatedItems.push({
            id: it.id,
            name: dbItem ? dbItem.name : "Item",
            unit_price: unitPrice,
            quantity: qty,
            line_total: unitPrice * qty
          });
        }

        // Evaluate delivery fee if fulfillment_type === 'delivery'
        let deliveryFee = 0;
        if (fulfillment_type === "delivery") {
          const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${shop_id}&select=operational_region`, { headers: hdrs });
          const shopRows = await shopRes.json();
          const region = shopRows?.[0]?.operational_region || "Nairobi";
          const logRes = await fetch(`${SUPABASE_URL}/rest/v1/system_logistics_config?region_name=eq.${region}&is_active=eq.true&select=flat_delivery_fee`, { headers: hdrs });
          const logRows = await logRes.json();
          if (logRows?.[0]?.flat_delivery_fee) {
            deliveryFee = Number(logRows[0].flat_delivery_fee);
          } else {
            deliveryFee = 150; // Standard Nairobi default
          }
        }

        // Evaluate coupon / promotion
        let discount = 0;
        if (coupon_code) {
          const promoRes = await fetch(`${SUPABASE_URL}/rest/v1/promotions?shop_id=eq.${shop_id}&is_active=eq.true&select=*`, { headers: hdrs });
          const promos = await promoRes.json();
          const matchedPromo = (promos || []).find(p => (p.name || "").toLowerCase() === coupon_code.toLowerCase().trim());
          if (matchedPromo) {
            if (matchedPromo.discount_type === "percent") {
              discount = (grossSubtotal * Number(matchedPromo.discount_value || 0)) / 100;
            } else if (matchedPromo.discount_type === "flat") {
              discount = Math.min(grossSubtotal, Number(matchedPromo.discount_value || 0));
            }
          }
        }

        const totalPayable = Math.max(0, grossSubtotal - discount + deliveryFee);

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          subtotal: grossSubtotal,
          discount,
          delivery_fee: deliveryFee,
          total_payable: totalPayable,
          items: evaluatedItems
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 3. POST /api/v1/merchant/orders/:id/advance (FSM Transition Guard)
    const advanceMatch = parsedUrl.pathname.match(/^\/api\/v1\/merchant\/orders\/([^\/]+)\/advance$/);
    if (req.method === "POST" && advanceMatch) {
      const orderId = advanceMatch[1];
      try {
        const body = await parseJsonBody(req);
        const { target_station, actor_name, notes } = body;
        const normalizedTarget = (target_station || "").toLowerCase().trim();

        const STATION_TRANSITIONS = {
          pending: ["paid", "cancelled"],
          paid: ["preparing", "cancelled"],
          preparing: ["ready", "cancelled"],
          ready: ["dispatched", "completed"],
          dispatched: ["completed"],
          completed: [],
          cancelled: []
        };

        // SUPABASE_URL imported from config.mjs
        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
        const filter = isUUID ? `id=eq.${orderId}` : `notes=eq.${orderId}`;

        const ordRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}&select=id,status`, {
          headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` }
        });
        const orders = await ordRes.json();
        if (!orders || orders.length === 0) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: "Order not found" }));
        }

        const currentStation = (orders[0].status || "pending").toLowerCase();
        const allowed = STATION_TRANSITIONS[currentStation] || [];

        if (!allowed.includes(normalizedTarget)) {
          res.writeHead(400);
          return res.end(JSON.stringify({
            code: "ILLEGAL_STATION_TRANSITION",
            error: `Cannot advance order from '${currentStation}' to '${normalizedTarget}'. Allowed next stations: [${allowed.join(", ")}]`
          }));
        }

        // Commit station update in Supabase
        const fullOrdRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orders[0].id}`, {
          method: "PATCH",
          headers: {
            "apikey": SERVICE_KEY,
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify({ status: normalizedTarget })
        });
        const updatedRows = await fullOrdRes.json().catch(() => []);
        const updatedOrd = updatedRows?.[0] || orders[0];

        if (normalizedTarget === "cancelled") {
          await sharedOrderGuard.releaseOrder(orderId, "CANCELLED", updatedOrd.shop_id || null);
        }

        // Broadcast station advance to Shop Group AND Perpetual Main Group
        if (safeSendMessage) {
          try {
            const allShops = await getAllShops();
            const shop = allShops.find(s => s.id === updatedOrd.shop_id);
            const routing = shop?.fulfillment_settings?.whatsapp_routing || {};
            const advCard =
              `🔄 *[ORDER STATION ADVANCED — ${(shop?.name || "STORE").toUpperCase()}]*\n` +
              `• *Order:* #${(updatedOrd.id || "").slice(0, 8).toUpperCase()}\n` +
              `• *Transition:* \`${currentStation.toUpperCase()}\` ➡️ *\`${normalizedTarget.toUpperCase()}\`*\n` +
              `• *Customer:* ${updatedOrd.client_name || "Customer"}\n` +
              `• *Total:* KES ${Number(updatedOrd.total_price || 0).toLocaleString()}\n` +
              `• *Actor:* ${actor_name || "Merchant"}`;

            const advTargets = new Set([
              GROUPS?.general?.jid || "120363429929736148@g.us",
              routing.operations_jid,
              (normalizedTarget === "completed" || normalizedTarget === "cancelled" || normalizedTarget === "dispatched")
                ? (GROUPS?.adminOversight?.jid || "120363415291701803@g.us")
                : null,
              (normalizedTarget === "completed" || normalizedTarget === "cancelled")
                ? routing.management_jid
                : null
            ].filter(Boolean));

            for (const tJid of advTargets) {
              safeSendMessage(tJid, { text: advCard });
            }
          } catch (e) {
            console.warn("[ADVANCE BROADCAST WARN]", e.message);
          }
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          order_id: orders[0].id,
          previous_station: currentStation,
          current_station: normalizedTarget,
          actor: actor_name || "Merchant"
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Serve built TMS Whitelabel SPA & static assets when available
  return false;
}

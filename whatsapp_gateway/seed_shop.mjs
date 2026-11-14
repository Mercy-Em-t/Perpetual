/**
 * Reusable Shop Provisioner & Order Guard Seeder Template
 *
 * Usage:
 *   node whatsapp_gateway/seed_shop.mjs <path-to-shop-manifest.json>
 * Example:
 *   node whatsapp_gateway/seed_shop.mjs config/shop_manifests/keby254.json
 *
 * Easily swappable for production: copy `config/shop_manifests/shop.template.json`,
 * fill in your production Till, WhatsApp JIDs, and products, and run this script.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";
import { OrderGuard } from "./order_guard.mjs";

const DEFAULT_PIPELINE = {
  initial_station: "PENDING",
  stations: [
    { id: "PENDING", label: "Pending Payment", emoji: "🟡", action_command: "!paid", authorized_roles: ["CASHIER", "MANAGEMENT"], next: "PACKAGING" },
    { id: "PACKAGING", label: "Packing Order", emoji: "📦", action_command: "!pack", authorized_roles: ["PACKAGER", "OPERATIONS"], next: "VERIFIED" },
    { id: "VERIFIED", label: "QA Verified", emoji: "🔍", action_command: "!verify", authorized_roles: ["QA_INSPECTOR", "MANAGEMENT"], next: "IN_TRANSIT" },
    { id: "IN_TRANSIT", label: "Out for Delivery", emoji: "🚚", action_command: "!dispatch", authorized_roles: ["COURIER", "OPERATIONS"], next: "DELIVERED" },
    { id: "DELIVERED", label: "Delivered", emoji: "📍", action_command: "!delivered", authorized_roles: ["COURIER", "RIDER", "MANAGEMENT"], next: "COMPLETED" },
    { id: "COMPLETED", label: "Completed", emoji: "✅", action_command: "!confirm", authorized_roles: ["CUSTOMER", "MANAGEMENT"], next: null }
  ]
};

export async function seedShopFromManifest(manifestPath) {
  const absPath = path.resolve(process.cwd(), manifestPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Shop manifest not found: ${absPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(absPath, "utf-8"));
  const slug = manifest.shop_slug;
  if (!slug || !manifest.name) {
    throw new Error("Manifest must include 'shop_slug' and 'name'.");
  }

  const fallbackId = manifest.shop_id || crypto.randomUUID();
  const tillNumber = process.env.MPESA_TILL_NUMBER || manifest.mpesa_till_number || null;
  let shop = { id: fallbackId, slug, name: manifest.name, mpesa_till_number: tillNumber };
  let supabaseOnline = false;

  const hdrs = SUPABASE_SERVICE_ROLE_KEY
    ? {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      }
    : null;

  // 1. Sync Shop to Supabase if credentials & network are available
  if (hdrs) {
    try {
      const findRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?slug=eq.${slug}&select=*`, {
        headers: hdrs,
        signal: AbortSignal.timeout(5000)
      });
      const existingShops = await findRes.json();
      supabaseOnline = true;

      const shopPatch = {
        name: manifest.name,
        tagline: manifest.tagline || "",
        mpesa_till_number: tillNumber,
        appearance_config: {
          logo_emoji: manifest.logo_emoji || "🏬",
          accent_color: manifest.accent_color || "#111827"
        }
      };

      if (Array.isArray(existingShops) && existingShops.length > 0) {
        shop = existingShops[0];
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${shop.id}`, {
          method: "PATCH",
          headers: hdrs,
          body: JSON.stringify(shopPatch)
        });
        const patched = await patchRes.json();
        shop = patched?.[0] || shop;
        console.log(`[SUPABASE] Shop updated: ${manifest.name} (${shop.id})`);
      } else {
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/shops`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify({ id: fallbackId, slug, ...shopPatch })
        });
        const inserted = await insertRes.json();
        if (insertRes.ok && inserted?.[0]) {
          shop = inserted[0];
          console.log(`[SUPABASE] Shop created: ${manifest.name} (${shop.id})`);
        }
      }
    } catch (netErr) {
      console.warn(`[OFFLINE FALLBACK] Supabase unreachable (${netErr.message}). Provisioning '${slug}' locally...`);
    }
  }

  // 2. Seed products & Order Guard policies
  let byName = new Map();
  if (supabaseOnline && hdrs) {
    try {
      const existingItemsRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${shop.id}&select=id,name`, { headers: hdrs });
      const existingItems = await existingItemsRes.json();
      byName = new Map((Array.isArray(existingItems) ? existingItems : []).map(i => [i.name.toLowerCase(), i]));
    } catch (_) {}
  }

  const guard = new OrderGuard({
    stateFile: process.env.ORDER_GUARD_STATE_FILE || path.resolve(process.cwd(), "order_guard_state.json")
  });

  const seeded = [];
  const configCatalog = [];
  for (const prod of manifest.products || []) {
    let itemId = prod.sku || `${slug}-${prod.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

    if (supabaseOnline && hdrs) {
      try {
        const match = byName.get(prod.name.toLowerCase());
        const itemBody = {
          description: prod.description || "",
          price: prod.price,
          category: prod.category || "General",
          is_active: true,
          attributes: prod.attributes || {}
        };
        if (match) {
          const pRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?id=eq.${match.id}`, {
            method: "PATCH",
            headers: hdrs,
            body: JSON.stringify(itemBody)
          });
          const rows = await pRes.json();
          itemId = rows?.[0]?.id || match.id;
        } else {
          const cRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items`, {
            method: "POST",
            headers: hdrs,
            body: JSON.stringify({ shop_id: shop.id, name: prod.name, ...itemBody })
          });
          const rows = await cRes.json();
          if (cRes.ok && rows?.[0]?.id) {
            itemId = rows[0].id;
          }
        }
      } catch (_) {}
    }

    await guard.configureItemPolicy(shop.id, itemId, {
      name: prod.name,
      daily_cap: prod.daily_cap,
      max_per_order: prod.max_per_order,
      max_per_customer_per_day: prod.max_per_customer_per_day,
      min_qty: prod.min_qty ?? 1,
      step_qty: prod.step_qty ?? 1,
      partial_fill_mode: prod.partial_fill_mode || "strict",
      unit_price: prod.price
    });

    configCatalog.push({
      id: itemId,
      sku: prod.sku || itemId,
      name: prod.name,
      category: prod.category || "General",
      price: prod.price,
      description: prod.description || "",
      is_active: true,
      attributes: prod.attributes || {}
    });

    seeded.push({
      id: itemId,
      name: prod.name,
      price: prod.price,
      daily_cap: prod.daily_cap,
      max_per_order: prod.max_per_order,
      mode: prod.partial_fill_mode || "strict"
    });
  }

  // 3. Save config/shops/<slug>.json
  const shopConfig = {
    shop_id: shop.id,
    shop_slug: slug,
    name: manifest.name,
    shop_name: manifest.name,
    logo_emoji: manifest.logo_emoji || "🏬",
    tagline: manifest.tagline || "",
    industry: manifest.industry || "retail",
    currency: manifest.currency || "KES",
    order_prefix: manifest.order_prefix || "ORD",
    mpesa_till_number: tillNumber,
    whatsapp_groups: manifest.whatsapp_groups || {},
    catalog: configCatalog,
    pipeline: manifest.pipeline || DEFAULT_PIPELINE
  };

  const configPath = path.resolve(process.cwd(), "config", "shops", `${slug}.json`);
  fs.writeFileSync(configPath, JSON.stringify(shopConfig, null, 2), "utf-8");
  console.log(`[CONFIG SAVED] ${configPath}`);
  console.log(`\n✅ ${manifest.name} ${manifest.logo_emoji || ""} seeded (${supabaseOnline ? "Supabase + Local" : "Local Offline Mode"}) with ${seeded.length} products & Order Guard policies:`);
  console.table(seeded);

  return { shop, seeded, configPath };
}

// CLI execution
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const manifestArg = process.argv[2];
  if (!manifestArg) {
    console.error("Usage: node whatsapp_gateway/seed_shop.mjs <path-to-manifest.json>");
    process.exit(1);
  }
  seedShopFromManifest(manifestArg).catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
}

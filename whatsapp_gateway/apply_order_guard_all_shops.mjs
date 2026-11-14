/**
 * Platform-Wide Order Guard Policy Applier
 *
 * Applies Order Guard daily caps, per-order limits, and fill modes across ALL
 * configured shops and their products (both local `config/shops/*.json` and
 * Supabase `shops` + `menu_items` when online).
 *
 * Usage:
 *   node whatsapp_gateway/apply_order_guard_all_shops.mjs [--cap 50] [--max 10] [--mode strict|surebet] [--force] [--dry-run]
 */

import fs from "fs";
import path from "path";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";
import { OrderGuard } from "./order_guard.mjs";

const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : fallback;
}

const DEFAULT_CAP = Number(getArg("--cap", 50));
const DEFAULT_MAX_PER_ORDER = Number(getArg("--max", 10));
const DEFAULT_MODE = getArg("--mode", "strict");
const FORCE_OVERWRITE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");

async function fetchSupabaseShopsAndItems() {
  if (!SUPABASE_SERVICE_ROLE_KEY) return [];
  const hdrs = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };
  try {
    const shopsRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?select=id,slug,name`, {
      headers: hdrs,
      signal: AbortSignal.timeout(5000)
    });
    const shops = await shopsRes.json();
    if (!Array.isArray(shops)) return [];

    const results = [];
    for (const s of shops) {
      try {
        const itemsRes = await fetch(
          `${SUPABASE_URL}/rest/v1/menu_items?shop_id=eq.${s.id}&is_active=eq.true&select=id,name,price,daily_cap,max_per_order,partial_fill_mode`,
          { headers: hdrs, signal: AbortSignal.timeout(5000) }
        );
        const items = await itemsRes.json();
        results.push({
          shop_id: s.id,
          slug: s.slug,
          name: s.name,
          source: "supabase",
          items: Array.isArray(items) ? items : []
        });
      } catch (_) {}
    }
    return results;
  } catch (err) {
    console.warn(`[OFFLINE FALLBACK] Supabase unreachable (${err.message}). Scanning local config/shops/*.json...`);
    return [];
  }
}

function loadLocalShops() {
  const shopsDir = path.resolve(process.cwd(), "config", "shops");
  if (!fs.existsSync(shopsDir)) return [];
  const files = fs.readdirSync(shopsDir).filter(f => f.endsWith(".json"));
  const shops = [];
  for (const file of files) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(shopsDir, file), "utf-8"));
      if (cfg.shop_id) {
        shops.push({
          shop_id: cfg.shop_id,
          slug: cfg.shop_slug || file.replace(/\.json$/, ""),
          name: cfg.name || cfg.shop_name || file,
          source: "local-config",
          items: Array.isArray(cfg.catalog) ? cfg.catalog : []
        });
      }
    } catch (_) {}
  }
  return shops;
}

async function main() {
  const guard = new OrderGuard({
    stateFile: process.env.ORDER_GUARD_STATE_FILE || path.resolve(process.cwd(), "order_guard_state.json")
  });

  const remoteShops = await fetchSupabaseShopsAndItems();
  const localShops = loadLocalShops();

  // Merge by shop_id (prefer Supabase items if present, otherwise local catalog)
  const merged = new Map();
  for (const s of localShops) merged.set(s.shop_id, s);
  for (const s of remoteShops) {
    const prev = merged.get(s.shop_id);
    if (!prev || s.items.length > 0) {
      merged.set(s.shop_id, s);
    }
  }

  let shopsProcessed = 0;
  let itemsConfigured = 0;
  let itemsSkipped = 0;

  for (const shop of merged.values()) {
    shopsProcessed++;
    if (!shop.items || shop.items.length === 0) {
      console.log(`• ${shop.name} (${shop.slug}): 0 catalog items found (${shop.source})`);
      continue;
    }

    let shopApplied = 0;
    for (const it of shop.items) {
      const itemId = String(it.id || it.sku || it.name);
      const key = `${shop.shop_id}:${itemId.trim().toLowerCase()}`;
      const existing = guard.state.policies[key];

      if (existing && !FORCE_OVERWRITE) {
        itemsSkipped++;
        continue;
      }

      const policy = {
        name: it.name || itemId,
        daily_cap: it.daily_cap ?? DEFAULT_CAP,
        max_per_order: it.max_per_order ?? DEFAULT_MAX_PER_ORDER,
        partial_fill_mode: it.partial_fill_mode || DEFAULT_MODE,
        unit_price: it.price !== undefined ? Number(it.price) : undefined
      };

      if (!DRY_RUN) {
        await guard.configureItemPolicy(shop.shop_id, itemId, policy);
      }
      shopApplied++;
      itemsConfigured++;
    }

    console.log(`✅ ${shop.name} (${shop.slug}, ${shop.source}): configured ${shopApplied}/${shop.items.length} products`);
  }

  console.log(
    `\nSummary (${DRY_RUN ? "DRY-RUN" : "APPLIED"}): ` +
    `${shopsProcessed} shops scanned | ${itemsConfigured} products configured | ${itemsSkipped} already had policies`
  );
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});

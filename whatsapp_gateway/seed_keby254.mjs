/**
 * KEby254 Shop Seeder (uses generic template runner `seed_shop.mjs`)
 * Run: node whatsapp_gateway/seed_keby254.mjs
 */
import { seedShopFromManifest } from "./seed_shop.mjs";

seedShopFromManifest("config/shop_manifests/keby254.json").catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});

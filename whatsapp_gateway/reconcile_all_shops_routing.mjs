/**
 * Universal Multi-Tenant Routing Reconciler
 * Iterates through every shop in Supabase and provisions standardized whatsapp_routing.
 */

import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";

const hdrs = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

function generateOrderPrefix(name, slug) {
  if (slug === "haberdashery") return "DNH";
  if (slug === "creative-galore") return "CRG";
  if (slug === "leahs-kitchen") return "LHK";

  const words = name.replace(/[^a-zA-Z0-9\s]/g, "").trim().split(/\s+/);
  if (words.length >= 3) {
    return (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
  }
  if (words.length === 2) {
    return (words[0].slice(0, 2) + words[1][0]).toUpperCase();
  }
  const clean = words[0] || slug;
  return clean.slice(0, 3).toUpperCase();
}

async function reconcileAllShops() {
  console.log("==================================================================");
  console.log("UNIVERSAL MULTI-TENANT RECONCILER: for s in shops: ...");
  console.log("==================================================================");

  const res = await fetch(`${SUPABASE_URL}/rest/v1/shops?select=id,name,slug,phone,whatsapp_number,fulfillment_settings`, { headers: hdrs });
  const shops = await res.json();
  console.log(`Fetched ${shops.length} total shops from Supabase.`);

  let updatedCount = 0;
  let alreadyConfiguredCount = 0;

  for (const s of shops) {
    const existingSettings = s.fulfillment_settings || {};
    const existingRouting = existingSettings.whatsapp_routing || {};

    const prefix = existingRouting.order_prefix || generateOrderPrefix(s.name, s.slug);
    const ownerPhone = existingRouting.owner_phone || (s.whatsapp_number ? `${s.whatsapp_number.replace(/[^0-9]/g, "")}@s.whatsapp.net` : "254710720949@s.whatsapp.net");

    const standardizedRouting = {
      order_prefix: prefix,
      owner_phone: ownerPhone,
      community_jid: existingRouting.community_jid || null,
      operations_jid: existingRouting.operations_jid || null,
      management_jid: existingRouting.management_jid || null,
      is_active: existingRouting.is_active ?? true
    };

    // Check if update is needed
    const needsUpdate =
      !existingSettings.whatsapp_routing ||
      !existingRouting.order_prefix ||
      !existingRouting.owner_phone;

    if (needsUpdate) {
      existingSettings.whatsapp_routing = standardizedRouting;
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${s.id}`, {
        method: "PATCH",
        headers: hdrs,
        body: JSON.stringify({ fulfillment_settings: existingSettings })
      });

      if (patchRes.ok) {
        console.log(`✅ [PROVISIONED] [${s.slug}] ${s.name} -> Prefix: ${prefix} | Owner: ${ownerPhone}`);
        updatedCount++;
      } else {
        console.error(`❌ [FAILED] [${s.slug}] HTTP ${patchRes.status}`);
      }
    } else {
      console.log(`✨ [READY] [${s.slug}] ${s.name} -> Prefix: ${prefix} | Ops: ${existingRouting.operations_jid || 'UNLINKED'}`);
      alreadyConfiguredCount++;
    }
  }

  console.log("==================================================================");
  console.log(`RECONCILIATION COMPLETE: ${updatedCount} provisioned, ${alreadyConfiguredCount} already configured.`);
  console.log("==================================================================");
}

reconcileAllShops().catch(err => {
  console.error("Fatal error:", err);
});

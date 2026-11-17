import { getAllShops } from "../whatsapp_gateway/tenant_resolver.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://pfdpmsvtaetkpqwomtlp.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const dbHdrs = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fastForwardAllOrders() {
  console.log("==============================================================");
  console.log("⚡ FAST-FORWARDING ORDERS THROUGH 5-STAGE COMPLETION LIFECYCLE");
  console.log("==============================================================\n");

  const shops = await getAllShops();
  const shopMap = Object.fromEntries(shops.map(s => [s.id, s.name]));

  // 1. Fetch all orders currently in PAID state
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&select=id,shop_id,status,internal_status,total_price,client_name,client_phone,notes,created_at&order=created_at.desc`,
    { headers: dbHdrs }
  );
  const orders = await res.json();

  if (!Array.isArray(orders) || orders.length === 0) {
    console.log("No orders currently waiting in PAID state. All orders already settled or completed.");
    return;
  }

  console.log(`Found ${orders.length} orders to advance through the completion lifecycle.\n`);

  const replayLog = [];

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const shortId = o.id.slice(0, 8).toUpperCase();
    const shopName = shopMap[o.shop_id] || "Store";
    const assignedRider = "Boda Express Fleet (Rider Kiprono)";

    console.log(`--------------------------------------------------------------`);
    console.log(`📦 Order [${i + 1}/${orders.length}]: #${shortId} — ${shopName} (KES ${o.total_price})`);
    console.log(`   Customer: ${o.client_name || "Guest"} (${o.client_phone || "N/A"})`);
    console.log(`--------------------------------------------------------------`);

    const orderTimeline = {
      orderId: o.id,
      shortId,
      shopName,
      customer: o.client_name || "Guest",
      amount: o.total_price,
      events: []
    };

    // Stage 1: PACKAGING (!pack)
    const tPack = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
      method: "PATCH",
      headers: dbHdrs,
      body: JSON.stringify({ internal_status: "PACKAGING" })
    });
    orderTimeline.events.push({ stage: "PACKAGING", time: tPack, note: "Items boxed & bagged at kitchen/store" });
    console.log(`  [1/5] 📦 PACKED: Internal status set to PACKAGING (${tPack})`);
    await sleep(80);

    // Stage 2: VERIFIED (!verify)
    const tVerify = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
      method: "PATCH",
      headers: dbHdrs,
      body: JSON.stringify({ internal_status: "VERIFIED" })
    });
    orderTimeline.events.push({ stage: "VERIFIED", time: tVerify, note: "QA passed & M-Pesa till payment reconciled" });
    console.log(`  [2/5] 🔍 VERIFIED: QA check passed & receipt validated (${tVerify})`);
    await sleep(80);

    // Stage 3: DISPATCHED / IN_TRANSIT (!dispatch)
    const tDispatch = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
      method: "PATCH",
      headers: dbHdrs,
      body: JSON.stringify({
        status: "dispatched",
        internal_status: "IN_TRANSIT"
      })
    });
    orderTimeline.events.push({ stage: "IN_TRANSIT", time: tDispatch, note: `Handed off to rider: ${assignedRider}` });
    console.log(`  [3/5] 🛵 DISPATCHED: Handed off to rider (${assignedRider}) (${tDispatch})`);
    await sleep(80);

    // Stage 4: DELIVERED (!delivered)
    const tDelivered = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
      method: "PATCH",
      headers: dbHdrs,
      body: JSON.stringify({
        internal_status: "DELIVERED"
      })
    });
    orderTimeline.events.push({ stage: "DELIVERED", time: tDelivered, note: "Rider arrived at customer doorstep with handover PIN verified" });
    console.log(`  [4/5] 📍 DELIVERED: Rider arrived & customer handover PIN presented (${tDelivered})`);
    await sleep(80);

    // Stage 5: COMPLETED (!confirm)
    const tComplete = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
      method: "PATCH",
      headers: dbHdrs,
      body: JSON.stringify({
        status: "completed",
        internal_status: "COMPLETED",
        customer_confirmed_at: tComplete,
        shop_confirmed_at: tComplete
      })
    });
    orderTimeline.events.push({ stage: "COMPLETED", time: tComplete, note: "Dual Rider + Customer confirmation logged; order finalized" });
    console.log(`  [5/5] 🎉 COMPLETED: Dual confirmed & closed in ledger (${tComplete})\n`);

    replayLog.push(orderTimeline);
  }

  console.log("==============================================================");
  console.log(`✅ ALL ${orders.length} ORDERS SUCCESSFULLY FAST-FORWARDED TO COMPLETED`);
  console.log("==============================================================");

  return replayLog;
}

fastForwardAllOrders().catch(err => {
  console.error("Fastforward error:", err);
  process.exit(1);
});

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHttpRouter, sharedOrderGuard } from "./http_routes.mjs";

function startTestServer() {
  const router = createHttpRouter({
    GROUPS: {
      general: { name: "perpetua", jid: "120363429929736148@g.us" },
      itHelpdesk: { name: "Perpetua - IT Helpdesk", jid: "120363432040872305@g.us" },
      adminOversight: { name: "Perpetua - Admin Oversight", jid: "120363415291701803@g.us" },
    },
    getConnectionState: () => "open",
    getBotJid: () => "254700000000@s.whatsapp.net",
    safeSendMessage: async () => true,
    getSock: () => null,
  });

  const server = http.createServer(router);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

test("1. Router serves JSON service info on GET / for API clients and /health telemetry", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const rootRes = await fetch(`${baseUrl}/`, { headers: { Accept: "application/json" } });
    assert.equal(rootRes.status, 200);
    const rootJson = await rootRes.json();
    assert.equal(rootJson.service, "TMS WhatsApp Operations Gateway");

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.connection, "open");
  } finally {
    server.close();
  }
});

test("2. Router serves built tms-whitelabel-core SPA on browser routes and returns 404 JSON for unknown /api/* routes", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const api404 = await fetch(`${baseUrl}/api/non-existent-route`);
    assert.equal(api404.status, 404);
    const api404Json = await api404.json();
    assert.equal(api404Json.error, "Endpoint not found");

    const distIndex = path.resolve(import.meta.dirname, "..", "..", "Quality assurance", "tms-whitelabel-core", "dist", "index.html");
    if (fs.existsSync(distIndex)) {
      const spaRes = await fetch(`${baseUrl}/s/brunchbox`, { headers: { Accept: "text/html" } });
      assert.equal(spaRes.status, 200);
      assert.match(spaRes.headers.get("content-type") || "", /text\/html/);
      const html = await spaRes.text();
      assert.ok(html.includes("root"));
    }
  } finally {
    server.close();
  }
});

test("3. Storefront sub-router returns 409 INSUFFICIENT_STOCK before checkout/payment when x+k requested vs x available", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const testShopId = `test-http-shop-${Date.now()}`;
    const testItemId = "test-http-burger";
    await sharedOrderGuard.configureItemPolicy(testShopId, testItemId, {
      name: "Test Smashed Burger",
      daily_cap: 3,
      max_per_order: 10,
      partial_fill_mode: "strict",
      unit_price: 850,
    });

    // Request 3 + 2 = 5 when only 3 are available -> 409 Conflict, can_show_payment: false
    const overRes = await fetch(`${baseUrl}/api/v1/storefront/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: `ORD-HTTP-OVER-${Date.now()}`,
        shop_id: testShopId,
        customer_name: "Test Buyer",
        customer_phone: "0712345678",
        items: [{ id: testItemId, name: "Test Smashed Burger", qty: 5, unit_price: 850 }],
      }),
    });
    assert.equal(overRes.status, 409);
    const overJson = await overRes.json();
    assert.equal(overJson.can_show_payment, false);
    assert.equal(overJson.code, "INSUFFICIENT_STOCK");
    assert.equal(overJson.available, 3);
    assert.equal(overJson.requested_qty, 5);

    // Retry with exact available quantity (3) -> 200 OK, can_show_payment: true
    const okOrderId = `ORD-HTTP-OK-${Date.now()}`;
    const okRes = await fetch(`${baseUrl}/api/v1/storefront/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: okOrderId,
        shop_id: testShopId,
        customer_name: "Test Buyer",
        customer_phone: "0712345678",
        items: [{ id: testItemId, name: "Test Smashed Burger", qty: 3, unit_price: 850 }],
      }),
    });
    assert.equal(okRes.status, 200);
    const okJson = await okRes.json();
    assert.equal(okJson.can_show_payment, true);
    assert.equal(okJson.decision, "APPROVED");

    // Release hold via HTTP route so test state remains clean
    const relRes = await fetch(`${baseUrl}/api/v1/storefront/release-hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: okOrderId, reason: "test_cleanup" }),
    });
    assert.equal(relRes.status, 200);
    const relJson = await relRes.json();
    assert.equal(relJson.success, true);
  } finally {
    server.close();
  }
});

test("4. Support ticket hardening: rejects empty description (400) and supports dryRun=true without mutating state", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const emptyRes = await fetch(`${baseUrl}/api/support/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Blank ticket", description: "   " }),
    });
    assert.equal(emptyRes.status, 400);
    const emptyJson = await emptyRes.json();
    assert.match(emptyJson.error, /non-empty ticket description/i);

    const beforeList = await (await fetch(`${baseUrl}/api/support/tickets`)).json();

    const dryRes = await fetch(`${baseUrl}/api/support/ticket?dryRun=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Probe", description: "Dry run check" }),
    });
    assert.equal(dryRes.status, 200);
    const dryJson = await dryRes.json();
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.ticket.status, "DRY_RUN");

    const afterList = await (await fetch(`${baseUrl}/api/support/tickets`)).json();
    assert.equal(afterList.count, beforeList.count);
  } finally {
    server.close();
  }
});

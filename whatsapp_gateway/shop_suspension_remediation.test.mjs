import test from "node:test";
import assert from "node:assert/strict";
import {
  suspendShopCatalog,
  reinstateShopCatalog,
  submitMerchantRemediation
} from "./merchant_infraction_sentinel.mjs";
import { getAllShops } from "./tenant_resolver.mjs";

test("Shop Suspension & Remediation Protocol Suite", async (t) => {
  // Use a known existing shop for testing or mock check
  const allShops = await getAllShops();
  const testShop = allShops.find(s => s.slug === "keby254") || allShops[0];
  assert.ok(testShop, "Test shop should be present");

  const originalState = testShop.is_active;

  await t.test("1. Admin can suspend shop with clear reason and receive target JIDs", async () => {
    const res = await suspendShopCatalog(testShop.slug, "Automated Test Suspension", "TestAdmin");
    assert.equal(res.success, true);
    assert.equal(res.is_active, false);
    assert.equal(res.shopSlug, testShop.slug);
    assert.ok(Array.isArray(res.targetJids), "Should return merchant target JIDs");

    // Verify cache updated
    const updatedShops = await getAllShops();
    const updatedShop = updatedShops.find(s => s.slug === testShop.slug);
    assert.equal(updatedShop.is_active, false);
  });

  await t.test("2. Merchant operator can submit remediation notes", async () => {
    const remRes = await submitMerchantRemediation(
      testShop.slug,
      "Inventory audited, daily caps fixed, cold chain restored",
      "ShopManager",
      "254710720949@s.whatsapp.net"
    );
    assert.equal(remRes.success, true);
    assert.equal(remRes.actorName, "ShopManager");
    assert.match(remRes.notes, /Inventory audited/);

    const updatedShops = await getAllShops();
    const updatedShop = updatedShops.find(s => s.slug === testShop.slug);
    const sub = updatedShop.fulfillment_settings?.quality_suspension?.remediation_submission;
    assert.ok(sub, "Remediation submission should exist in fulfillment_settings");
    assert.equal(sub.status, "PENDING_MANAGER_REVIEW");
  });

  await t.test("3. Admin can reinstate shop after remediation approval", async () => {
    const res = await reinstateShopCatalog(testShop.slug, "Remediation plan approved", "TestAdmin");
    assert.equal(res.success, true);
    assert.equal(res.is_active, true);
    assert.equal(res.shopSlug, testShop.slug);

    const updatedShops = await getAllShops();
    const updatedShop = updatedShops.find(s => s.slug === testShop.slug);
    assert.equal(updatedShop.is_active, true);
    const sus = updatedShop.fulfillment_settings?.quality_suspension;
    assert.equal(sus?.is_suspended, false);
  });
});

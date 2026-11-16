import test from "node:test";
import assert from "node:assert/strict";
import { runMerchantInfractionAudit, formatInfractionDocketCard } from "./merchant_infraction_sentinel.mjs";

test("Merchant Infraction Sentinel: Audits live or historical orders and formats docket card", async () => {
  const auditRes = await runMerchantInfractionAudit({ auditAllTime: true });
  assert.equal(auditRes.success, true);
  assert.ok(auditRes.totalShopsScanned > 0, "Should scan registered tenant shops");
  assert.ok(typeof auditRes.formattedWhatsAppMessage === "string");
  assert.ok(auditRes.formattedWhatsAppMessage.includes("MERCHANT INFRACTION & SLA GOVERNANCE DOCKET"));

  // Check Creative Galore has breached rule 1 (3 unfulfilled orders) in all-time history
  const cg = auditRes.results.find(r => r.shopSlug === "creative-galore");
  if (cg) {
    assert.equal(cg.rule1State, "BREACH_CRITICAL");
    assert.equal(cg.hasBreach, true);
    assert.equal(cg.unfulfilled7dCount >= 3, true);
  }
});

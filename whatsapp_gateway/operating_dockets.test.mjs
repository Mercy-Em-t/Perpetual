import test from "node:test";
import assert from "node:assert/strict";
import { generateMorningDocketReport, generateSettlementDocketReport } from "./operating_dockets.mjs";

test("Operating Dockets: Generates dynamic morning overnight docket with real database queries", async () => {
  const morning = await generateMorningDocketReport();
  assert.equal(morning.success, true);
  assert.ok(typeof morning.formattedWhatsAppMessage === "string");
  assert.ok(morning.formattedWhatsAppMessage.includes("PLATFORM DOCKET: 06:30 AM OVERNIGHT RECONCILIATION"));

  // Ensure no dummy/mock strings exist in the formatted message
  assert.equal(morning.formattedWhatsAppMessage.includes("832F1B75"), false, "Must not contain dummy order 832F1B75");
  assert.equal(morning.formattedWhatsAppMessage.includes("QK78912345"), false, "Must not contain dummy M-Pesa QK78912345");
  assert.equal(morning.formattedWhatsAppMessage.includes("Botanica"), false, "Must not contain dummy store Botanica");
});

test("Operating Dockets: Generates dynamic settlement docket with real database queries", async () => {
  const settle = await generateSettlementDocketReport();
  assert.equal(settle.success, true);
  assert.ok(typeof settle.formattedWhatsAppMessage === "string");
  assert.ok(settle.formattedWhatsAppMessage.includes("B2C NET SETTLEMENTS"));
});

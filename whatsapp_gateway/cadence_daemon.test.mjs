import test from "node:test";
import assert from "node:assert/strict";
import { getEatTimeComponents, evaluateCadenceTriggers } from "./platform_cadence_daemon.mjs";

test("Cadence Daemon: Correctly extracts Africa/Nairobi EAT wall-clock time", () => {
  const sampleUtc = new Date("2026-11-16T12:00:00Z"); // 12:00 UTC = 15:00 EAT
  const eat = getEatTimeComponents(sampleUtc);
  assert.equal(eat.hour, 15);
  assert.equal(eat.dateKey, "2026-11-16");
});

test("Cadence Daemon: Evaluates all forced trigger actions cleanly", async () => {
  const sentMessages = [];
  const mockSend = async (jid, payload) => {
    sentMessages.push({ jid, text: payload.text });
  };

  // Test morning force trigger
  const resMorning = await evaluateCadenceTriggers({
    safeSendMessage: mockSend,
    forceTrigger: "morning"
  });
  assert.equal(resMorning.executed.length, 1);
  assert.equal(resMorning.executed[0].key, "morning");
  assert.equal(resMorning.executed[0].success, true);
  assert.ok(sentMessages[0].text.includes("PLATFORM DOCKET: 06:30 AM OVERNIGHT RECONCILIATION"));

  // Test lunch rush force trigger
  const resLunch = await evaluateCadenceTriggers({
    safeSendMessage: mockSend,
    forceTrigger: "lunch"
  });
  assert.equal(resLunch.executed.length, 1);
  assert.equal(resLunch.executed[0].key, "lunch");
  assert.equal(resLunch.executed[0].success, true);
  assert.ok(sentMessages[1].text.includes("PLATFORM DOCKET: 12:00 PM LUNCH RUSH TELEMETRY"));

  // Test weekly Tuesday force trigger
  const resWeekly = await evaluateCadenceTriggers({
    safeSendMessage: mockSend,
    forceTrigger: "weekly"
  });
  assert.equal(resWeekly.executed.length, 1);
  assert.equal(resWeekly.executed[0].key, "weeklyTuesday");
  assert.equal(resWeekly.executed[0].success, true);
  assert.ok(sentMessages[2].text.includes("PLATFORM DOCKET: WEEKLY TUESDAY GOVERNANCE AUDIT"));

  // Test 2-day pre-monthly reminder force trigger
  const resPreMonthly = await evaluateCadenceTriggers({
    safeSendMessage: mockSend,
    forceTrigger: "pre-monthly"
  });
  assert.equal(resPreMonthly.executed.length, 1);
  assert.equal(resPreMonthly.executed[0].key, "preMonthlyReminder");
  assert.equal(resPreMonthly.executed[0].success, true);
  assert.ok(sentMessages[3].text.includes("2 DAYS TO MONTHLY DATE WITH THE SYSTEM"));

  // Test 2-day pre-annual reminder force trigger
  const resPreAnnual = await evaluateCadenceTriggers({
    safeSendMessage: mockSend,
    forceTrigger: "pre-annual"
  });
  assert.equal(resPreAnnual.executed.length, 1);
  assert.equal(resPreAnnual.executed[0].key, "preAnnualReminder");
  assert.equal(resPreAnnual.executed[0].success, true);
  assert.ok(sentMessages[4].text.includes("2 DAYS TO ANNUAL DATE WITH THE SYSTEM"));

  // Test 03:00 AM database backup force trigger
  const resBackup = await evaluateCadenceTriggers({
    safeSendMessage: mockSend,
    forceTrigger: "backup"
  });
  assert.equal(resBackup.executed.length, 1);
  assert.equal(resBackup.executed[0].key, "dbBackup");
  assert.equal(resBackup.executed[0].success, true);
  assert.ok(sentMessages[5].text.includes("DATABASE BACKUP SENTINEL: 03:00 AM SNAPSHOT"));
  assert.ok(sentMessages[4].text.includes("2 DAYS TO ANNUAL DATE WITH THE SYSTEM"));
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runSample1,
  runSample2,
  runSample3,
  runSample4,
  runSample5,
  runSample6,
  runSample7,
  runOrderLifecycleProbe
} from "./order_lifecycle_probe.mjs";

function logSampleReport(report) {
  console.log(`[SAMPLE_REPORT] ${JSON.stringify(report)}`);
}

describe("TMS Storefront -> Order Guard -> Payment Lifecycle Probe (7 samples x 1,000 requests = 7,000)", () => {
  it("Sample 1/7 (1,000 reqs): Healthy Happy Path + Full Hold->Commit Lifecycle + Idempotent Resumes", async () => {
    const report = await runSample1(1000);
    assert.equal(report.requests, 1000);
    assert.equal(report.inventory_check.oversold, false);
    logSampleReport(report);
  });

  it("Sample 2/7 (1,000 reqs): Premature Termination, TTL Expiry (10m+3m Grace), Late Recovery & Refund Guard", async () => {
    const report = await runSample2(1000);
    assert.equal(report.requests, 1000);
    assert.equal(report.inventory_check.sku_scarce.oversold, false);
    assert.equal(report.inventory_check.sku_grace.oversold, false);
    logSampleReport(report);
  });

  it("Sample 3/7 (1,000 reqs): Restarted Sessions, Active-Hold Resume, Order-ID Collision & Replay Guards", async () => {
    const report = await runSample3(1000);
    assert.equal(report.requests, 1000);
    assert.equal(report.inventory_check.oversold, false);
    logSampleReport(report);
  });

  it("Sample 4/7 (1,000 reqs): OOS Scarcity, Surebet Auto-Trim, Multi-Item Remedy & Live Restock Recovery", async () => {
    const report = await runSample4(1000);
    assert.equal(report.requests, 1000);
    assert.equal(report.inventory_check.sku_hot.oversold, false);
    logSampleReport(report);
  });

  it("Sample 5/7 (1,000 reqs): Invalid Carts, Unable-to-Add Constraints, Approval Gates & Self-Healing Remedies", async () => {
    const report = await runSample5(1000);
    assert.equal(report.requests, 1000);
    assert.equal(report.inventory_check.sku_gated.oversold, false);
    logSampleReport(report);
  });

  it("Sample 6/7 (1,000 reqs): No Internet, Unable-to-Load 5xx Outages, Exponential Backoff & Offline Queue Sync", async () => {
    const report = await runSample6(1000);
    assert.equal(report.requests, 1000);
    assert.equal(report.inventory_check.oversold, false);
    logSampleReport(report);
  });

  it("Sample 7/7 (1,000 reqs): Mixed Chaotic Production Simulation (Concurrent Flows + Mid-Day Restock + Global Invariants)", async () => {
    const report = await runSample7(1000);
    assert.equal(report.requests, 1000);
    assert.equal(report.total_accounted, 1000);
    logSampleReport(report);
  });

  it("Aggregator API: runOrderLifecycleProbe returns unified 7,000-request summary cleanly", async () => {
    const summary = await runOrderLifecycleProbe({ sampleId: "ALL", requestsPerSample: 1000 });
    assert.equal(summary.ok, true);
    assert.equal(summary.samples.length, 7);
    assert.equal(summary.totalRequests, 7000);
    assert.equal(summary.zeroOversells, true);
    assert.equal(summary.zeroLeakedHolds, true);
  });
});

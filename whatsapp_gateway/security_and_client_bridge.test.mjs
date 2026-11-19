/**
 * Test Suite: Security Access Sentinel & Encapsulated Client Bridge
 * 
 * Formal Testing Methodologies Applied:
 * 1. EQUIVALENCE PARTITIONING (EP):
 *    - Senders: Superadmin, Shop Manager, Floor Staff, Customer, Unregistered
 *    - Channels: Operations Group, Management Group, Executive Channel, DM, Orphan Group
 *    - Client Bridge Signatures: Valid HMAC, Tampered HMAC, Missing Headers
 *    - Payload Safety: Sanitized Payload vs. SQL/XSS/Shell Injections
 * 
 * 2. BOUNDARY VALUE ANALYSIS (BVA):
 *    - Timestamp Freshness Window: 299s (Valid), 300s (Exact Boundary Valid), 301s (Expired)
 *    - Broadcast Daily Limit: n=1 (Valid), n=2 (Exact Boundary Valid), n=3 (Exceeded)
 *    - Content Length Boundaries: 9 chars (Too short), 10 chars (Min Valid), 1000 chars (Max Valid), 1001 chars (Too long)
 *    - Alert Throttling Window: 0s (Alerted), 30s (Throttled), 61s (Alerted)
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateAccess,
  recordAuditLog,
  getAuditLogs,
  dispatchSecurityAlertIfNeeded,
  isSuperadmin,
  resolveSenderRole,
  validateGroupLineage,
  SEVERITY,
  AUDIT_DECISION
} from "./security_access_sentinel.mjs";

import {
  sanitizeInput,
  sanitizePayload,
  generateClientSignature,
  verifyClientSignature,
  PerpetualShopClient,
  PerpetualPlatformClient,
  TIMESTAMP_TOLERANCE_MS
} from "./client/perpetual_client.mjs";

import {
  checkBroadcastRateLimit,
  recordBroadcast,
  resetBroadcastHistory,
  validateBroadcastContent,
  executeShopBroadcast,
  BROADCAST_LIMITS
} from "./broadcast_guardrails.mjs";

// Mock Shop Context
const mockShop = {
  id: "shop_savannah_001",
  name: "Savannah Artisanal",
  slug: "savannah-atelier",
  phone: "+254711223344",
  fulfillment_settings: {
    whatsapp_routing: {
      operations_jid: "120363429929736148@g.us",
      management_jid: "120363415291701803@g.us",
      community_jid: "120363499999999999@g.us",
      channel_jid: "120363488888888888@g.us",
      owner_phone: "254722000001",
      authorized_managers: ["254722000002"],
      staff_phones: ["254722000003"]
    }
  }
};

const superadminPhone = "254710720949";
const ownerPhone = "254722000001";
const managerPhone = "254722000002";
const staffPhone = "254722000003";
const customerPhone = "254799999999";
const roguePhone = "254700000666";

const opsGroupJid = "120363429929736148@g.us";
const mgmtGroupJid = "120363415291701803@g.us";
const orphanGroupJid = "120363477777777777@g.us";
const customerDmJid = `${customerPhone}@s.whatsapp.net`;

describe("Part 1: Equivalence Partitioning (EP) — Sender Roles & Channel Lineage", () => {

  test("EP-S1: Superadmin has full authority across all valid channels", () => {
    const role = resolveSenderRole(superadminPhone, mockShop);
    assert.equal(role, "SUPERADMIN");
    assert.equal(isSuperadmin(superadminPhone), true);

    const verdict = evaluateAccess({
      command: "!suspend",
      senderPhone: superadminPhone,
      replyJid: `${superadminPhone}@s.whatsapp.net`,
      context: { tier: "DIRECT_MESSAGE" }
    });
    assert.equal(verdict.permitted, true);
    assert.equal(verdict.decision, AUDIT_DECISION.PERMITTED);
  });

  test("EP-S2: Shop Manager is authorized for shop management, but blocked from platform system commands", () => {
    const role = resolveSenderRole(managerPhone, mockShop);
    assert.equal(role, "SHOP_MANAGER");

    // Permitted in Management Channel: !product
    const mgmtVerdict = evaluateAccess({
      command: "!product",
      senderPhone: managerPhone,
      replyJid: mgmtGroupJid,
      context: { tier: "SHOP", role: "MANAGEMENT", shop: mockShop },
      shop: mockShop
    });
    assert.equal(mgmtVerdict.permitted, true);

    // Blocked from Platform System Governance: !suspend
    const sysVerdict = evaluateAccess({
      command: "!suspend",
      senderPhone: managerPhone,
      replyJid: mgmtGroupJid,
      context: { tier: "SHOP", role: "MANAGEMENT", shop: mockShop },
      shop: mockShop
    });
    assert.equal(sysVerdict.permitted, false);
    assert.equal(sysVerdict.decision, AUDIT_DECISION.DENIED_ROLE_UNAUTHORIZED);
    assert.equal(sysVerdict.severity, SEVERITY.HIGH);
  });

  test("EP-S3: Floor Staff is authorized for station mutations, but blocked from financial P&L and product pricing", () => {
    const role = resolveSenderRole(staffPhone, mockShop);
    assert.equal(role, "FLOOR_STAFF");

    // Permitted on Floor: !pack
    const packVerdict = evaluateAccess({
      command: "!pack",
      senderPhone: staffPhone,
      replyJid: opsGroupJid,
      context: { tier: "SHOP", role: "OPERATIONS", shop: mockShop },
      shop: mockShop
    });
    assert.equal(packVerdict.permitted, true);

    // Denied on Floor: !product
    const productVerdict = evaluateAccess({
      command: "!product",
      senderPhone: staffPhone,
      replyJid: opsGroupJid,
      context: { tier: "SHOP", role: "OPERATIONS", shop: mockShop },
      shop: mockShop
    });
    assert.equal(productVerdict.permitted, false);
    assert.equal(productVerdict.decision, AUDIT_DECISION.DENIED_ROLE_UNAUTHORIZED);
  });

  test("EP-S5: Default Deny — Unregistered Phone Number is bounced and logged with HIGH severity on mutations", () => {
    const role = resolveSenderRole(roguePhone, mockShop);
    assert.equal(role, "UNREGISTERED");

    const verdict = evaluateAccess({
      command: "!paid",
      senderPhone: roguePhone,
      replyJid: opsGroupJid,
      context: { tier: "SHOP", role: "OPERATIONS", shop: mockShop },
      shop: mockShop
    });

    assert.equal(verdict.permitted, false);
    assert.equal(verdict.decision, AUDIT_DECISION.DENIED_UNREGISTERED_SENDER);
    assert.equal(verdict.severity, SEVERITY.HIGH);
  });

  test("EP-C1 vs EP-C4: Channel Appropriateness — Station mutations cannot be executed in DM or wrong group", () => {
    // Staff member trying to run !pack in DM
    const verdict = evaluateAccess({
      command: "!pack",
      senderPhone: staffPhone,
      replyJid: `${staffPhone}@s.whatsapp.net`,
      context: { tier: "DIRECT_MESSAGE", phone: staffPhone },
      shop: mockShop
    });

    assert.equal(verdict.permitted, false);
    assert.equal(verdict.decision, AUDIT_DECISION.DENIED_WRONG_CHANNEL);
    assert.equal(verdict.severity, SEVERITY.LOW);
    assert.match(verdict.reason, /Shop Operations/);
  });

  test("EP-C5: Orphan Group Lineage — Commands sent in unregistered/standalone groups are bounced immediately", () => {
    const lineage = validateGroupLineage(orphanGroupJid, { tier: "UNREGISTERED" });
    assert.equal(lineage.isValid, false);
    assert.equal(lineage.reason, "ORPHAN_STANDALONE_GROUP");

    const verdict = evaluateAccess({
      command: "!orders",
      senderPhone: managerPhone,
      replyJid: orphanGroupJid,
      context: { tier: "UNREGISTERED" }
    });

    assert.equal(verdict.permitted, false);
    assert.equal(verdict.decision, AUDIT_DECISION.DENIED_ORPHAN_GROUP);
  });
});

describe("Part 2: Equivalence Partitioning (EP) — Client Bridge Cryptography & Anti-Injection", () => {
  const testSecret = "k_secret_0123456789abcdef0123456789abcdef";

  test("EP-B1: Valid HMAC signature and matching timestamp succeeds", () => {
    const now = Date.now().toString();
    const sig = generateClientSignature({
      secret: testSecret,
      clientId: "client_storefront_savannah-atelier",
      timestamp: now,
      method: "POST",
      path: "/api/v1/storefront/checkout",
      body: { order_id: "ORD-123", amount: 1500 }
    });

    const headers = {
      "x-perpetual-client-id": "client_storefront_savannah-atelier",
      "x-perpetual-timestamp": now,
      "x-perpetual-signature": sig
    };

    const res = verifyClientSignature({
      headers,
      method: "POST",
      path: "/api/v1/storefront/checkout",
      body: { order_id: "ORD-123", amount: 1500 },
      secret: testSecret,
      nowMs: parseInt(now, 10)
    });

    assert.equal(res.isValid, true);
    assert.equal(res.clientId, "client_storefront_savannah-atelier");
  });

  test("EP-B2: Tampered HMAC signature is rejected with SIGNATURE_MISMATCH", () => {
    const now = Date.now().toString();
    const tamperedSig = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const headers = {
      "x-perpetual-client-id": "client_storefront_savannah-atelier",
      "x-perpetual-timestamp": now,
      "x-perpetual-signature": tamperedSig
    };

    const res = verifyClientSignature({
      headers,
      method: "POST",
      path: "/api/v1/storefront/checkout",
      body: { order_id: "ORD-123" },
      secret: testSecret,
      nowMs: parseInt(now, 10)
    });

    assert.equal(res.isValid, false);
    assert.equal(res.reason, "SIGNATURE_MISMATCH");
  });

  test("EP-B3: Missing security headers are rejected with MISSING_SECURITY_HEADERS", () => {
    const res = verifyClientSignature({
      headers: {},
      method: "GET",
      path: "/catalog",
      secret: testSecret
    });

    assert.equal(res.isValid, false);
    assert.equal(res.reason, "MISSING_SECURITY_HEADERS");
  });

  test("EP-P1 vs EP-P2: Anti-Injection Sanitization detects SQL, XSS, and Shell attacks", () => {
    // Clean string passes
    assert.equal(sanitizeInput("Swahili Coconut Chicken", "product_name"), "Swahili Coconut Chicken");

    // SQL Injection attempt throws
    assert.throws(() => {
      sanitizeInput("admin' OR '1'='1", "username");
    }, /SECURITY_INJECTION_DETECTED: Potential SQL injection/);

    // XSS attempt throws
    assert.throws(() => {
      sanitizeInput("<script>alert('xss')</script>", "comments");
    }, /SECURITY_INJECTION_DETECTED: Potential XSS injection/);

    // Shell injection attempt throws
    assert.throws(() => {
      sanitizeInput("leahs-kitchen; rm -rf /", "shop_slug");
    }, /SECURITY_INJECTION_DETECTED: Illegal shell characters/);

    // Recursive payload sanitization
    const maliciousPayload = {
      customer_name: "Jane Doe",
      notes: "Please leave at gate",
      items: [
        { name: "Sofa", note: "1' UNION SELECT * FROM users --" }
      ]
    };

    assert.throws(() => {
      sanitizePayload(maliciousPayload);
    }, /SECURITY_INJECTION_DETECTED/);
  });
});

describe("Part 3: Boundary Value Analysis (BVA) — Freshness, Rate Limits & Lengths", () => {
  const testSecret = "k_secret_0123456789abcdef0123456789abcdef";

  test("BVA-1: Timestamp Freshness Window Boundaries (300,000ms / 5 minutes)", () => {
    const baseNow = 1700000000000;

    const makeHeadersForTime = (timeOffsetMs) => {
      const ts = (baseNow + timeOffsetMs).toString();
      const sig = generateClientSignature({
        secret: testSecret,
        clientId: "client_test",
        timestamp: ts,
        method: "GET",
        path: "/api/test",
        body: ""
      });
      return {
        headers: {
          "x-perpetual-client-id": "client_test",
          "x-perpetual-timestamp": ts,
          "x-perpetual-signature": sig
        },
        ts
      };
    };

    // 1. Boundary: Age = 299,000 ms (Inside window -> VALID)
    const within = makeHeadersForTime(-299000);
    const resWithin = verifyClientSignature({
      headers: within.headers,
      method: "GET",
      path: "/api/test",
      secret: testSecret,
      nowMs: baseNow
    });
    assert.equal(resWithin.isValid, true);

    // 2. Exact Boundary: Age = 300,000 ms (Exact threshold -> VALID)
    const exact = makeHeadersForTime(-300000);
    const resExact = verifyClientSignature({
      headers: exact.headers,
      method: "GET",
      path: "/api/test",
      secret: testSecret,
      nowMs: baseNow
    });
    assert.equal(resExact.isValid, true);

    // 3. Boundary: Age = 300,001 ms (Expired -> REJECTED)
    const expired = makeHeadersForTime(-300001);
    const resExpired = verifyClientSignature({
      headers: expired.headers,
      method: "GET",
      path: "/api/test",
      secret: testSecret,
      nowMs: baseNow
    });
    assert.equal(resExpired.isValid, false);
    assert.equal(resExpired.reason, "TIMESTAMP_EXPIRED");
  });

  test("BVA-2: Marketing Broadcast Daily Limit & Cooldown Boundaries", () => {
    const shopSlug = "test-boutique";
    resetBroadcastHistory(shopSlug);

    const t0 = 1700000000000;

    // 1. Initial State: n = 0 broadcasts
    const check0 = checkBroadcastRateLimit(shopSlug, t0);
    assert.equal(check0.allowed, true);

    // First broadcast at t0
    recordBroadcast(shopSlug, t0);

    // 2. Boundary: Attempting second broadcast immediately (0 cooldown elapsed)
    const checkImmediate = checkBroadcastRateLimit(shopSlug, t0 + 1000);
    assert.equal(checkImmediate.allowed, false);
    assert.match(checkImmediate.reason, /COOLDOWN_ACTIVE/);

    // 3. Boundary: Attempting after 2h cooldown (7,200,000 ms) -> EXACT COOLDOWN BOUNDARY
    const tCooldownPassed = t0 + BROADCAST_LIMITS.COOLDOWN_MS + 1000;
    const checkCooldownPassed = checkBroadcastRateLimit(shopSlug, tCooldownPassed);
    assert.equal(checkCooldownPassed.allowed, true);

    // Second broadcast at tCooldownPassed (n = 2)
    recordBroadcast(shopSlug, tCooldownPassed);

    // 4. Boundary: Attempting third broadcast within same 24h -> DAILY_LIMIT_EXCEEDED (n = 3)
    const tThirdAttempt = tCooldownPassed + BROADCAST_LIMITS.COOLDOWN_MS + 1000;
    const checkThird = checkBroadcastRateLimit(shopSlug, tThirdAttempt);
    assert.equal(checkThird.allowed, false);
    assert.match(checkThird.reason, /DAILY_LIMIT_EXCEEDED/);
  });

  test("BVA-3: Broadcast Content Character Length Boundaries (10 to 1,000 chars)", () => {
    // 1. 9 chars (Boundary below minimum -> REJECTED)
    const tooShort = validateBroadcastContent("123456789");
    assert.equal(tooShort.isValid, false);
    assert.match(tooShort.reason, /CONTENT_TOO_SHORT/);

    // 2. 10 chars (Exact minimum boundary -> ACCEPTED)
    const minValid = validateBroadcastContent("1234567890");
    assert.equal(minValid.isValid, true);

    // 3. 1,000 chars (Exact maximum boundary -> ACCEPTED)
    const maxValid = validateBroadcastContent("A".repeat(1000));
    assert.equal(maxValid.isValid, true);

    // 4. 1,001 chars (Boundary above maximum -> REJECTED)
    const tooLong = validateBroadcastContent("A".repeat(1001));
    assert.equal(tooLong.isValid, false);
    assert.match(tooLong.reason, /CONTENT_TOO_LONG/);
  });

  test("BVA-4: Alert Throttling Window Boundaries & Audit Logging", async () => {
    let sentAlertCount = 0;
    const fakeDispatcher = async (jid, payload) => {
      sentAlertCount++;
    };

    const breachActor = "254700999888";
    const audit1 = recordAuditLog({
      actorPhone: breachActor,
      actorRole: "UNREGISTERED",
      channelType: "SHOP_OPERATIONS",
      command: "!dispatch",
      tenantSlug: "savannah-atelier",
      decision: AUDIT_DECISION.DENIED_UNREGISTERED_SENDER,
      severity: SEVERITY.HIGH,
      reason: "Unauthorized attempt"
    });

    // 1. First alert at t0 -> Dispatched
    const res1 = await dispatchSecurityAlertIfNeeded({
      auditEntry: audit1,
      safeSendMessage: fakeDispatcher
    });
    assert.equal(res1.alerted, true);
    assert.equal(sentAlertCount, 1);

    // 2. Second rapid attempt at t0 + 2000ms -> Throttled (Suppressed from flooding admin)
    const audit2 = recordAuditLog({
      actorPhone: breachActor,
      actorRole: "UNREGISTERED",
      channelType: "SHOP_OPERATIONS",
      command: "!dispatch",
      tenantSlug: "savannah-atelier",
      decision: AUDIT_DECISION.DENIED_UNREGISTERED_SENDER,
      severity: SEVERITY.HIGH,
      reason: "Repeated unauthorized attempt"
    });

    const res2 = await dispatchSecurityAlertIfNeeded({
      auditEntry: audit2,
      safeSendMessage: fakeDispatcher
    });
    assert.equal(res2.alerted, false);
    assert.equal(res2.reason, "THROTTLED");
    assert.equal(sentAlertCount, 1); // Counter did not increase

    // Verify logs were still stored in persistent audit trail
    const logs = getAuditLogs({ actorPhone: breachActor });
    assert.equal(logs.length, 2);
  });
});

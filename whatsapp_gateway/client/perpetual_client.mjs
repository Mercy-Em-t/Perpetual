/**
 * Encapsulated Perpetual Client Bridge & Security Middleware
 * Provides:
 * 1. Cryptographic HMAC Request Signing & Header Verification.
 * 2. Replay Attack Defense (Timestamp Freshness Window: 300s).
 * 3. Anti-Injection Sanitization (SQL, XSS, Command Injection).
 * 4. PerpetualPlatformClient: Root Admin Bird's Eye View & Governance.
 * 5. PerpetualShopClient: Isolated Tenant-Scoped Commerce Pipe (Zero Contamination).
 */

import crypto from "crypto";

export const TIMESTAMP_TOLERANCE_MS = 300 * 1000; // 300 seconds (5 minutes)

/**
 * Sanitizes input strings against SQL, XSS, and Shell Command Injections.
 * Throws an error or returns sanitized output.
 */
export function sanitizeInput(input, fieldName = "input") {
  if (input === null || input === undefined) return input;
  if (typeof input !== "string") return input;

  const raw = String(input);

  // 1. Cross-Site Scripting (XSS) Signatures
  const xssPattern = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>|javascript:|onerror\s*=|onload\s*=/i;
  if (xssPattern.test(raw)) {
    throw new Error(`SECURITY_INJECTION_DETECTED: Potential XSS injection in ${fieldName}`);
  }

  // 2. SQL Injection Signatures (Guards against SQL vectors while allowing normal apostrophes e.g. "Leah's Kitchen")
  const sqlPattern = /('\s*(?:or|and|union|select|drop|insert|delete|update)\b|--|\/\*|\*\/|union\s+select|drop\s+table|insert\s+into|delete\s+from|update\s+.*\s+set)/i;
  if (sqlPattern.test(raw)) {
    throw new Error(`SECURITY_INJECTION_DETECTED: Potential SQL injection in ${fieldName}`);
  }

  // 3. Shell Command Injection Signatures
  const shellPattern = /[;&|`$><]/;
  if (shellPattern.test(raw) && (fieldName.includes("cmd") || fieldName.includes("exec") || fieldName.includes("slug"))) {
    throw new Error(`SECURITY_INJECTION_DETECTED: Illegal shell characters in ${fieldName}`);
  }

  return raw.trim();
}

/**
 * Recursively sanitizes an entire object/payload.
 */
export function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    return payload.map((item, idx) => sanitizePayload(item));
  }

  const clean = {};
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val === "string") {
      clean[key] = sanitizeInput(val, key);
    } else if (typeof val === "object" && val !== null) {
      clean[key] = sanitizePayload(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

/**
 * Generates HMAC-SHA256 signature for client bridge requests.
 */
export function generateClientSignature({
  secret,
  clientId,
  timestamp,
  method,
  path,
  body = ""
}) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body || {});
  const canonicalString = `${timestamp}:${clientId}:${method.toUpperCase()}:${path}:${bodyStr}`;
  return crypto.createHmac("sha256", secret).update(canonicalString).digest("hex");
}

/**
 * Verifies inbound HMAC-SHA256 signature & timestamp freshness.
 */
export function verifyClientSignature({
  headers,
  method,
  path,
  body = "",
  secret,
  nowMs = Date.now()
}) {
  const clientId = headers["x-perpetual-client-id"] || headers["X-Perpetual-Client-Id"];
  const timestampHeader = headers["x-perpetual-timestamp"] || headers["X-Perpetual-Timestamp"];
  const signature = headers["x-perpetual-signature"] || headers["X-Perpetual-Signature"];

  if (!clientId || !timestampHeader || !signature) {
    return {
      isValid: false,
      reason: "MISSING_SECURITY_HEADERS",
      details: "Headers 'x-perpetual-client-id', 'x-perpetual-timestamp', and 'x-perpetual-signature' are required."
    };
  }

  const reqTime = parseInt(timestampHeader, 10);
  if (isNaN(reqTime)) {
    return { isValid: false, reason: "INVALID_TIMESTAMP_FORMAT" };
  }

  // Replay Attack Defense: Boundary Check
  const age = Math.abs(nowMs - reqTime);
  if (age > TIMESTAMP_TOLERANCE_MS) {
    return {
      isValid: false,
      reason: "TIMESTAMP_EXPIRED",
      details: `Request age (${age}ms) exceeds tolerance (${TIMESTAMP_TOLERANCE_MS}ms).`
    };
  }

  const expectedSig = generateClientSignature({
    secret,
    clientId,
    timestamp: timestampHeader,
    method,
    path,
    body
  });

  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSig, "hex");

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return {
      isValid: false,
      reason: "SIGNATURE_MISMATCH",
      details: "HMAC signature does not match expected digest."
    };
  }

  return { isValid: true, clientId, reqTime };
}

// =============================================================================
// PERPETUAL PLATFORM CLIENT (Root Admin Bird's Eye View)
// =============================================================================
export class PerpetualPlatformClient {
  constructor({ baseUrl = "http://localhost:5174", adminSecret, adminPhone = "254710720949" }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.adminSecret = adminSecret;
    this.adminPhone = adminPhone;
    this.clientId = "client_admin_master";
  }

  _buildHeaders(method, path, body = "") {
    const timestamp = Date.now().toString();
    const signature = generateClientSignature({
      secret: this.adminSecret,
      clientId: this.clientId,
      timestamp,
      method,
      path,
      body
    });

    return {
      "Content-Type": "application/json",
      "x-perpetual-client-id": this.clientId,
      "x-perpetual-timestamp": timestamp,
      "x-perpetual-signature": signature,
      "x-admin-phone": this.adminPhone
    };
  }

  async getPlatformHealth() {
    const path = "/api/v1/platform/health";
    const headers = this._buildHeaders("GET", path);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    return await res.json();
  }

  async getAuditTrail(filter = {}) {
    const query = new URLSearchParams(filter).toString();
    const path = `/api/v1/platform/audit${query ? `?${query}` : ""}`;
    const headers = this._buildHeaders("GET", path);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    return await res.json();
  }

  async suspendShop(shopSlug, reason) {
    const path = `/api/v1/platform/shops/${encodeURIComponent(shopSlug)}/suspend`;
    const cleanReason = sanitizeInput(reason, "reason");
    const body = JSON.stringify({ reason: cleanReason, actor: this.adminPhone });
    const headers = this._buildHeaders("POST", path, body);
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers, body });
    return await res.json();
  }

  async reinstateShop(shopSlug, reason) {
    const path = `/api/v1/platform/shops/${encodeURIComponent(shopSlug)}/reinstate`;
    const cleanReason = sanitizeInput(reason, "reason");
    const body = JSON.stringify({ reason: cleanReason, actor: this.adminPhone });
    const headers = this._buildHeaders("POST", path, body);
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers, body });
    return await res.json();
  }
}

// =============================================================================
// PERPETUAL SHOP CLIENT (Isolated Tenant Pipe - Zero Cross-Tenant Contamination)
// =============================================================================
export class PerpetualShopClient {
  constructor({ shopSlug, clientSecret, baseUrl = "http://localhost:5174" }) {
    if (!shopSlug) throw new Error("PerpetualShopClient requires 'shopSlug'");
    if (!clientSecret) throw new Error("PerpetualShopClient requires 'clientSecret'");

    this.shopSlug = sanitizeInput(shopSlug, "shopSlug");
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.clientId = `client_storefront_${this.shopSlug}`;
  }

  _buildHeaders(method, path, body = "") {
    const timestamp = Date.now().toString();
    const signature = generateClientSignature({
      secret: this.clientSecret,
      clientId: this.clientId,
      timestamp,
      method,
      path,
      body
    });

    return {
      "Content-Type": "application/json",
      "x-perpetual-client-id": this.clientId,
      "x-perpetual-timestamp": timestamp,
      "x-perpetual-signature": signature,
      "x-tenant-slug": this.shopSlug
    };
  }

  async getCatalog() {
    const path = `/api/v1/storefront/${encodeURIComponent(this.shopSlug)}/catalog`;
    const headers = this._buildHeaders("GET", path);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    return await res.json();
  }

  async submitCheckout(orderPayload) {
    // 1. Sanitize all customer input (Strict Anti-Injection)
    const sanitized = sanitizePayload(orderPayload);
    // 2. Enforce Tenant Partitioning
    sanitized.shop_slug = this.shopSlug;

    const path = `/api/v1/storefront/checkout`;
    const body = JSON.stringify(sanitized);
    const headers = this._buildHeaders("POST", path, body);

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body
    });
    return await res.json();
  }

  async getOrderStatus(orderId) {
    const cleanId = sanitizeInput(orderId, "orderId");
    const path = `/api/v1/storefront/${encodeURIComponent(this.shopSlug)}/orders/${encodeURIComponent(cleanId)}`;
    const headers = this._buildHeaders("GET", path);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    return await res.json();
  }
}

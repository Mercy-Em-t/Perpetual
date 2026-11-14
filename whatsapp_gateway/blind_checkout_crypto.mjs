/**
 * Blind Checkout Cryptography (Split-Key Envelope)
 *
 * Isolates Customer PII from the Order Guard / Stock Inspector module:
 * - `pii_sealed` is encrypted with `PII_ENCRYPTION_KEY` (AES-256-GCM).
 *   The Order Guard module NEVER receives `PII_ENCRYPTION_KEY` and cannot decrypt it.
 * - `order_sealed` is encrypted with `ORDER_GUARD_KEY` (AES-256-GCM).
 *   The Order Guard decrypts ONLY `order_sealed` (items, shop_id, customer_hash).
 * - `customer_hash` is a one-way HMAC-SHA256 of the canonicalized phone number so
 *   per-customer daily limits can be enforced without exposing the phone number.
 */

import crypto from "crypto";

function normalizeKey(keyInput, purpose) {
  if (Buffer.isBuffer(keyInput) && keyInput.length === 32) {
    return keyInput;
  }
  if (typeof keyInput === "string" && keyInput.length > 0) {
    return crypto.createHash("sha256").update(`${purpose}:${keyInput}`).digest();
  }
  throw new Error(`Missing encryption key for ${purpose}`);
}

/**
 * Encrypts a JSON-serializable object with AES-256-GCM.
 * Returns an opaque string token: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 */
export function sealWithKey(payload, keyInput, purpose = "generic") {
  const key = normalizeKey(keyInput, purpose);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

/**
 * Decrypts a `v1.<iv>.<tag>.<ciphertext>` token with AES-256-GCM.
 * Enforces strict 12-byte IV and 16-byte GCM auth tag lengths.
 */
export function unsealWithKey(token, keyInput, purpose = "generic") {
  if (typeof token !== "string" || !token.startsWith("v1.")) {
    throw new Error("Invalid sealed envelope format");
  }
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed sealed envelope");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = normalizeKey(keyInput, purpose);
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(dataB64, "base64url");

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid GCM IV or authentication tag length");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Canonicalizes Kenyan/international phone formats (0712..., +254712..., 254712..., 0712-345-678)
 * so equivalent numbers always produce the same blind HMAC hash.
 */
export function canonicalizePhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0") && digits.length === 10) {
    return `254${digits.slice(1)}`;
  }
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) {
    return `254${digits}`;
  }
  return digits;
}

/**
 * Computes a one-way pseudonymous customer identifier for daily rate/qty limits.
 * If no phone/identity is provided, uses a random per-request token so anonymous
 * buyers do not share a single global quota bucket.
 */
export function hashCustomerIdentity(phoneOrId, hmacSecret) {
  const canonical = canonicalizePhone(phoneOrId);
  const normalized = canonical || String(phoneOrId || "").replace(/\s+/g, "").toLowerCase();
  const input = normalized || `anon:${crypto.randomBytes(12).toString("hex")}`;
  const secret = hmacSecret || "dev-order-guard-hmac";
  return crypto.createHmac("sha256", secret).update(input).digest("hex").slice(0, 24);
}

/**
 * Splits a raw checkout request into a dual-encrypted envelope:
 * - `pii_sealed`: encrypted with `piiKey` (unreadable by Order Guard)
 * - `order_sealed`: encrypted with `inspectorKey` (readable by Order Guard)
 * Note: Never forwards client-supplied `customer_tier` (tier is server-authoritative).
 */
export function sealCheckoutEnvelope(rawCheckout, { piiKey, inspectorKey, hmacSecret }) {
  const {
    order_id,
    shop_id,
    shop_slug,
    items = [],
    partial_fill_mode = "strict",
    fulfillment_type = "pickup",
    customer_name = "",
    customer_phone = "",
    delivery_address = "",
    notes = "",
    coupon_code = "",
    ...extraPii
  } = rawCheckout || {};

  const customer_hash = hashCustomerIdentity(customer_phone || customer_name, hmacSecret);

  const piiPayload = {
    customer_name,
    customer_phone,
    delivery_address,
    notes,
    coupon_code,
    extra: extraPii,
    sealed_at: new Date().toISOString()
  };

  const inspectablePayload = {
    order_id: order_id || null,
    shop_id: shop_id || shop_slug || "default",
    shop_slug: shop_slug || null,
    items: (Array.isArray(items) ? items : []).map((it) => {
      const rawPrice = it.unit_price ?? it.price ?? 0;
      const numPrice = Number(rawPrice);
      return {
        id: String(it.id || it.item_id || it.name || "").trim(),
        name: String(it.name || it.id || "Item").trim(),
        qty: Number(it.qty ?? it.quantity ?? 1),
        unit_price: Number.isFinite(numPrice) ? numPrice : null
      };
    }),
    customer_hash,
    partial_fill_mode,
    fulfillment_type
  };

  return {
    envelope_version: "1.0",
    order_id: inspectablePayload.order_id,
    pii_sealed: sealWithKey(piiPayload, piiKey, "pii"),
    order_sealed: sealWithKey(inspectablePayload, inspectorKey, "order_guard")
  };
}

/**
 * Used exclusively by the Order Guard Inspector.
 * Receives the whole checkout envelope, decrypts ONLY `order_sealed`,
 * and leaves `pii_sealed` completely untouched/opaque.
 */
export function decryptInspectablePart(envelope, inspectorKey) {
  if (!envelope || !envelope.order_sealed) {
    throw new Error("Missing order_sealed in checkout envelope");
  }
  return unsealWithKey(envelope.order_sealed, inspectorKey, "order_guard");
}

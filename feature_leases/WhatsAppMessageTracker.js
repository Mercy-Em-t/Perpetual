/**
 * ==============================================================================
 * TMS LEASED FEATURE - WHATSAPP MESSAGE TRACKER & LOCALIZED LEDGER MODULE
 * ==============================================================================
 * Localizes outbound message tracking, deduplication, rate-limiting, and
 * loop prevention into a dedicated, reusable module.
 * 
 * Responsibilities:
 * 1. Rolling memory + disk ledger of all outbound messages sent by the bot.
 * 2. Instant O(1) deduplication: identifies whether any incoming message was sent by the bot.
 * 3. Per-recipient rate limiting / cooldown protection to prevent cascade floods.
 * 4. Audit ledger with exportable summaries and tabular reporting.
 * ==============================================================================
 */

import fs from "fs";
import path from "path";

export class WhatsAppMessageTracker {
  /**
   * @param {Object} options
   * @param {number} [options.maxLedgerSize=500] - Max messages to retain in rolling buffer
   * @param {number} [options.cooldownMs=3000] - Minimum milliseconds between outbound messages to same recipient
   * @param {string} [options.storageFile] - Path to save on-disk ledger
   */
  constructor(options = {}) {
    this.maxLedgerSize = options.maxLedgerSize || 500;
    this.cooldownMs = options.cooldownMs || 3000;
    this.storageFile = options.storageFile !== undefined
      ? options.storageFile
      : path.resolve(process.cwd(), ".auth_whatsapp_baileys/outbox_ledger.json");

    // Localized in-memory registries
    this.sentIds = new Set();
    this.ledger = [];
    this.lastSentTimestampByRecipient = new Map();

    if (this.storageFile) {
      this.loadFromDisk();
    }
  }

  /**
   * Checks whether a message ID originated from this bot
   * @param {string} messageId
   * @returns {boolean}
   */
  isBotMessage(messageId) {
    if (!messageId) return false;
    return this.sentIds.has(messageId);
  }

  /**
   * Evaluates if a new message can be sent to this recipient under the rate limiter
   * @param {string} recipientJid
   * @param {number} [customCooldownMs]
   * @returns {{ allowed: boolean, remainingMs: number }}
   */
  canSend(recipientJid, customCooldownMs) {
    const cooldown = customCooldownMs !== undefined ? customCooldownMs : this.cooldownMs;
    const cleanJid = (recipientJid || "default").trim();
    const lastSent = this.lastSentTimestampByRecipient.get(cleanJid) || 0;
    const now = Date.now();
    const elapsed = now - lastSent;

    if (elapsed < cooldown) {
      return {
        allowed: false,
        remainingMs: cooldown - elapsed,
      };
    }

    return {
      allowed: true,
      remainingMs: 0,
    };
  }

  /**
   * Registers a message sent by the bot into the localized ledger
   * @param {Object} record - { id, recipient, text, eventType, reporter }
   * @returns {Object} The tracked message record
   */
  recordSentMessage(record = {}) {
    const messageId = record.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const recipient = record.recipient || "UNKNOWN";
    const textSnippet = (record.text || "").slice(0, 120);
    const now = Date.now();

    const entry = {
      id: messageId,
      recipient,
      eventType: record.eventType || "AUTONOMOUS_BROADCAST",
      reporter: record.reporter || "Autonomous WhatsApp Bot Daemon",
      textSnippet,
      sentAt: new Date(now).toISOString(),
      timestamp: now,
    };

    // 1. Add to deduplication Set
    this.sentIds.add(messageId);

    // 2. Update rate limiter clock
    this.lastSentTimestampByRecipient.set(recipient, now);

    // 3. Append to rolling ledger
    this.ledger.push(entry);

    // Cap memory buffer
    if (this.ledger.length > this.maxLedgerSize) {
      const removed = this.ledger.shift();
      if (removed && removed.id) {
        this.sentIds.delete(removed.id);
      }
    }

    this.saveToDisk();
    return entry;
  }

  /**
   * Returns recent messages from the localized ledger
   * @param {number} [limit=20]
   * @returns {Array<Object>}
   */
  getRecent(limit = 20) {
    return this.ledger.slice(-limit).reverse();
  }

  /**
   * Total count of tracked outbound messages
   * @returns {number}
   */
  getCount() {
    return this.ledger.length;
  }

  /**
   * Returns a structured table representation for telemetry dashboards
   * @param {number} [limit=10]
   * @returns {Array<Object>}
   */
  tabulate(limit = 10) {
    return this.getRecent(limit).map((m) => ({
      "Message ID": m.id,
      "Recipient": m.recipient,
      "Event Type": m.eventType,
      "Reporter": m.reporter,
      "Snippet": m.textSnippet,
      "Sent Time": new Date(m.timestamp).toLocaleTimeString(),
    }));
  }

  /**
   * Clears in-memory and on-disk ledger
   */
  clear() {
    this.sentIds.clear();
    this.ledger = [];
    this.lastSentTimestampByRecipient.clear();
    this.saveToDisk();
  }

  /**
   * Persists ledger to disk safely
   */
  saveToDisk() {
    if (!this.storageFile) return;
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.storageFile,
        JSON.stringify(this.ledger.slice(-this.maxLedgerSize), null, 2),
        "utf-8"
      );
    } catch {
      // Non-blocking disk fallback
    }
  }

  /**
   * Loads ledger from disk on initialization
   */
  loadFromDisk() {
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return;
    try {
      const raw = fs.readFileSync(this.storageFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.ledger = parsed;
        this.sentIds = new Set(parsed.map((p) => p.id).filter(Boolean));
      }
    } catch {
      // Corrupt or empty file fallback
      this.ledger = [];
      this.sentIds.clear();
    }
  }
}

// Global default singleton instance
export const defaultMessageTracker = new WhatsAppMessageTracker();

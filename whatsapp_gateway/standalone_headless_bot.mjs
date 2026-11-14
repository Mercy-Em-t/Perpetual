#!/usr/bin/env node
/**
 * ==============================================================================
 * TMS LEASED FEATURE - AUTONOMOUS HEADLESS WHATSAPP BROADCAST BOT & ORDER GATEWAY
 * ==============================================================================
 * Connects directly to WhatsApp as a paired Multi-Device node using Baileys.
 * 
 * Workflow:
 * 1. Persists session credentials securely in ./.auth_whatsapp_baileys/
 * 2. On QR scan / connection open, automatically provisions (or locates existing):
 *    - "Leah's Kitchen" (Community & Storefront Hub Group)
 *    - "Leah's Kitchen - Group Orders" (Live Order Tickets + Stage 1 & 2 BAG-01 Slips)
 * 3. Listens to "tms_lease_broadcast_channel" AND local HTTP IPC on port 5174.
 * 4. Dispatches individual kitchen order tickets immediately into "Leah's Kitchen - Group Orders".
 * 5. Consolidates clustered orders into the Two-Stage Executive Prep & Bagging Digest.
 * ==============================================================================
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs";
import path from "path";
import http from "node:http";
import crypto from "node:crypto";
import { formatMessageForWhatsApp } from "../src/sandbox/leases/WhatsAppChannelBridge.js";
import { createLeaseReceiver } from "../src/sandbox/leases/LeaseBroadcastBridge.js";
import { defaultMessageTracker } from "../src/sandbox/leases/WhatsAppMessageTracker.js";
import { defaultOrderClusteringEngine } from "../src/sandbox/leases/OrderClusteringEngine.js";
import { processShopInboundInput } from "../src/sandbox/leases/ShopInboundCommandEngine.js";

const packedBagsRegistry = new Set();

const CANDIDATE_AUTH_DIRS = [
  ...(process.env.WHATSAPP_AUTH_DIR ? [path.resolve(process.env.WHATSAPP_AUTH_DIR)] : []),
  path.resolve("C:/Users/user/Documents/microservices/whatsapp-service/.auth_whatsapp_baileys"),
  path.resolve("C:/Users/user/Documents/Server/whatsapp_service/.auth_whatsapp_baileys"),
  path.resolve(process.cwd(), ".auth_whatsapp_baileys"),
];

function isValidCredsFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < 50) return false;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Boolean(parsed && parsed.noiseKey && parsed.signedIdentityKey);
  } catch {
    return false;
  }
}

const AUTH_DIR =
  CANDIDATE_AUTH_DIRS.find(d => isValidCredsFile(path.join(d, "creds.json")) || isValidCredsFile(path.join(d, "creds.backup.json"))) ||
  CANDIDATE_AUTH_DIRS[0];
const GROUPS_CACHE_FILE = path.join(AUTH_DIR, "leahs_kitchen_groups.json");
const LOCAL_PNG = path.resolve(process.cwd(), "whatsapp-qr.png");
const PUBLIC_PNG = path.resolve(process.cwd(), "public/whatsapp-qr.png");
const ARTIFACT_PNG = path.resolve(
  process.env.WHATSAPP_QR_ARTIFACT_PATH ||
    "C:/Users/user/.gemini/antigravity/brain/33602b22-2a61-4a59-950f-d014ac622559/whatsapp-qr.png"
);
const CHANNEL_NAME = "tms_lease_broadcast_channel";
const HTTP_PORT = Number(process.env.WHATSAPP_HTTP_PORT || 5174);
const HTTP_HOST = process.env.WHATSAPP_HTTP_HOST || "127.0.0.1";

// ---------------------------------------------------------------------------
// Gateway security configuration
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = new Set(
  (process.env.LK_ALLOWED_HOSTS || "localhost,127.0.0.1,host.docker.internal")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
);
const ALLOWED_ORIGINS = new Set(
  (process.env.LK_ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map((o) => o.trim()).filter(Boolean)
);
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_PER_MIN = 120;
const AUTH_FAIL_LIMIT = 10;
const AUTH_LOCKOUT_MS = 5 * 60 * 1000;

/** Token comes from LK_GATEWAY_TOKEN, else a random one persisted next to the auth files. */
function loadGatewayToken() {
  if (process.env.LK_GATEWAY_TOKEN && process.env.LK_GATEWAY_TOKEN.length >= 16) {
    return process.env.LK_GATEWAY_TOKEN;
  }
  const tokenFile = path.join(AUTH_DIR, "gateway_token");
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    if (fs.existsSync(tokenFile)) {
      const existing = fs.readFileSync(tokenFile, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(tokenFile, generated, { encoding: "utf8", mode: 0o600 });
    console.log(`🔑 Generated gateway token (stored in ${tokenFile})`);
    return generated;
  } catch (err) {
    console.warn(`⚠️ Could not persist gateway token (${err.message}); using an in-memory token for this run.`);
    return crypto.randomBytes(32).toString("hex");
  }
}
const GATEWAY_TOKEN = loadGatewayToken();

function tokensMatch(presented, expected) {
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const rateBuckets = new Map(); // ip -> { windowStart, count, fails, lockedUntil }
function bucketFor(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.windowStart > 60000) {
    b = { windowStart: now, count: 0, fails: b ? b.fails : 0, lockedUntil: b ? b.lockedUntil : 0 };
    rateBuckets.set(ip, b);
  }
  return b;
}
function checkRateLimit(ip) {
  const now = Date.now();
  const b = bucketFor(ip);
  if (b.lockedUntil > now) return { ok: false, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
  b.count++;
  if (b.count > RATE_LIMIT_PER_MIN) return { ok: false, retryAfterSec: 60 };
  return { ok: true };
}
function recordAuthFailure(ip) {
  const b = bucketFor(ip);
  b.fails++;
  if (b.fails >= AUTH_FAIL_LIMIT) {
    b.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
    b.fails = 0;
    console.warn(`🚨 [GATEWAY SECURITY] ${ip} locked out for 5 minutes after repeated failed authentication.`);
  }
}

const COMMUNITY_GROUP_SUBJECT = "Leah's Kitchen";
const ORDERS_GROUP_SUBJECT = "Leah's Kitchen - Group Orders";

/**
 * Exponential Backoff Decay for the 15-Minute Grace Window (17:00–17:15):
 * Slice 0 (17:00–17:08): 8m | Slice 1 (17:08–17:12): 4m | Slice 2 (17:12–17:14): 2m | Slice 3 (17:14–17:15): 1m
 */
function evaluateOrderGraceWindow(orderDateInput, cartStartedAtInput) {
  const nowDate = orderDateInput ? new Date(orderDateInput) : new Date();
  const cutoffDate = new Date(nowDate);
  cutoffDate.setHours(17, 0, 0, 0);
  const hardCutoffDate = new Date(cutoffDate.getTime() + 15 * 60 * 1000);

  const isCutoffPassed = nowDate >= cutoffDate;
  const isHardCutoffPassed = nowDate >= hardCutoffDate;
  const isGraceActive = isCutoffPassed && !isHardCutoffPassed;
  const cartStart = cartStartedAtInput ? new Date(cartStartedAtInput) : null;
  const isCartStartedBeforeCutoff = Boolean(cartStart && cartStart < cutoffDate);

  let graceBackoff = null;
  if (isGraceActive) {
    const elapsedMin = (nowDate.getTime() - cutoffDate.getTime()) / (1000 * 60);
    if (elapsedMin < 8) {
      graceBackoff = { sliceIndex: 0, sliceAllocationMinutes: 8, decayFormula: "8m -> 4m -> 2m -> 1m (Slice 1/4: 8m Soft-Landing)" };
    } else if (elapsedMin < 12) {
      graceBackoff = { sliceIndex: 1, sliceAllocationMinutes: 4, decayFormula: "8m -> 4m -> 2m -> 1m (Slice 2/4: 4m Backoff Extension)" };
    } else if (elapsedMin < 14) {
      graceBackoff = { sliceIndex: 2, sliceAllocationMinutes: 2, decayFormula: "8m -> 4m -> 2m -> 1m (Slice 3/4: 2m Backoff Extension)" };
    } else {
      graceBackoff = { sliceIndex: 3, sliceAllocationMinutes: 1, decayFormula: "8m -> 4m -> 2m -> 1m (Slice 4/4: 1m Final Kitchen Lock)" };
    }
  }

  return {
    isGraceActive,
    gracePeriodApproved: isGraceActive || isCartStartedBeforeCutoff,
    graceBackoff
  };
}

/**
 * Exponential Backoff with Jitter: delay = min(maxDelayMs, baseDelayMs * 2^attempt + jitter)
 */
function computeBackoffDelayMs(attempt, baseDelayMs = 400, maxDelayMs = 15000) {
  const exp = baseDelayMs * Math.pow(2, Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * 150);
  return Math.min(maxDelayMs, exp + jitter);
}

async function sendMessageWithBackoff(sock, jid, content, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await sock.sendMessage(jid, content);
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      const waitMs = computeBackoffDelayMs(attempt, 400, 6000);
      console.warn(`⏳ [EXPONENTIAL BACKOFF] Send attempt ${attempt + 1} failed (${err.message}). Retrying in ${waitMs}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// Command line arguments
const args = process.argv.slice(2);
let targetRecipient = process.env.WHATSAPP_TARGET_JID || "";

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--target" || args[i] === "--phone" || args[i] === "--recipient") && args[i + 1]) {
    targetRecipient = args[i + 1].trim();
    i++;
  }
}

function formatJid(input) {
  if (!input) return null;
  if (input.includes("@")) return input;
  const cleanPhone = input.replace(/[^0-9]/g, "");
  return `${cleanPhone}@s.whatsapp.net`;
}

async function createGroupWithBackoff(sock, subject, participants, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await sock.groupCreate(subject, participants);
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      const waitMs = computeBackoffDelayMs(attempt, 2500, 12000);
      console.warn(`⏳ [GROUP CREATE BACKOFF] "${subject}" attempt ${attempt + 1} hit ${err.message}. Retrying in ${waitMs}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

/**
 * Automatically discovers or creates the "Leah's Kitchen" Community Group
 * and "Leah's Kitchen - Group Orders" dispatch group on WhatsApp.
 */
async function ensureLeahsKitchenGroups(sock, userJid) {
  let cached = {};
  if (fs.existsSync(GROUPS_CACHE_FILE)) {
    try {
      cached = JSON.parse(fs.readFileSync(GROUPS_CACHE_FILE, "utf8"));
    } catch {}
  }

  let communityGroupJid = cached.communityGroupJid || null;
  let ordersGroupJid = cached.ordersGroupJid || null;

  try {
    console.log(`🔍 Checking existing WhatsApp groups for "${COMMUNITY_GROUP_SUBJECT}" and "${ORDERS_GROUP_SUBJECT}"...`);
    const participating = await sock.groupFetchAllParticipating();
    const groups = Object.values(participating || {});

    for (const g of groups) {
      const subject = (g.subject || "").trim();
      if (subject.toLowerCase() === COMMUNITY_GROUP_SUBJECT.toLowerCase()) {
        communityGroupJid = g.id;
      }
      if (subject.toLowerCase() === ORDERS_GROUP_SUBJECT.toLowerCase()) {
        ordersGroupJid = g.id;
      }
    }
  } catch (err) {
    console.warn(`⚠️ Could not fetch participating groups list (${err.message}), proceeding with cache/create.`);
  }

  // 1. Provision "Leah's Kitchen" Community Group if missing
  if (!communityGroupJid) {
    try {
      console.log(`🏗️ Creating WhatsApp Group: "${COMMUNITY_GROUP_SUBJECT}"...`);
      const createdCommunity = await createGroupWithBackoff(sock, COMMUNITY_GROUP_SUBJECT, [userJid]);
      communityGroupJid = createdCommunity?.id || null;
      if (communityGroupJid) {
        try {
          await sock.groupUpdateDescription(
            communityGroupJid,
            "🍲 Official Leah's Kitchen Community Hub — Daily Menu Drops, Pre-Order Cutoff Alerts (5:00 PM + 15m Grace Window) & Specials."
          );
        } catch {}
        console.log(`✅ Created "${COMMUNITY_GROUP_SUBJECT}" -> ${communityGroupJid}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.warn(`⚠️ Could not auto-create "${COMMUNITY_GROUP_SUBJECT}": ${err.message}`);
    }
  } else {
    console.log(`✅ Found existing "${COMMUNITY_GROUP_SUBJECT}" -> ${communityGroupJid}`);
  }

  // 2. Provision "Leah's Kitchen - Group Orders" Group if missing
  if (!ordersGroupJid) {
    try {
      console.log(`🏗️ Creating WhatsApp Group: "${ORDERS_GROUP_SUBJECT}"...`);
      const createdOrdersGroup = await createGroupWithBackoff(sock, ORDERS_GROUP_SUBJECT, [userJid]);
      ordersGroupJid = createdOrdersGroup?.id || null;
      if (ordersGroupJid) {
        try {
          await sock.groupUpdateDescription(
            ordersGroupJid,
            "📦 Leah's Kitchen Live Order Dispatch & Two-Stage Batch Packing Slips (Stage 1: Stove Cook Totals | Stage 2: Gate-Grouped BAG-01..BAG-N Customer Slips)."
          );
        } catch {}
        console.log(`✅ Created "${ORDERS_GROUP_SUBJECT}" -> ${ordersGroupJid}`);
      }
    } catch (err) {
      console.warn(`⚠️ Could not auto-create "${ORDERS_GROUP_SUBJECT}" (${err.message}). Routing group orders to "${COMMUNITY_GROUP_SUBJECT}" (${communityGroupJid})!`);
      ordersGroupJid = communityGroupJid;
    }
  } else {
    console.log(`✅ Found existing "${ORDERS_GROUP_SUBJECT}" -> ${ordersGroupJid}`);
  }

  const groupConfig = {
    communityGroupSubject: COMMUNITY_GROUP_SUBJECT,
    communityGroupJid,
    ordersGroupSubject: ORDERS_GROUP_SUBJECT,
    ordersGroupJid: ordersGroupJid || communityGroupJid,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(GROUPS_CACHE_FILE, JSON.stringify(groupConfig, null, 2), "utf8");
  } catch {}

  return groupConfig;
}

let activeHttpServer = null;

async function startWhatsAppBot() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const credsPath = path.join(AUTH_DIR, "creds.json");
  const backupPath = path.join(AUTH_DIR, "creds.backup.json");

  // Self-heal if creds.json was truncated to 0 bytes by an abrupt process stop
  if (!isValidCredsFile(credsPath) && isValidCredsFile(backupPath)) {
    console.log(`🛡️ [SESSION SELF-HEAL] Restoring truncated creds.json from atomic creds.backup.json...`);
    fs.copyFileSync(backupPath, credsPath);
  } else if (isValidCredsFile(credsPath) && !isValidCredsFile(backupPath)) {
    fs.copyFileSync(credsPath, backupPath);
  }

  console.log(`\n=============================================================`);
  console.log(`🤖 INITIALIZING AUTONOMOUS WHATSAPP BROADCAST BOT`);
  console.log(`📁 Auth Directory: ${AUTH_DIR}`);
  console.log(`🔐 Session Status: ${isValidCredsFile(credsPath) ? "PERSISTED CREDENTIALS FOUND (Zero-QR Reconnect)" : "Awaiting Initial Pairing"}`);
  console.log(`📡 Broadcast Channel: ${CHANNEL_NAME}`);
  console.log(`🌐 Local HTTP IPC Gateway: http://127.0.0.1:${HTTP_PORT}/order`);
  console.log(`=============================================================\n`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    try {
      if (isValidCredsFile(credsPath)) {
        const tmpBackup = `${backupPath}.tmp`;
        fs.copyFileSync(credsPath, tmpBackup);
        fs.renameSync(tmpBackup, backupPath);
      }
    } catch {}
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`\n=============================================================`);
      console.log(`📱 SCAN THIS QR CODE ON YOUR PHONE TO LINK WHATSAPP`);
      console.log(`   (Will auto-create "${COMMUNITY_GROUP_SUBJECT}" & "${ORDERS_GROUP_SUBJECT}")`);
      console.log(`=============================================================\n`);
      qrcodeTerminal.generate(qr, { small: true });
      try {
        await QRCode.toFile(LOCAL_PNG, qr);
        if (fs.existsSync(path.resolve(process.cwd(), "public"))) {
          await QRCode.toFile(PUBLIC_PNG, qr);
        }
        await QRCode.toFile(ARTIFACT_PNG, qr);
      } catch {}
    }

    if (connection === "open") {
      const userJid = sock.user?.id ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : null;

      // Auto-provision or resolve "Leah's Kitchen" & "Leah's Kitchen - Group Orders"
      const groupInfo = await ensureLeahsKitchenGroups(sock, userJid);
      const effectiveTarget =
        formatJid(targetRecipient) || groupInfo.ordersGroupJid || userJid;

      console.log(`\n=============================================================`);
      console.log(`🎉 WHATSAPP AUTONOMOUS BOT CONNECTED & GROUPS PROVISIONED!`);
      console.log(`👤 Connected Account: ${userJid}`);
      console.log(`🏠 Community Group ("${COMMUNITY_GROUP_SUBJECT}"): ${groupInfo.communityGroupJid || "N/A"}`);
      console.log(`📦 Orders Group ("${ORDERS_GROUP_SUBJECT}"): ${groupInfo.ordersGroupJid || "N/A"}`);
      console.log(`🎯 Active Order Dispatch Target: ${effectiveTarget}`);
      console.log(`=============================================================\n`);

      globalThis.__RECONNECT_ATTEMPT__ = 0;

      // Idempotency cache: prevents duplicate dispatches of the same orderId or message id within 15 seconds
      const recentOrderDispatchMap = globalThis.__RECENT_ORDER_DISPATCH_MAP__ || new Map();
      globalThis.__RECENT_ORDER_DISPATCH_MAP__ = recentOrderDispatchMap;
      const DEDUP_WINDOW_MS = 15000;

      // Dispatcher function for an order or milestone
      async function handleDispatch(msg) {
        if (!msg) return;
        try {
          const dedupKey =
            msg.type === "ORDER_PLACED" && msg.metadata?.orderId
              ? `ORDER:${msg.metadata.orderId}`
              : msg.id
                ? `MSG:${msg.id}`
                : null;

          if (dedupKey) {
            const lastSentAt = recentOrderDispatchMap.get(dedupKey);
            const now = Date.now();
            if (lastSentAt && now - lastSentAt < DEDUP_WINDOW_MS) {
              console.log(`🛡️ [DEDUP GUARD] Suppressed duplicate WhatsApp dispatch for ${dedupKey} (${now - lastSentAt}ms since last send)`);
              return;
            }
            recentOrderDispatchMap.set(dedupKey, now);
          }

          if (msg.type === "ORDER_PLACED") {
            msg.metadata = msg.metadata || {};
            if (msg.metadata.gracePeriodApproved === undefined) {
              const evaluated = evaluateOrderGraceWindow(msg.metadata.orderTimestamp, msg.metadata.cartStartedAt);
              msg.metadata.gracePeriodApproved = evaluated.gracePeriodApproved;
              msg.metadata.graceBackoff = evaluated.graceBackoff;
            }
          }

          const text = formatMessageForWhatsApp(msg);
          const target =
            msg.metadata?.targetGroupJid ||
            msg.metadata?.targetJid ||
            (msg.type === "ORDER_PLACED" && groupInfo.ordersGroupJid
              ? groupInfo.ordersGroupJid
              : effectiveTarget);

          const sent = await sendMessageWithBackoff(sock, target, { text });
          if (sent?.key?.id) {
            defaultMessageTracker.recordSentMessage({
              id: sent.key.id,
              recipient: target,
              text,
              eventType: msg.type,
              reporter: msg.reporter,
            });
          }

          console.log(`\n-------------------------------------------------------------`);
          console.log(`🚀 [WHATSAPP GROUP ORDER TICKET DISPATCHED]`);
          console.log(`⚡ Event: ${msg.type}`);
          console.log(`🧾 Order Ref: #${msg.metadata?.orderId || "N/A"}`);
          console.log(`⚡ Grace Period: ${msg.metadata?.gracePeriodApproved ? `APPROVED (${msg.metadata?.graceBackoff?.decayFormula || "15m Soft-Landing"})` : "Standard Window"}`);
          console.log(`🎯 Group / Recipient: ${target}`);
          console.log(`🕒 Timestamp: ${new Date().toLocaleTimeString()}`);
          console.log(`-------------------------------------------------------------\n`);

          // 2. Add to Clustered Orders Engine (Stage 1 Stove Totals + Stage 2 BAG-01 Slips)
          if (msg.type === "ORDER_PLACED") {
            const meta = msg.metadata || {};
            defaultOrderClusteringEngine.addOrder({
              orderId: meta.orderId,
              customer: meta.customer || { name: meta.clientName, phone: meta.clientPhone },
              deliveryAddress: meta.deliveryAddress || meta.tableNumber || meta.fulfillmentType,
              totalAmount: meta.totalAmount || meta.totalPrice || 0,
              gracePeriodApproved: meta.gracePeriodApproved,
              graceBackoff: meta.graceBackoff,
              items: meta.items || [],
            });

            if (defaultOrderClusteringEngine.isClusterReady()) {
              const cluster = defaultOrderClusteringEngine.flush();
              if (cluster) {
                const clusterSent = await sendMessageWithBackoff(sock, target, { text: cluster.digestText });
                if (clusterSent?.key?.id) {
                  defaultMessageTracker.recordSentMessage({
                    id: clusterSent.key.id,
                    recipient: target,
                    text: cluster.digestText,
                    eventType: "EXECUTIVE_PREP_DIGEST",
                    reporter: "OrderClusteringEngine",
                  });
                }

                // Also post a brief batch alert in the main "Leah's Kitchen" community group if distinct
                if (groupInfo.communityGroupJid && groupInfo.communityGroupJid !== target) {
                  await sendMessageWithBackoff(sock, groupInfo.communityGroupJid, {
                    text:
                      `🔔 *[LEAH'S KITCHEN BATCH UPDATE]*\n` +
                      `A new batch of *${cluster.orderCount} group orders* (including Grace Period soft-landing orders) has just been locked into the kitchen prep queue and assigned collection bag tags (*BAG-01..BAG-0${cluster.orderCount}*) in *${ORDERS_GROUP_SUBJECT}*!`,
                  });
                }

                console.log(`\n-------------------------------------------------------------`);
                console.log(`📊 [TWO-STAGE KITCHEN PREP & BAG SLIPS DISPATCHED TO GROUP]`);
                console.log(`⚡ Clustered: ${cluster.orderCount} orders -> Stage 1 Stove Sheet + Stage 2 BAG-01 Slips`);
                console.log(`🎯 Group JID: ${target}`);
                console.log(`-------------------------------------------------------------\n`);
              }
            }
          }
        } catch (sendErr) {
          console.warn(`⚠️ Error auto-sending to WhatsApp:`, sendErr.message);
        }
      }

      // Helper: Add participants to "Leah's Kitchen" or "Leah's Kitchen - Group Orders"
      async function addGroupParticipants(participantJids, targetGroupType = "community") {
        const targetJid =
          targetGroupType === "orders"
            ? groupInfo.ordersGroupJid || groupInfo.communityGroupJid
            : groupInfo.communityGroupJid || groupInfo.ordersGroupJid;
        if (!targetJid) throw new Error("No provisioned group JID found");
        const response = await sock.groupParticipantsUpdate(targetJid, participantJids, "add");
        return {
          status: "ADDED_TO_WHATSAPP_GROUP ✅",
          groupJid: targetJid,
          response
        };
      }

      // Helper: Fetch shareable WhatsApp Invite Links (`https://chat.whatsapp.com/...`)
      async function fetchGroupInviteLinks() {
        let communityInviteUrl = null;
        let ordersInviteUrl = null;
        if (groupInfo.communityGroupJid) {
          try {
            const code = await sock.groupInviteCode(groupInfo.communityGroupJid);
            if (code) communityInviteUrl = `https://chat.whatsapp.com/${code}`;
          } catch {}
        }
        if (groupInfo.ordersGroupJid) {
          try {
            const code = await sock.groupInviteCode(groupInfo.ordersGroupJid);
            if (code) ordersInviteUrl = `https://chat.whatsapp.com/${code}`;
          } catch {}
        }
        return { communityInviteUrl, ordersInviteUrl };
      }

      // Attach listener to broadcast channel
      createLeaseReceiver(async (msg) => {
        if (msg.reporter === "Autonomous WhatsApp Bot Daemon") return;
        const allowedTypes = ["ORDER_PLACED", "TECHNICAL_CHRONICLE_PUBLISHED", "SYSTEM_MANIFEST_VERIFIED"];
        if (!allowedTypes.includes(msg.type)) return;
        await handleDispatch(msg);
      });

      // Attach Inbound Shop Operator Command Listener (3-Layer Anti-Echo Guarded)
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" || !Array.isArray(messages)) return;

        for (const m of messages) {
          const msgId = m?.key?.id || "";
          const remoteJid = m?.key?.remoteJid || "";
          const participantJid = m?.key?.participant || remoteJid;
          const isFromMe = Boolean(m?.key?.fromMe);
          const rawText =
            m?.message?.conversation ||
            m?.message?.extendedTextMessage?.text ||
            "";

          if (!rawText) continue;

          // Only accept shop commands from the linked owner or the official Leah's Kitchen groups
          const isAuthorizedShopChannel =
            remoteJid === userJid ||
            remoteJid === groupInfo.ordersGroupJid ||
            remoteJid === groupInfo.communityGroupJid;

          if (!isAuthorizedShopChannel) continue;

          const result = await processShopInboundInput({
            text: rawText,
            messageId: msgId,
            senderJid: participantJid,
            fromMe: isFromMe,
            authorizedOperatorJids: [userJid],
            isPublicCommunityGroup: remoteJid === groupInfo.communityGroupJid,
            context: {
              clusteringEngine: defaultOrderClusteringEngine,
              packedBagsSet: packedBagsRegistry,
              addParticipantsFn: addGroupParticipants,
              getInviteLinksFn: fetchGroupInviteLinks
            }
          });

          if (result.handled && result.replyText) {
            const replyTarget =
              remoteJid === groupInfo.communityGroupJid
                ? groupInfo.communityGroupJid
                : groupInfo.ordersGroupJid || remoteJid;
            const ackSent = await sendMessageWithBackoff(sock, replyTarget, {
              text: result.replyText
            });
            if (ackSent?.key?.id) {
              defaultMessageTracker.recordSentMessage({
                id: ackSent.key.id,
                recipient: replyTarget,
                text: result.replyText,
                eventType: "SHOP_INPUT_ACK",
                reporter: "ShopInboundCommandEngine"
              });
            }
            console.log(`\n🛠️ [SHOP INPUT PROCESSED] Command=${result.command.commandType} | Reply sent to ${replyTarget}\n`);
          }
        }
      });

      // Only dispatch the 3 startup sample orders if explicitly requested via `--auto-test`
      if (args.includes("--auto-test") && !globalThis.__AUTO_TEST_DISPATCHED__) {
        globalThis.__AUTO_TEST_DISPATCHED__ = true;
        setTimeout(async () => {
          console.log(`\n🧪 [AUTO-TEST] Dispatching 3 sample orders (#LK-701, #LK-702 [Grace Slice 1: 8m], #LK-703 [Grace Slice 2: 4m]) into "${ORDERS_GROUP_SUBJECT}"...`);
          const sampleOrders = [
            {
              reporter: "Storefront Checkout Engine",
              type: "ORDER_PLACED",
              tenantId: "leahs-kitchen",
              tenantName: "Leah's Kitchen",
              status: "PENDING",
              summary: "Order #LK-701 placed by Kevin O. (Gate A - Standard Pre-Cutoff)",
              metadata: {
                orderId: "LK-701",
                clientName: "Kevin O.",
                clientPhone: "0710000001",
                deliveryAddress: "Gate A (Security Desk)",
                targetDay: "Tomorrow",
                orderTimestamp: "2026-10-23T16:45:00",
                totalAmount: 1700,
                items: [{ name: "Swahili Coconut Chicken Stew", quantity: 2, price: 850, notes: "Extra coconut gravy" }]
              }
            },
            {
              reporter: "Storefront Checkout Engine",
              type: "ORDER_PLACED",
              tenantId: "leahs-kitchen",
              tenantName: "Leah's Kitchen",
              status: "PENDING",
              summary: "Order #LK-702 placed by Sarah M. (Gate B - 17:04 Grace Slice 1 [8m])",
              metadata: {
                orderId: "LK-702",
                clientName: "Sarah M.",
                clientPhone: "0710000002",
                deliveryAddress: "Gate B (Cafeteria Pickup Point)",
                targetDay: "Tomorrow (Grace Protected)",
                orderTimestamp: "2026-10-23T17:04:00",
                cartStartedAt: "2026-10-23T16:58:00",
                totalAmount: 1050,
                items: [
                  { name: "Swahili Coconut Chicken Stew", quantity: 1, price: 850 },
                  { name: "Fresh Passion Juice", quantity: 1, price: 200, notes: "Chilled, no sugar" }
                ]
              }
            },
            {
              reporter: "Storefront Checkout Engine",
              type: "ORDER_PLACED",
              tenantId: "leahs-kitchen",
              tenantName: "Leah's Kitchen",
              status: "PENDING",
              summary: "Order #LK-703 placed by Alex K. (Gate A - 17:10 Grace Slice 2 [4m Backoff])",
              metadata: {
                orderId: "LK-703",
                clientName: "Alex K.",
                clientPhone: "0710000003",
                deliveryAddress: "Gate A (Security Desk)",
                targetDay: "Tomorrow (Grace Protected)",
                orderTimestamp: "2026-10-23T17:10:00",
                cartStartedAt: "2026-10-23T16:59:10",
                totalAmount: 2550,
                items: [
                  { name: "Crispy Veggie Spring Rolls", quantity: 1, price: 350 },
                  { name: "Slow-Roasted Beef Platter", quantity: 1, price: 2200, notes: "Medium well" }
                ]
              }
            }
          ];

          for (const sample of sampleOrders) {
            await handleDispatch(sample);
            await new Promise(r => setTimeout(r, 900));
          }
        }, 1500);
      }

      // Start Local HTTP IPC Server for instant browser & script forwarding
      if (!activeHttpServer) {
        activeHttpServer = http.createServer((req, res) => {
          const sendJson = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json" });
            res.end(JSON.stringify(obj));
          };
          const urlPath = (req.url || "").split("?")[0];
          req.url = urlPath;

          // 1. Host allow-list (blocks DNS-rebinding from hostile web pages)
          const hostName = String(req.headers.host || "").split(":")[0].toLowerCase();
          if (!ALLOWED_HOSTS.has(hostName)) {
            return sendJson(421, { error: "host not allowed" });
          }

          // 2. CORS: reflect only allow-listed origins (no wildcard)
          const origin = req.headers.origin || "";
          const originAllowed = Boolean(origin) && ALLOWED_ORIGINS.has(origin);
          if (originAllowed) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
          }
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-LK-Token");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "no-store");

          if (req.method === "OPTIONS") {
            res.writeHead(originAllowed ? 204 : 403);
            return res.end();
          }

          // 3. Per-IP rate limit and failed-auth lockout
          const ip = req.socket.remoteAddress || "unknown";
          const rl = checkRateLimit(ip);
          if (!rl.ok) {
            res.setHeader("Retry-After", String(rl.retryAfterSec));
            return sendJson(429, { error: "too many requests" });
          }

          // 4. Body size cap (64 KB)
          let received = 0;
          req.on("data", (c) => {
            received += c.length;
            if (received > MAX_BODY_BYTES) req.destroy();
          });

          // 5. Authentication: shared-secret token, or allow-listed browser origin (orders only)
          const authHeader = String(req.headers.authorization || "");
          const presented =
            req.headers["x-lk-token"] ||
            (authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "");
          const tokenOk = presented ? tokensMatch(String(presented), GATEWAY_TOKEN) : false;
          req.lkAuth = tokenOk ? "token" : originAllowed ? "origin" : "none";

          const isPublicRoute = req.method === "GET" && (urlPath === "/" || urlPath === "/status");
          const isOrderRoute = req.method === "POST" && (urlPath === "/order" || urlPath === "/broadcast");
          if (!isPublicRoute) {
            const permitted = req.lkAuth === "token" || (isOrderRoute && req.lkAuth === "origin");
            if (!permitted) {
              if (!tokenOk) recordAuthFailure(ip);
              return sendJson(401, { error: "unauthorized" });
            }
          }

          if (req.method === "GET" && (req.url === "/" || req.url === "/status")) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Leah's Kitchen — WhatsApp IPC Gateway (:5174)</title>
  <style>
    body { background: #0b141a; color: #e9edef; font-family: system-ui, sans-serif; padding: 32px; max-width: 780px; margin: 0 auto; }
    .card { background: #111b21; border: 1px solid rgba(0,168,132,0.35); border-radius: 16px; padding: 24px; margin-bottom: 20px; }
    .pill { display: inline-block; background: #005c4b; color: #d9fdd3; padding: 4px 10px; border-radius: 999px; font-family: monospace; font-size: 12px; font-weight: bold; }
    a.btn { display: inline-block; background: #00a884; color: #041d14; text-decoration: none; font-weight: 800; padding: 10px 18px; border-radius: 10px; margin-right: 10px; margin-top: 10px; }
    code { background: rgba(0,0,0,0.35); padding: 2px 6px; border-radius: 6px; color: #53bdeb; }
  </style>
</head>
<body>
  <div class="card">
    <span class="pill">🟢 WHATSAPP IPC GATEWAY ONLINE (:5174)</span>
    <h1 style="margin: 12px 0 6px;">Leah's Kitchen — Autonomous WhatsApp Gateway</h1>
    <p style="color:#8696a0; margin-top:0;">Status: connected. Account and group details require the gateway token (<code>GET /groups</code> with <code>Authorization: Bearer ...</code>).</p>


    <div style="margin-top: 18px;">
      <a class="btn" href="http://localhost:5173/s/leahs-kitchen/kitchen-prep">👩🏾‍🍳 Open Kitchen Prep &amp; WhatsApp Command UI (:5173)</a>
      <a class="btn" href="http://localhost:5173/sandbox/leases">🧪 Open Leased Feature Sandbox (:5173)</a>

    </div>
  </div>
</body>
</html>`);
          }

          if (req.method === "GET" && req.url === "/groups") {
            fetchGroupInviteLinks().then((links) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ connected: true, userJid, ...groupInfo, ...links }, null, 2));
            }).catch(() => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ connected: true, userJid, ...groupInfo }, null, 2));
            });
            return;
          }

          if (req.method === "POST" && req.url === "/shop-input") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", async () => {
              try {
                const payload = JSON.parse(body);
                const result = await processShopInboundInput({
                  text: payload.text || payload.command || "",
                  messageId: payload.messageId || "",
                  senderJid: payload.senderJid || userJid,
                  context: {
                    clusteringEngine: defaultOrderClusteringEngine,
                    packedBagsSet: packedBagsRegistry,
                    addParticipantsFn: addGroupParticipants,
                    getInviteLinksFn: fetchGroupInviteLinks
                  }
                });
                if (result.handled && result.replyText) {
                  const replyTarget = groupInfo.ordersGroupJid || effectiveTarget;
                  const ackSent = await sendMessageWithBackoff(sock, replyTarget, {
                    text: result.replyText
                  });
                  if (ackSent?.key?.id) {
                    defaultMessageTracker.recordSentMessage({
                      id: ackSent.key.id,
                      recipient: replyTarget,
                      text: result.replyText,
                      eventType: "SHOP_INPUT_ACK",
                      reporter: "ShopInboundCommandEngine"
                    });
                  }
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, ...result }));
              } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
              }
            });
            return;
          }

          if (req.method === "POST" && (req.url === "/order" || req.url === "/broadcast")) {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", async () => {
              try {
                const payload = JSON.parse(body);
                if (req.lkAuth !== "token" && payload?.type !== "ORDER_PLACED") {
                  res.writeHead(403, { "Content-Type": "application/json" });
                  return res.end(JSON.stringify({ error: "token required for this message type" }));
                }
                await handleDispatch(payload);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  success: true,
                  dispatchedToGroup: groupInfo.ordersGroupJid || effectiveTarget,
                  timestamp: new Date().toISOString()
                }));
              } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
              }
            });
            return;
          }

          res.writeHead(404);
          res.end("Not Found");
        });

        activeHttpServer.listen(HTTP_PORT, HTTP_HOST, () => {
          console.log(`🚀 Local HTTP IPC Server listening on http://127.0.0.1:${HTTP_PORT}/order & /shop-input`);
        });
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        const attempt = globalThis.__RECONNECT_ATTEMPT__ || 0;
        globalThis.__RECONNECT_ATTEMPT__ = attempt + 1;
        const waitMs = computeBackoffDelayMs(attempt, 1000, 30000);
        console.log(`⏳ [EXPONENTIAL BACKOFF RECONNECT] Attempt #${attempt + 1} in ${waitMs}ms...`);
        setTimeout(startWhatsAppBot, waitMs);
      }
    }
  });

  return sock;
}

startWhatsAppBot().catch((err) => {
  console.error("❌ Fatal error in WhatsApp bot:", err);
  process.exit(1);
});

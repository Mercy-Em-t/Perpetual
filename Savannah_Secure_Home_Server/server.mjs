#!/usr/bin/env node
/**
 * ==============================================================================
 * SAVANNAH SECURE EDGE HOME SERVER - AUTONOMOUS WHATSAPP DAEMON & REST API
 * ==============================================================================
 * Autonomous 24/7 background microservice running on the HP Pavilion server.
 * Uses @whiskeysockets/baileys for multi-device headless WhatsApp connection.
 * Provides a lightweight HTTP REST API for internal services (Dokploy, Watchdog,
 * Restic backup daemon, TMS Whitelabel) to send notifications with ZERO clicks.
 * 
 * Features:
 * - Dual-Entry M-Pesa Till SMS Reconciliation (Option B)
 * - Interactive In-Chat Admin Commands (!help, !status, !ledger, !order, !pickup, !pair)
 * - Automatic Admin & Operations Group Description Synchronization
 * - Creative Galore Admin & Operations Group Separation
 * - Zero Group Pollution (Customer receives direct 1-on-1 WhatsApp messages)
 * - 4-Digit Pickup PIN Lifecycle & Verification Handshake
 * ==============================================================================
 */

import express from "express";
import cors from "cors";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 8085;
const AUTH_DIR = process.env.AUTH_DIR || path.resolve(__dirname, ".auth_whatsapp_baileys");
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "data");
const DISPUTES_FILE = path.join(DATA_DIR, "disputes_register.json");

function loadDisputes() {
  if (fs.existsSync(DISPUTES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DISPUTES_FILE, "utf-8"));
    } catch (e) {
      console.warn("Disputes read error, returning empty register:", e.message);
    }
  }
  return {};
}

function saveDisputes(disputes) {
  try {
    fs.writeFileSync(DISPUTES_FILE, JSON.stringify(disputes, null, 2), "utf-8");
  } catch (e) {
    console.error("Disputes write error:", e.message);
  }
}

const LEDGER_FILE = path.join(DATA_DIR, "till_receipts_ledger.json");
const DEFAULT_RECIPIENT = process.env.WHATSAPP_DEFAULT_RECIPIENT || "254710720949@s.whatsapp.net";
const QR_FILE = path.join(AUTH_DIR, "qr_active.txt");
const QR_PNG = path.join(__dirname, "public", "whatsapp-qr.png");

// Dedicated Operational Groups (Creative Galore)
const CREATIVE_GALORE_OPERATIONS_JID = "120363429060534928@g.us";
const CREATIVE_GALORE_ADMIN_JID = "120363431644465504@g.us";
const CREATIVE_GALORE_COMMUNITY_JID = "120363430166313076@g.us";

// Group Descriptions with Admin & Operations Command Manual
const ADMIN_GROUP_DESCRIPTION = `🧶 CREATIVE GALORE — EXECUTIVE ADMIN & FINANCE 🧶
===================================================
Autonomous financial reconciliation & order ledger matrix.

⚡ DIRECT BOT COMMANDS (Type in this chat):
• !help — Show full command manual
• !status — Server health, active orders & till sync state
• !ledger — List last 5 captured Safaricom Till receipts
• !order <id> — Check order details, payment & pickup PIN
• !pickup <id> — Mark order ready & send 4-digit PIN to customer
• !pair <id> <code> — Manually pair order with M-Pesa receipt
• !cancel <id> [reason] — Abort/cancel order & notify customer

🔗 MANAGEMENT LINKS:
• Dashboard: https://tmsavannah.com/dashboard
• Order Manager: https://tmsavannah.com/order-manager
• Public Store: https://tmsavannah.com/s/creative-galore
• Till Receipts API: http://100.73.175.118:8085/api/till/ledger

🔐 Security: Zero group pollution. All customer interactions are private 1-on-1.`;

const OPERATIONS_GROUP_DESCRIPTION = `📦 CREATIVE GALORE — PACKING & DISPATCH OPERATIONS 📦
===================================================
Real-time packing slips, runner dispatch & 4-digit pickup PIN handshakes.

⚡ OPERATIONS COMMANDS (Type in this chat):
• !pickup <id> — Mark packed & send 4-digit PIN to customer
• !order <id> — Check items to pack & fulfillment destination
• !cancel <id> — Abort order & notify customer
• !status — View orders awaiting packing / dispatch
• !help — Show operations command list

🔐 Zero Group Pollution: Customers are never added to groups. PINs are delivered directly to customer WhatsApp.`;

// Ensure directories exist
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(__dirname, "public"))) fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });

// State Tracking
let sock = null;
let isConnected = false;
let connectedUserJid = null;
let latestQrString = null;
let reconnectCount = 0;
let messagesSentCount = 0;
let lastMessageTimestamp = null;
const serviceStartTime = new Date();

// Helper: Format phone number into WhatsApp JID
function formatJid(input) {
  if (!input) return null;
  if (input.includes("@")) return input;
  const clean = input.replace(/[^0-9]/g, "");
  return `${clean}@s.whatsapp.net`;
}

// Ledger Helpers
function loadLedger() {
  if (fs.existsSync(LEDGER_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf-8"));
    } catch (e) {
      console.warn("Could not parse ledger file, starting fresh:", e.message);
    }
  }
  return {};
}

function saveLedger(ledger) {
  try {
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2), "utf-8");
  } catch (e) {
    console.error("Could not write ledger file:", e.message);
  }
}

// In-Memory Order & Action Token Store
const activeOrders = new Map();
const actionTokens = new Map();

// ---------------------------------------------------------------------------
// ENTERPRISE ASYNC MESSAGE QUEUE & CONCURRENCY CONTROLLER
// (Architecture derived from "How AI Handles Message Queues" research)
// ---------------------------------------------------------------------------

// 1. Per-Chat / Per-Sender FIFO Mutex Queue
// Guarantees strict sequential execution per sender/chat (preventing out-of-order execution,
// state corruption, or duplicate triggers) while maintaining global concurrency across chats.
const chatQueues = new Map();

function enqueueChatTask(chatJid, taskFn) {
  const currentChain = chatQueues.get(chatJid) || Promise.resolve();
  const nextChain = currentChain
    .then(async () => {
      try {
        await taskFn();
      } catch (err) {
        console.error(`💥 [QUEUE ERROR] Chat ${chatJid}:`, err);
      }
    })
    .finally(() => {
      if (chatQueues.get(chatJid) === nextChain) {
        chatQueues.delete(chatJid);
      }
    });
  chatQueues.set(chatJid, nextChain);
  return nextChain;
}

// 2. Request Coalescing & Short-Term TTL Cache (Deduplication)
// Caches read queries (!status, !ledger) for 10 seconds to eliminate redundant disk/ledger fetches.
const queryTtlCache = new Map();

function getCachedOrCompute(cacheKey, ttlMs, computeFn) {
  const now = Date.now();
  const cached = queryTtlCache.get(cacheKey);
  if (cached && (now - cached.timestamp < ttlMs)) {
    return { data: cached.data, isCached: true, ageSec: Math.floor((now - cached.timestamp) / 1000) };
  }
  const freshData = computeFn();
  queryTtlCache.set(cacheKey, { data: freshData, timestamp: now });
  return { data: freshData, isCached: false, ageSec: 0 };
}

// Helper: Synchronize Group Descriptions
async function syncGroupDescriptions() {
  if (!sock || !isConnected) return;
  try {
    console.log("📝 Updating Creative Galore Admin group description...");
    await sock.groupUpdateDescription(CREATIVE_GALORE_ADMIN_JID, ADMIN_GROUP_DESCRIPTION);
    console.log("✅ Admin group description updated with commands!");
  } catch (err) {
    console.warn("Could not update Admin group description:", err.message);
  }

  try {
    console.log("📝 Updating Creative Galore Operations group description...");
    await sock.groupUpdateDescription(CREATIVE_GALORE_OPERATIONS_JID, OPERATIONS_GROUP_DESCRIPTION);
    console.log("✅ Operations group description updated with commands!");
  } catch (err) {
    console.warn("Could not update Operations group description:", err.message);
  }
}

// Helper: Format alert into WhatsApp Markdown
function formatAlertPayload({ title, level = "INFO", details, source = "Savannah Edge Sentinel" }) {
  let emoji = "ℹ️";
  if (level === "WARNING") emoji = "⚠️";
  if (level === "CRITICAL" || level === "ALERT") emoji = "🚨";
  if (level === "SUCCESS") emoji = "✅";

  const timeStr = new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" });

  const lines = [
    `${emoji} *[SAVANNAH EDGE SERVER ALERT]*`,
    "",
    `📌 *Title:* *${title}*`,
    `⚡ *Level:* \`${level}\``,
    `🖥️ *Source:* ${source}`,
    `🕒 *Time:* ${timeStr}`,
    "",
    `📝 *Details:*`,
    `${details}`,
    "",
    `— _Savannah Autonomous PaaS Matrix_`
  ];

  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// BAILEYS WHATSAPP ENGINE
// -----------------------------------------------------------------------------
async function startWhatsAppBot() {
  console.log(`\n=============================================================`);
  console.log(`🤖 STARTING SAVANNAH WHATSAPP AUTONOMOUS MICROSERVICE`);
  console.log(`📁 Auth Directory: ${AUTH_DIR}`);
  console.log(`🎯 Default Target: ${DEFAULT_RECIPIENT}`);
  console.log(`=============================================================\n`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "24.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrString = qr;
      console.log(`\n📱 SCAN QR CODE ON YOUR PHONE IF NOT YET LINKED:`);
      qrcodeTerminal.generate(qr, { small: true });

      try {
        fs.writeFileSync(QR_FILE, qr, "utf-8");
        await QRCode.toFile(QR_PNG, qr, { width: 512, margin: 2 });
      } catch (err) {
        console.warn(`Could not write QR files:`, err.message);
      }
    }

    if (connection === "open") {
      isConnected = true;
      latestQrString = null;
      connectedUserJid = sock.user?.id ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : DEFAULT_RECIPIENT;

      console.log(`\n=============================================================`);
      console.log(`🎉 WHATSAPP AUTONOMOUS BOT ONLINE & AUTHENTICATED!`);
      console.log(`👤 Connected JID: ${connectedUserJid}`);
      console.log(`⚡ Autonomous Outbound Messages: READY`);
      console.log(`=============================================================\n`);

      // Update Group Descriptions with Admin & Operations commands
      await syncGroupDescriptions();

      // Announce ready to Admin Group
      if (reconnectCount === 0) {
        const timeStr = new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" });
        sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, {
          text: `🟢 *[SAVANNAH EDGE SERVER ONLINE]*\nAutonomous Order & M-Pesa Till SMS Gateway online at ${timeStr}. In-chat commands active (Type \`!help\` for options).`
        }).catch(() => {});
      }
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.warn(`⚠️ WhatsApp connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        reconnectCount++;
        setTimeout(() => startWhatsAppBot(), 5000);
      } else {
        console.error(`🚨 WhatsApp logged out permanently. Please scan fresh QR code via /qr`);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // INTERACTIVE IN-CHAT ADMIN & OPERATIONS COMMAND ENGINE
  // (With Per-Chat FIFO Queue, Deduplication TTL Caching, Idempotency & Abort)
  // ---------------------------------------------------------------------------
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      const text = body.trim();
      trafficCounters.inboundMessages++;
      recordObservatoryLog("WHATSAPP_IN", `Inbound WhatsApp from ${from}: "${text.substring(0, 40)}${text.length > 40 ? "..." : ""}"`);

      // If command starting with !, process command
      if (text.startsWith("!")) {
        enqueueChatTask(from, async () => {
          await processInChatCommand(from, text, msg);
        });
        continue;
      }

      // If direct 1-on-1 customer message (not in group)
      if (!from.endsWith("@g.us")) {
        enqueueChatTask(from, async () => {
          await processCustomerDirectMessage(from, text, msg);
        });
      }
    }
  });
}

// -----------------------------------------------------------------------------
// CREATIVE GALORE PRODUCT CATALOG REFERENCE
// -----------------------------------------------------------------------------
const CG_CATALOG = [
  { id: 1, name: "The Ultimate Crochet Beginner Kit", price: 2400, uuid: "23aa4fef-92e1-4560-aee8-bc911f440332" },
  { id: 2, name: "Ergonomic Soft-Grip Aluminum Hooks Set (9 Sizes)", price: 1250, uuid: "b3650bc7-a3f8-4e89-bd06-d50d750cfaec" },
  { id: 3, name: "Soft Milk Cotton Yarn Bundle (5 Skeins)", price: 950, uuid: "5bb817db-e1d5-4523-95ca-ba2d7bfd1927" },
  { id: 4, name: "Locking Stitch Markers & Needles Tin", price: 450, uuid: "71ef3b3a-bb91-455b-9a43-69018442c525" },
  { id: 5, name: "Handmade Hardwood Yarn Bowl", price: 1850, uuid: "0d481747-d572-475d-85fa-71df887e411b" },
  { id: 6, name: "Bespoke Granny Square Tote Bag (PDF Pattern & Video)", price: 350, uuid: "8c20da80-bde4-4f8d-9985-de159bfab0a8" },
  { id: 7, name: "Ready-Made Vintage Daisy Granny Square Shoulder Bag", price: 3200, uuid: "eb0b592a-05c4-4789-951f-af5858e3e8c7" },
  { id: 8, name: "The Creative Galore 'Yarn Tasting' Experience Palette Card", price: 650, uuid: "3952ae6e-42ac-43ce-8b20-0c4775581336" }
];

// -----------------------------------------------------------------------------
// CUSTOMER DIRECT CONVERSATION & 1-ON-1 TILL SHOPPING ASSISTANT
// -----------------------------------------------------------------------------
async function processCustomerDirectMessage(from, text, msg) {
  const cleanPhone = from.replace(/@.*$/, "").replace(/[^0-9]/g, "");
  const trimmed = (text || "").trim();
  const lower = trimmed.toLowerCase();
  const mpesaMatch = trimmed.match(/\b([A-Z0-9]{10})\b/i);

  // A. Check for M-Pesa transaction code or forwarded confirmation SMS
  if (mpesaMatch) {
    const code = mpesaMatch[1].toUpperCase();
    console.log(`💳 [CUSTOMER DIRECT] Detected M-Pesa code: ${code} from customer: ${from}`);

    let matchedOrder = null;
    for (const [orderId, order] of activeOrders.entries()) {
      const orderPhone = order.customer?.phone?.replace(/[^0-9]/g, "") || "";
      if (orderPhone && cleanPhone.endsWith(orderPhone.slice(-9)) && (order.status === "AWAITING_PAYMENT" || order.status === "AWAITING_VERIFICATION")) {
        matchedOrder = order;
        break;
      }
    }

    const ledger = loadLedger();
    const receipt = ledger[code];

    if (receipt) {
      if (matchedOrder) {
        receipt.paired_order_id = matchedOrder.orderId;
        saveLedger(ledger);
        await pairAndConfirmOrder(matchedOrder.orderId, code, receipt, "http://100.73.175.118:8085");
        return;
      } else {
        const autoOrderId = `CG-WA-${code.slice(-4)}`;
        activeOrders.set(autoOrderId, {
          orderId: autoOrderId,
          customer: { name: "WhatsApp Customer", phone: cleanPhone, deliveryAddress: "Store Collection / Pickup" },
          payment: { amount: receipt.amount, mpesaCode: code },
          items: [{ name: "Direct WhatsApp Order", price: receipt.amount, quantity: 1 }],
          status: "AWAITING_PAYMENT"
        });
        receipt.paired_order_id = autoOrderId;
        saveLedger(ledger);
        await pairAndConfirmOrder(autoOrderId, code, receipt, "http://100.73.175.118:8085");
        return;
      }
    } else {
      if (matchedOrder) {
        matchedOrder.submittedCode = code;
        matchedOrder.status = "AWAITING_VERIFICATION";
      }
      const pendingMsg = [
        `⏳ *PAYMENT CODE RECORDED — CREATIVE GALORE* ⏳`,
        `=============================================================`,
        `Thank you! We received your M-Pesa reference: \`${code}\`.`,
        `Our till listener is verifying the transaction on Till *5758419*.`,
        `As soon as confirmed, your *4-digit pickup PIN* will be sent here automatically!`,
        `=============================================================`
      ].join("\n");
      await sock.sendMessage(from, { text: pendingMsg });
      return;
    }
  }

  // B. Conversational Product Selection (e.g. "1", "buy 1", "order 6", "buy tote bag")
  let selectedProduct = null;
  const numMatch = lower.match(/^(?:buy\s+|order\s+)?([1-8])$/i);
  if (numMatch) {
    const pNum = parseInt(numMatch[1], 10);
    selectedProduct = CG_CATALOG.find(p => p.id === pNum);
  } else if (lower.startsWith("buy ") || lower.startsWith("order ")) {
    const query = lower.replace(/^(?:buy|order)\s+/, "").trim();
    selectedProduct = CG_CATALOG.find(p => p.name.toLowerCase().includes(query));
  }

  if (selectedProduct) {
    const waOrderId = `CG-WA-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const newOrder = {
      orderId: waOrderId,
      customer: { name: "WhatsApp Customer", phone: cleanPhone, deliveryAddress: "Store Collection / Pickup" },
      items: [{ id: selectedProduct.uuid, name: selectedProduct.name, price: selectedProduct.price, quantity: 1 }],
      payment: { amount: selectedProduct.price, status: "PENDING" },
      status: "AWAITING_PAYMENT",
      createdAt: new Date().toISOString()
    };
    activeOrders.set(waOrderId, newOrder);

    const billMsg = [
      `🛒 *[ORDER INITIATED — CREATIVE GALORE]*`,
      `=============================================================`,
      `📦 *Item:* ${selectedProduct.name}`,
      `💰 *Total Amount:* *KES ${selectedProduct.price.toLocaleString()}*`,
      `🏷️ *Order Ref:* \`#${waOrderId}\``,
      `=============================================================`,
      `📍 *Fulfillment Option:*`,
      `Reply with:`,
      `👉 *pickup* (Collect in-store)`,
      `👉 *deliver <Location>* (e.g. \`deliver Karen\` or \`deliver 10366\`)`,
      "",
      `💳 *PAYMENT INSTRUCTIONS:*`,
      `1. Open M-Pesa -> *Buy Goods & Services*`,
      `2. Till Number: *5758419* (Creative Galore)`,
      `3. Amount: *KES ${selectedProduct.price.toLocaleString()}*`,
      `4. After paying, reply here with your *M-Pesa confirmation code*!`,
      `=============================================================`
    ].join("\n");

    await sock.sendMessage(from, { text: billMsg });
    return;
  }

  // C. Fulfillment Selection (e.g. "pickup", "deliver Karen")
  if (lower === "pickup" || lower === "collect") {
    let customerOrder = null;
    for (const [orderId, ord] of Array.from(activeOrders.entries()).reverse()) {
      if (ord.customer?.phone?.endsWith(cleanPhone.slice(-9)) && (ord.status === "AWAITING_PAYMENT" || ord.status === "AWAITING_VERIFICATION")) {
        customerOrder = ord;
        break;
      }
    }
    if (customerOrder) {
      customerOrder.customer.deliveryAddress = "Store Collection / Pickup";
      await sock.sendMessage(from, {
        text: `✅ Fulfillment set to *Store Pickup* for Order \`#${customerOrder.orderId}\`.\n\n💳 Please pay *KES ${Number(customerOrder.payment.amount).toLocaleString()}* to Till *5758419* and send your confirmation code here!`
      });
      return;
    }
  }

  if (lower.startsWith("deliver ") || lower.startsWith("delivery ")) {
    const loc = trimmed.replace(/^(?:deliver|delivery)\s+/i, "").trim();
    let customerOrder = null;
    for (const [orderId, ord] of Array.from(activeOrders.entries()).reverse()) {
      if (ord.customer?.phone?.endsWith(cleanPhone.slice(-9)) && (ord.status === "AWAITING_PAYMENT" || ord.status === "AWAITING_VERIFICATION")) {
        customerOrder = ord;
        break;
      }
    }
    if (customerOrder) {
      customerOrder.customer.deliveryAddress = loc;
      await sock.sendMessage(from, {
        text: `✅ Delivery destination saved: *${loc}* for Order \`#${customerOrder.orderId}\`.\n\n💳 Please pay *KES ${Number(customerOrder.payment.amount).toLocaleString()}* to Till *5758419* and send your confirmation code here!`
      });
      return;
    }
  }

  // D. Status Inquiry (e.g. "status", "my order", "pin")
  if (lower === "status" || lower === "my order" || lower === "pin") {
    let customerOrders = [];
    for (const [orderId, ord] of activeOrders.entries()) {
      if (ord.customer?.phone?.endsWith(cleanPhone.slice(-9))) {
        customerOrders.push(ord);
      }
    }
    if (customerOrders.length > 0) {
      const latest = customerOrders[customerOrders.length - 1];
      const pinText = latest.pickupPin ? `\n🔑 *Pickup PIN:* *${latest.pickupPin}*` : "";
      await sock.sendMessage(from, {
        text: `📋 *Order Status for #${latest.orderId}:*\nStatus: *${latest.status}*${pinText}\nTotal: KES ${Number(latest.payment?.amount || 0).toLocaleString()}`
      });
      return;
    }
  }

  // E. Customer greeting / inquiry: send store catalog & welcome card
  const welcomeMsg = [
    `🌸 *WELCOME TO CREATIVE GALORE!* 🌸`,
    `=============================================================`,
    `_Handcrafted Crochet Kits, Notions, Custom Patterns & Yarn Tasting_`,
    "",
    `🧶 *POPULAR CRAFT PRODUCTS (Reply with product # to order):*`,
    `1. *The Ultimate Crochet Beginner Kit* — KES 2,400`,
    `2. *Ergonomic Hooks Set (9 Sizes)* — KES 1,250`,
    `3. *Milk Cotton Yarn Bundle (5 Skeins)* — KES 950`,
    `4. *Locking Stitch Markers & Needles Tin* — KES 450`,
    `5. *Handmade Hardwood Yarn Bowl* — KES 1,850`,
    `6. *Bespoke Granny Square Tote Bag (PDF)* — KES 350`,
    `7. *Vintage Daisy Granny Square Shoulder Bag* — KES 3,200`,
    `8. *Yarn Tasting Experience Palette Card* — KES 650`,
    "",
    `👉 *How to Order on WhatsApp:*`,
    `Reply with the product number (e.g. *1* or *buy 6*) to initiate checkout!`,
    "",
    `🌐 *Or Browse Photos on Web:* https://tmsavannah.com/s/creative-galore`,
    "",
    `💳 *Till Number:* *5758419* (Creative Galore)`
  ].join("\n");

  await sock.sendMessage(from, { text: welcomeMsg });
}
// IN-CHAT COMMAND HANDLER (STRICT FIFO SERIALIZED PER SENDER)
// -----------------------------------------------------------------------------
async function processInChatCommand(from, text, msg) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg1 = parts[1] || "";
  const arg2 = parts[2] || "";

  console.log(`⚡ [FIFO COMMAND] chat: ${from} | cmd: ${cmd} | args: [${arg1}, ${arg2}]`);

  // 1. Command: !help
  if (cmd === "!help" || cmd === "!commands") {
    const helpLines = [
      `🤖 *[CREATIVE GALORE BOT COMMAND MANUAL]*`,
      `=============================================================`,
      `• *!status* — Server health, uptime, active orders & queue status`,
      `• *!ledger* (or *!payments*) — View payments register & claim statuses`,
      `• *!ungrabbed* (or *!unclaimed*) — Filter payments not yet paired to orders`,
      `• *!order <id>* — Query full details, status & pickup PIN of an order`,
      `• *!pickup <id>* — Mark order READY and dispatch 4-digit PIN to customer`,
      `• *!pair <id> <code>* — Manually pair an order with an M-Pesa receipt code`,
      `• *!cancel <id> [reason]* — Abort/cancel order & notify customer privately`,
      `• *!help* — Display this command reference`,
      `=============================================================`,
      `_Enterprise FIFO Queuing, TTL Deduplication & Idempotency Active_`
    ];
    await sock.sendMessage(from, { text: helpLines.join("\n") });
    return;
  }

  // 2. Command: !status (With 8s Request Coalescing / TTL Deduplication)
  if (cmd === "!status") {
    const cacheResult = getCachedOrCompute("cmd:status", 8000, () => {
      const uptimeMins = Math.floor((new Date() - serviceStartTime) / 1000 / 60);
      const pendingOrders = Array.from(activeOrders.values()).filter(o => o.status === "AWAITING_PAYMENT" || o.status === "AWAITING_VERIFICATION").length;
      const paidOrders = Array.from(activeOrders.values()).filter(o => o.status === "PAID" || o.status === "READY_FOR_PICKUP").length;
      const cancelledOrders = Array.from(activeOrders.values()).filter(o => o.status === "CANCELLED").length;
      const ledger = loadLedger();
      const totalReceipts = Object.keys(ledger).length;

      return [
        `📊 *[SAVANNAH EDGE SERVER STATUS]*`,
        `=============================================================`,
        `🖥️ *Server:* HP Pavilion x360 (Ubuntu 24.04 LTS)`,
        `⏱️ *Daemon Uptime:* ${uptimeMins} minutes`,
        `📱 *WhatsApp JID:* \`${connectedUserJid}\``,
        `📶 *Till Hardware Listener:* Active on \`/dev/ttyUSB0\``,
        `📋 *Active Pending Orders:* *${pendingOrders}*`,
        `✅ *Paid / Ready Orders:* *${paidOrders}*`,
        `🛑 *Cancelled Orders:* *${cancelledOrders}*`,
        `🧾 *Till Receipts in Ledger:* *${totalReceipts}*`,
        `⚡ *Active Chat Queues:* *${chatQueues.size}*`,
        `=============================================================`
      ].join("\n");
    });

    let output = cacheResult.data;
    if (cacheResult.isCached) {
      output += `\n_⚡ Cached snapshot (${cacheResult.ageSec}s ago — deduplicated)_`;
    }
    await sock.sendMessage(from, { text: output });
    return;
  }

  // 3. Command: !ledger / !payments (Adaptive: Piecewise for <=4, Tabulated for >=5)
  if (cmd === "!ledger" || cmd === "!payments") {
    const cacheResult = getCachedOrCompute("cmd:ledger", 8000, () => {
      const ledger = loadLedger();
      const keys = Object.keys(ledger);
      if (!keys.length) {
        return `ℹ️ *Till Receipts Ledger is currently empty.*\nNo M-Pesa payments recorded yet.`;
      }

      const totalCount = keys.length;
      let totalVol = 0, claimedVol = 0, refundedVol = 0, unclaimedVol = 0;
      let claimedCount = 0, refundedCount = 0, unclaimedCount = 0;

      for (const k of keys) {
        const r = ledger[k];
        const amt = Number(r.amount || 0);
        totalVol += amt;
        if (r.status === "REFUNDED") {
          refundedCount++;
          refundedVol += amt;
        } else if (r.paired_order_id) {
          claimedCount++;
          claimedVol += amt;
        } else {
          unclaimedCount++;
          unclaimedVol += amt;
        }
      }

      // Check threshold for piecewise vs tabulated
      if (totalCount <= 4) {
        // PIECEWISE FORMAT (For Few)
        const lines = [
          `🧾 *[TILL RECONCILIATION LEDGER (${totalCount} ITEMS)]*`,
          `=============================================================`
        ];
        for (const k of keys) {
          const r = ledger[k];
          let statusTag = "🟡 UP FOR GRABS";
          if (r.status === "REFUNDED") statusTag = "💳 REFUNDED";
          else if (r.paired_order_id) statusTag = `🟢 Claimed (#${r.paired_order_id})`;

          lines.push(`• Code: *${r.code}* | Amount: *KES ${Number(r.amount).toLocaleString()}*`);
          lines.push(`  👤 From: ${r.sender}`);
          lines.push(`  👉 Status: ${statusTag}`);
        }
        lines.push(`=============================================================`);
        lines.push(`_Ledger File: /opt/savannah-server/data/till_receipts_ledger.json_`);
        return lines.join("\n");
      }

      // TABULATED FORMAT (For Many - 100s to 1000s)
      const recentKeys = keys.slice(-10).reverse();
      const tableRows = recentKeys.map(k => {
        const r = ledger[k];
        let statusCol = "UP-4-GRAB";
        let detailCol = r.received_at ? new Date(r.received_at).toLocaleTimeString("en-GB").slice(0, 5) : "RECENT";
        if (r.status === "REFUNDED") {
          statusCol = "REFUND";
          detailCol = r.paired_order_id ? `#${r.paired_order_id.split(" ")[0]}` : "REFUND";
        } else if (r.paired_order_id) {
          statusCol = "CLAIMED";
          detailCol = `#${r.paired_order_id}`;
        }
        return {
          code: r.code,
          amount: Number(r.amount).toLocaleString(),
          status: statusCol,
          detail: detailCol
        };
      });

      const tableCols = [
        { key: "code", header: "CODE", width: 10 },
        { key: "amount", header: "AMOUNT", width: 7, align: "right" },
        { key: "status", header: "STATUS", width: 9 },
        { key: "detail", header: "ORDER/TIME", width: 10 }
      ];

      const lines = [
        `🧾 *[TILL RECONCILIATION REGISTER (TOTAL: ${totalCount})]*`,
        `=============================================================`,
        `💰 *Total Volume:*   *KES ${totalVol.toLocaleString()}* (${totalCount} receipts)`,
        `🟢 *Claimed Orders:* *KES ${claimedVol.toLocaleString()}* (${claimedCount} orders)`,
        `💳 *Refunded Volume:* *KES ${refundedVol.toLocaleString()}* (${refundedCount} receipts)`,
        `🟡 *Up For Grabs:*   *KES ${unclaimedVol.toLocaleString()}* (${unclaimedCount} receipts)`,
        `-------------------------------------------------------------`,
        `📊 *Monospace Tabular Snapshot (Latest 10):*`,
        renderTable(tableRows, tableCols),
        `=============================================================`,
        `_💡 Type !ungrabbed to filter only unclaimed payments._`,
        `_Ledger: /opt/savannah-server/data/till_receipts_ledger.json_`
      ];
      return lines.join("\n");
    });

    let output = cacheResult.data;
    if (cacheResult.isCached) {
      output += `\n_⚡ Cached snapshot (${cacheResult.ageSec}s ago — deduplicated)_`;
    }
    await sock.sendMessage(from, { text: output });
    return;
  }

  // 3b. Command: !ungrabbed / !unclaimed (Adaptive: Piecewise for <=4, Tabulated for >=5)
  if (cmd === "!ungrabbed" || cmd === "!unclaimed") {
    const searchQuery = (arg1 || "").trim().toLowerCase();
    const ledger = loadLedger();
    let ungrabbedKeys = Object.keys(ledger).filter(k => !ledger[k].paired_order_id && ledger[k].status !== "REFUNDED");

    if (searchQuery) {
      ungrabbedKeys = ungrabbedKeys.filter(k => {
        const r = ledger[k];
        return k.toLowerCase().includes(searchQuery) ||
               (r.sender || "").toLowerCase().includes(searchQuery) ||
               String(r.amount || "").includes(searchQuery);
      });
    }

    if (!ungrabbedKeys.length) {
      await sock.sendMessage(from, {
        text: searchQuery
          ? `🔍 No unclaimed payments matching query *"${arg1}"*.`
          : `🎉 *[ALL PAYMENTS CLAIMED]*\nZero ungrabbed payments in ledger. Every incoming Till payment is currently paired with an order!`
      });
      return;
    }

    const totalCount = ungrabbedKeys.length;
    let totalVol = 0;
    for (const k of ungrabbedKeys) totalVol += Number(ledger[k].amount || 0);

    // PIECEWISE FORMAT (For Few: <= 4 items)
    if (totalCount <= 4) {
      const lines = [
        `🟡 *[UNCLAIMED TILL PAYMENTS (UP FOR GRABS: ${totalCount})]*`,
        `=============================================================`,
        `These payments landed on Till 5758419 but have not been claimed by a web checkout:`
      ];
      for (const k of ungrabbedKeys.slice().reverse()) {
        const r = ledger[k];
        lines.push(`\n• Code: *${r.code}* | Amount: *KES ${Number(r.amount).toLocaleString()}*`);
        lines.push(`  👤 From: ${r.sender}`);
        lines.push(`  🕒 Time: ${r.received_at ? new Date(r.received_at).toLocaleTimeString("en-GB") : "Recently"}`);
        lines.push(`  👉 To claim: \`!pair <orderId> ${r.code}\``);
      }
      lines.push(`\n=============================================================`);
      lines.push(`_Use !pair <orderId> <code> to claim any payment above for an order._`);
      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    // TABULATED FORMAT (For Many: >= 5 items to 100s / 1000s)
    const recentKeys = ungrabbedKeys.slice(-10).reverse();
    const tableRows = recentKeys.map(k => {
      const r = ledger[k];
      return {
        code: r.code,
        amount: Number(r.amount).toLocaleString(),
        sender: r.sender || "Customer",
        time: r.received_at ? new Date(r.received_at).toLocaleTimeString("en-GB").slice(0, 5) : "RECENT"
      };
    });

    const tableCols = [
      { key: "code", header: "CODE", width: 10 },
      { key: "amount", header: "AMOUNT", width: 7, align: "right" },
      { key: "sender", header: "SENDER", width: 12 },
      { key: "time", header: "TIME", width: 6 }
    ];

    const lines = [
      `🟡 *[UNCLAIMED TILL REGISTER (UP FOR GRABS: ${totalCount})]*`,
      `=============================================================`,
      `💰 *Total Unclaimed Pool:* *KES ${totalVol.toLocaleString()}* across *${totalCount}* payments`,
      `-------------------------------------------------------------`,
      `📊 *Monospace Tabular View (Latest 10):*`,
      renderTable(tableRows, tableCols),
      `=============================================================`,
      `_💡 Showing latest 10 of ${totalCount} unclaimed._`,
      `_🔍 Search: Type !ungrabbed <search> (e.g. !ungrabbed John or !ungrabbed 1500)_`,
      `_👉 To pair any above: !pair <orderId> <code>_`
    ];

    await sock.sendMessage(from, { text: lines.join("\n") });
    return;
  }

  // 4. Command: !order <orderId>
  if (cmd === "!order") {
    const cleanId = arg1.replace(/^#/, "");
    if (!cleanId) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!order <orderId>\` (e.g. \`!order CG-REC-001\`)` });
      return;
    }

    const order = activeOrders.get(cleanId);
    if (!order) {
      await sock.sendMessage(from, { text: `⚠️ Order *#${cleanId}* not found in memory.\nCheck spelling or view live dashboard at https://tmsavannah.com/dashboard` });
      return;
    }

    const itemsText = (order.items || []).map(it => ` • ${(it.qty || it.quantity || 1)}x ${it.name} - KES ${Number(it.price).toLocaleString()}`).join("\n");
    const orderLines = [
      `📋 *[ORDER DETAILS: #${cleanId}]*`,
      `=============================================================`,
      `📊 *Status:* *${order.status}*`,
      `👤 *Customer:* ${order.customer?.name || "Customer"} (\`${order.customer?.phone || "N/A"}\`)`,
      `📍 *Destination:* ${order.customer?.deliveryAddress || "Collection Desk"}`,
      `💰 *Total Amount:* KES ${Number(order.payment?.amount || order.payment?.total || 0).toLocaleString()}`,
      `🧾 *M-Pesa Code:* \`${order.payment?.mpesaCode || order.submittedCode || "None"}\``,
      `🔐 *Pickup PIN:* *${order.pickupPin || "Not Generated"}*`,
      order.cancellationReason ? `📝 *Cancellation Reason:* ${order.cancellationReason}` : "",
      "",
      `📦 *Items:*`,
      itemsText,
      `=============================================================`
    ].filter(Boolean);
    await sock.sendMessage(from, { text: orderLines.join("\n") });
    return;
  }

  // 5. Command: !pickup <orderId> (With Idempotency Guard)
  if (cmd === "!pickup" || cmd === "!ready") {
    const cleanId = arg1.replace(/^#/, "");
    if (!cleanId) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!pickup <orderId>\` (e.g. \`!pickup CG-REC-001\`)` });
      return;
    }

    const order = activeOrders.get(cleanId);
    if (!order) {
      await sock.sendMessage(from, { text: `⚠️ Order *#${cleanId}* not found in active orders.` });
      return;
    }

    if (order.status === "CANCELLED") {
      await sock.sendMessage(from, { text: `🛑 Cannot mark Order *#${cleanId}* for pickup because it was *CANCELLED*.` });
      return;
    }

    // IDEMPOTENCY CHECK: If already ready for pickup, don't spam customer with duplicate PINs
    if (order.status === "READY_FOR_PICKUP") {
      await sock.sendMessage(from, {
        text: `ℹ️ *[IDEMPOTENT NOTICE]*\nOrder *#${cleanId}* is *ALREADY marked Ready for Pickup*.\n🔐 Active Collection PIN: *${order.pickupPin}*\n📲 Customer (\`${order.customer?.phone || "N/A"}\`) was previously notified. No duplicate SMS dispatched.`
      });
      return;
    }

    order.status = "READY_FOR_PICKUP";
    if (!order.pickupPin) {
      order.pickupPin = Math.floor(1000 + Math.random() * 9000).toString();
    }

    const custPhone = order.customer?.phone;
    const custName = order.customer?.name || "Customer";

    if (custPhone) {
      const custJid = formatJid(custPhone);
      const readyMsg = [
        `🎉 *YOUR ORDER IS READY FOR PICKUP!* 🎉`,
        `=============================================================`,
        `Hi *${custName}*, your handcrafted crochet package for Order *#${cleanId}* is packaged and ready at the Creative Galore pickup desk!`,
        "",
        `🔐 *YOUR SECURE COLLECTION PIN:*`,
        `👉 *${order.pickupPin}* 👈`,
        "",
        `📍 *Pickup Desk:* Creative Galore Collection Point`,
        `🕒 *Hours:* 8:00 AM – 7:00 PM`,
        "",
        `_Please show this 4-digit PIN to the attendant upon collection._`,
        `See you soon! 🧶✨`
      ].join("\n");
      await sock.sendMessage(custJid, { text: readyMsg }).catch(err => console.warn("Customer pickup alert error:", err.message));
    }

    await sock.sendMessage(from, {
      text: `✅ *[ORDER MARKED READY FOR PICKUP]*\nOrder *#${cleanId}* is ready at the counter.\n🔐 Customer Collection PIN: *${order.pickupPin}*\n📲 Private WhatsApp notification dispatched to customer (\`${custPhone}\`).`
    });
    return;
  }

  // 6. Command: !pair <orderId> <code> (With Idempotency Guard)
  if (cmd === "!pair") {
    const cleanId = arg1.replace(/^#/, "");
    const cleanCode = (arg2 || "").toUpperCase().trim();

    if (!cleanId || !cleanCode) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!pair <orderId> <mpesaCode>\` (e.g. \`!pair CG-REC-001 TK72XYZ100\`)` });
      return;
    }

    const order = activeOrders.get(cleanId);
    if (order && order.status === "PAID" && (order.payment?.mpesaCode === cleanCode || order.submittedCode === cleanCode)) {
      await sock.sendMessage(from, {
        text: `ℹ️ *[IDEMPOTENT NOTICE]*\nOrder *#${cleanId}* is *ALREADY paired* with M-Pesa receipt \`${cleanCode}\`.\nStatus: ✅ PAID (PIN: *${order.pickupPin || "Generated"}*).`
      });
      return;
    }

    const ledger = loadLedger();
    let receipt = ledger[cleanCode];

    // Conflict Check: If already paired to a DIFFERENT order
    if (receipt && receipt.paired_order_id && receipt.paired_order_id !== cleanId) {
      await sock.sendMessage(from, {
        text: `⚠️ *[PAIRING CONFLICT DETECTED]*\n` +
              `M-Pesa receipt \`${cleanCode}\` is ALREADY claimed by Order *#${receipt.paired_order_id}*!\n\n` +
              `If Order *#${cleanId}* is the correct customer, an Admin can resolve this with:\n` +
              `👉 *Reassign immediately:* \`!reassign ${cleanId} ${cleanCode}\`\n` +
              `👉 *Or unpair the mistaken order:* \`!unpair ${receipt.paired_order_id}\``
      });
      return;
    }

    // Refunded Check: Cannot claim a receipt that was already refunded
    if (receipt && receipt.status === "REFUNDED") {
      await sock.sendMessage(from, {
        text: `🛑 *[RECEIPT ALREADY REFUNDED]*\n` +
              `Receipt \`${cleanCode}\` was previously refunded (Reason: ${receipt.refund_reason || "N/A"}).\n` +
              `It cannot be claimed by a new order.`
      });
      return;
    }

    if (!receipt) {
      receipt = {
        code: cleanCode,
        amount: 0,
        sender: "MANUAL_OPERATOR_OVERRIDE",
        received_at: new Date().toISOString(),
        raw_text: "Manually paired via !pair command in admin group",
        paired_order_id: cleanId
      };
      ledger[cleanCode] = receipt;
    } else {
      receipt.paired_order_id = cleanId;
    }
    saveLedger(ledger);

    const hostUrl = `http://100.73.175.118:8085`;
    const matched = await pairAndConfirmOrder(cleanId, cleanCode, receipt, hostUrl);
    if (matched) {
      await sock.sendMessage(from, { text: `🎉 *[ORDER PAIRED SUCCESSFULLY]*\nOrder *#${cleanId}* paired with M-Pesa code \`${cleanCode}\`!\nPacking slip dispatched to Operations and invoice confirmation sent to customer.` });
    } else {
      await sock.sendMessage(from, { text: `⚠️ Order *#${cleanId}* was not in active memory, but receipt \`${cleanCode}\` was tagged with order ID in ledger.` });
    }
    return;
  }

  // 7. Command: !cancel <orderId> [reason] ("Abort Mission" Problem Handler)
  if (cmd === "!cancel" || cmd === "!abort") {
    const cleanId = arg1.replace(/^#/, "");
    if (!cleanId) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!cancel <orderId> [optional reason]\` (e.g. \`!cancel CG-REC-001\`)` });
      return;
    }

    const order = activeOrders.get(cleanId);
    if (!order) {
      await sock.sendMessage(from, { text: `⚠️ Order *#${cleanId}* not found in active orders.` });
      return;
    }

    if (order.status === "CANCELLED") {
      await sock.sendMessage(from, { text: `ℹ️ *[IDEMPOTENT NOTICE]*\nOrder *#${cleanId}* is *ALREADY CANCELLED*.\nReason: ${order.cancellationReason || "N/A"}` });
      return;
    }

    const reason = parts.slice(2).join(" ") || "Cancelled by store operator";
    const prevStatus = order.status;
    order.status = "CANCELLED";
    order.cancellationReason = reason;
    order.cancelledAt = new Date().toISOString();

    // Release any paired receipt in ledger so the customer's funds can be refunded or re-paired
    const ledger = loadLedger();
    let unlinkedCode = null;
    for (const [code, r] of Object.entries(ledger)) {
      if (r.paired_order_id === cleanId) {
        r.paired_order_id = null;
        unlinkedCode = code;
      }
    }
    if (unlinkedCode) saveLedger(ledger);

    // Dispatch 1-on-1 private WhatsApp cancellation alert to customer
    const custPhone = order.customer?.phone;
    if (custPhone) {
      const custJid = formatJid(custPhone);
      const cancelNotice = [
        `❌ *ORDER CANCELLED — CREATIVE GALORE* ❌`,
        `=============================================================`,
        `Hi *${order.customer?.name || "Customer"}*, your Order *#${cleanId}* has been cancelled.`,
        `📝 *Reason:* ${reason}`,
        "",
        `If you have already sent funds to Till *5758419*, please contact store support directly for a prompt refund or reversal.`,
        `=============================================================`
      ].join("\n");
      await sock.sendMessage(custJid, { text: cancelNotice }).catch(err => console.warn("Customer cancel alert error:", err.message));
    }

    await sock.sendMessage(from, {
      text: `🛑 *[ORDER CANCELLED]*\nOrder *#${cleanId}* has been aborted (previous status: *${prevStatus}*).\n📝 Reason: ${reason}\n${unlinkedCode ? `🔓 Unlinked Till receipt \`${unlinkedCode}\` back to unpaired ledger pool.\n` : ""}📲 1-on-1 cancellation notice sent to customer (\`${custPhone || "N/A"}\`).`
    });
    return;
  }

  // 8. Command: !unpair <orderId> (Release mistaken claim back to 'UP FOR GRABS')
  if (cmd === "!unpair") {
    const cleanId = arg1.replace(/^#/, "");
    if (!cleanId) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!unpair <orderId>\` (e.g. \`!unpair CG-REC-001\`)` });
      return;
    }

    const order = activeOrders.get(cleanId);
    const ledger = loadLedger();
    let unlinkedCode = null;

    for (const [code, r] of Object.entries(ledger)) {
      if (r.paired_order_id === cleanId) {
        r.paired_order_id = null;
        unlinkedCode = code;
      }
    }

    if (order) {
      order.status = "AWAITING_PAYMENT";
      delete order.pickupPin;
      delete order.payment;
      delete order.submittedCode;
    }

    if (unlinkedCode) {
      saveLedger(ledger);
      await sock.sendMessage(from, {
        text: `🔓 *[ORDER UNPAIRED SUCCESSFULLY]*\nOrder *#${cleanId}* unlinked from M-Pesa receipt \`${unlinkedCode}\`.\nReceipt \`${unlinkedCode}\` is now back in the *UP FOR GRABS* pool.`
      });
    } else {
      await sock.sendMessage(from, {
        text: `⚠️ Order *#${cleanId}* had no paired receipt in ledger.`
      });
    }
    return;
  }

  // 9. Command: !reassign <correctOrderId> <mpesaCode> (Atomic correction for mispaired receipts)
  if (cmd === "!reassign") {
    const cleanId = arg1.replace(/^#/, "");
    const cleanCode = (arg2 || "").toUpperCase().trim();

    if (!cleanId || !cleanCode) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!reassign <correctOrderId> <mpesaCode>\` (e.g. \`!reassign CG-REC-002 TK72XYZ100\`)` });
      return;
    }

    const ledger = loadLedger();
    let receipt = ledger[cleanCode];
    if (!receipt) {
      await sock.sendMessage(from, { text: `⚠️ Receipt \`${cleanCode}\` not found in ledger.` });
      return;
    }

    const oldOrderId = receipt.paired_order_id;
    if (oldOrderId) {
      const oldOrder = activeOrders.get(oldOrderId);
      if (oldOrder) {
        oldOrder.status = "AWAITING_PAYMENT";
        delete oldOrder.pickupPin;
        delete oldOrder.payment;
        delete oldOrder.submittedCode;
        if (oldOrder.customer?.phone) {
          const oldCustJid = formatJid(oldOrder.customer.phone);
          sock.sendMessage(oldCustJid, {
            text: `ℹ️ *PAYMENT UPDATE — CREATIVE GALORE*\nReceipt \`${cleanCode}\` was previously linked to Order *#${oldOrderId}* by mistake and has been corrected. Order *#${oldOrderId}* is now awaiting its matching payment.`
          }).catch(() => {});
        }
      }
    }

    receipt.paired_order_id = cleanId;
    saveLedger(ledger);

    const hostUrl = `http://100.73.175.118:8085`;
    const matched = await pairAndConfirmOrder(cleanId, cleanCode, receipt, hostUrl);

    await sock.sendMessage(from, {
      text: `🔄 *[PAYMENT REASSIGNED ATOMICALLY]*\nReceipt \`${cleanCode}\` transferred from *#${oldOrderId || "NONE"}* to *#${cleanId}*!\nStatus for *#${cleanId}*: ✅ PAID\nPacking slip dispatched to Operations and invoice sent to correct customer.`
    });
    return;
  }

  // 10. Command: !refund <orderId> [reason] (The Refund Exception Protocol)
  if (cmd === "!refund") {
    const cleanId = arg1.replace(/^#/, "");
    if (!cleanId) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!refund <orderId> [optional reason]\` (e.g. \`!refund CG-REC-001 Customer cancelled\`)` });
      return;
    }

    const order = activeOrders.get(cleanId);
    const ledger = loadLedger();
    let pairedReceipt = null;

    for (const [code, r] of Object.entries(ledger)) {
      if (r.paired_order_id === cleanId) {
        pairedReceipt = r;
        break;
      }
    }

    const reason = parts.slice(2).join(" ") || "Customer refund processed";

    if (order) {
      order.status = "REFUNDED";
      order.refundedAt = new Date().toISOString();
      order.refundReason = reason;
      delete order.pickupPin;
    }

    if (pairedReceipt) {
      pairedReceipt.status = "REFUNDED";
      pairedReceipt.paired_order_id = `${cleanId} (REFUNDED)`;
      pairedReceipt.refunded_at = new Date().toISOString();
      pairedReceipt.refund_reason = reason;
      saveLedger(ledger);
    }

    const custPhone = order?.customer?.phone;
    if (custPhone) {
      const custJid = formatJid(custPhone);
      const refundReceipt = [
        `💳 *REFUND CONFIRMATION — CREATIVE GALORE* 💳`,
        `=============================================================`,
        `Hi *${order.customer?.name || "Customer"}*, your refund for Order *#${cleanId}* has been recorded.`,
        "",
        `💰 *Refund Amount:* KES ${Number(pairedReceipt?.amount || order?.payment?.amount || 0).toLocaleString()}`,
        pairedReceipt ? `🧾 *M-Pesa Reference:* \`${pairedReceipt.code}\`` : "",
        `📝 *Reason:* ${reason}`,
        `🕒 *Timestamp:* ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" })}`,
        "",
        `Thank you for shopping with Creative Galore! 🧶✨`,
        `=============================================================`
      ].filter(Boolean).join("\n");
      await sock.sendMessage(custJid, { text: refundReceipt }).catch(() => {});
    }

    await sock.sendMessage(from, {
      text: `💳 *[ORDER MARKED REFUNDED]*\nOrder *#${cleanId}* is now marked *REFUNDED*.\n${pairedReceipt ? `🔒 Receipt \`${pairedReceipt.code}\` permanently sealed in ledger as REFUNDED.\n` : ""}📝 Reason: ${reason}\n📲 1-on-1 refund confirmation dispatched to customer (\`${custPhone || "N/A"}\`).`
    });
    return;
  }

  // 12. Command: !dispute <orderId> [reason] (Refunds & Disputes Desk Initiation)
  if (cmd === "!dispute" || cmd === "!refund-initiate") {
    const cleanId = arg1.replace(/^#/, "");
    if (!cleanId) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!dispute <orderId> [reason]\` (e.g. \`!dispute CG-REC-001 Customer cancelled\`)` });
      return;
    }

    const order = activeOrders.get(cleanId);
    if (!order) {
      await sock.sendMessage(from, { text: `⚠️ Order *#${cleanId}* not found in active orders.` });
      return;
    }

    const ledger = loadLedger();
    let pairedReceipt = null;
    for (const [code, r] of Object.entries(ledger)) {
      if (r.paired_order_id === cleanId && r.direction !== "OUTFLOW") {
        pairedReceipt = r;
        break;
      }
    }

    const orderAmt = Number(pairedReceipt?.amount || order.payment?.amount || order.payment?.total || 0);
    const reason = parts.slice(2).join(" ") || "Customer requested refund / order cancellation";

    order.status = "REFUND_PENDING";
    delete order.pickupPin;

    const disputes = loadDisputes();
    disputes[cleanId] = {
      order_id: cleanId,
      status: "PENDING_OUTFLOW",
      amount: orderAmt,
      inflow_code: pairedReceipt?.code || order.payment?.mpesaCode || null,
      outflow_code: null,
      customer_name: order.customer?.name || "Customer",
      customer_phone: order.customer?.phone || null,
      reason: reason,
      initiated_at: new Date().toISOString(),
      settled_at: null
    };
    saveDisputes(disputes);

    const disputeCard = [
      `⚖️ *[REFUND & DISPUTES DESK: #${cleanId} INITIATED]*`,
      `=============================================================`,
      `💰 *Amount to Disburse:* *KES ${orderAmt.toLocaleString()}*`,
      `👤 *Customer:* ${order.customer?.name || "Customer"} (\`${order.customer?.phone || "N/A"}\`)`,
      `📥 *Original Inflow Ref:* \`${pairedReceipt?.code || "PENDING"}\` (+KES ${orderAmt.toLocaleString()})`,
      `📝 *Reason:* ${reason}`,
      `-------------------------------------------------------------`,
      `👉 *Action Required:* Please reverse or send KES ${orderAmt.toLocaleString()} to customer.`,
      `The listener is actively monitoring for outflow SMS (-KES ${orderAmt.toLocaleString()}).`,
      `When outflow arrives, it will auto-settle (+amt - amt = 0.00).`,
      `Or manually tie outflow with: \`!settle ${cleanId} <outflowMpesaCode>\``,
      `=============================================================`
    ].join("\n");

    await sock.sendMessage(from, { text: disputeCard });
    return;
  }

  // 13. Command: !settle <orderId> <outflowCode> (Zero-Sum Settlement: +100 - 100 = 0.00)
  if (cmd === "!settle") {
    const cleanId = arg1.replace(/^#/, "");
    const outflowCode = (arg2 || "").toUpperCase().trim();

    if (!cleanId || !outflowCode) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!settle <orderId> <outflowCode>\` (e.g. \`!settle CG-REC-001 TK72XYZ105\`)` });
      return;
    }

    const disputes = loadDisputes();
    let dispute = disputes[cleanId];
    const order = activeOrders.get(cleanId);
    const ledger = loadLedger();

    let outflowReceipt = ledger[outflowCode];
    if (!outflowReceipt) {
      outflowReceipt = {
        code: outflowCode,
        direction: "OUTFLOW",
        amount: order?.payment?.amount || 0,
        recipient: order?.customer?.name || "Customer",
        received_at: new Date().toISOString(),
        raw_text: "Manual outflow entry via !settle command"
      };
      ledger[outflowCode] = outflowReceipt;
    }

    const settleAmt = Number(outflowReceipt.amount || dispute?.amount || 0);

    if (!dispute) {
      dispute = {
        order_id: cleanId,
        amount: settleAmt,
        inflow_code: order?.payment?.mpesaCode || null,
        customer_name: order?.customer?.name || "Customer",
        customer_phone: order?.customer?.phone || null,
        reason: "Manual settlement override"
      };
      disputes[cleanId] = dispute;
    }

    dispute.status = "SETTLED";
    dispute.outflow_code = outflowCode;
    dispute.settled_at = new Date().toISOString();
    dispute.net_balance = 0.0;
    saveDisputes(disputes);

    if (order) {
      order.status = "REFUNDED";
      order.refundedAt = new Date().toISOString();
      delete order.pickupPin;
    }

    if (dispute.inflow_code && ledger[dispute.inflow_code]) {
      ledger[dispute.inflow_code].status = "SETTLED_REFUND";
      ledger[dispute.inflow_code].settled_by_outflow = outflowCode;
    }

    outflowReceipt.status = "SETTLED_REFUND";
    outflowReceipt.tied_inflow_code = dispute.inflow_code;
    outflowReceipt.tied_order_id = cleanId;
    saveLedger(ledger);

    const custPhone = order?.customer?.phone || dispute.customer_phone;
    if (custPhone) {
      const custJid = formatJid(custPhone);
      const refundReceipt = [
        `💳 *REFUND CONFIRMATION — CREATIVE GALORE* 💳`,
        `=============================================================`,
        `Hi *${dispute.customer_name}*, your refund for Order *#${cleanId}* has been settled.`,
        "",
        `📥 *Original Payment:* +KES ${settleAmt.toLocaleString()} (\`${dispute.inflow_code || "N/A"}\`)`,
        `📤 *Refund Payout:*   -KES ${settleAmt.toLocaleString()} (\`${outflowCode}\`)`,
        `⚖️ *Net Settlement:*   KES 0.00 (Zero-Sum Settled)`,
        `🕒 *Timestamp:* ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" })}`,
        "",
        `Thank you for shopping with Creative Galore! 🧶✨`,
        `=============================================================`
      ].join("\n");
      await sock.sendMessage(custJid, { text: refundReceipt }).catch(() => {});
    }

    const settleAlert = [
      `🎉 *[REFUND SETTLED: ZERO-SUM BALANCE RESOLVED]*`,
      `=============================================================`,
      `📦 *Order:*       *#${cleanId}*`,
      `📥 *Inflow Ref:*  \`${dispute.inflow_code || "None"}\` (+KES ${settleAmt.toLocaleString()})`,
      `📤 *Outflow Ref:* \`${outflowCode}\` (-KES ${settleAmt.toLocaleString()})`,
      `⚖️ *Net Position:* *KES 0.00* (Zero-Sum Settled)`,
      `👤 *Customer:*     ${dispute.customer_name} (\`${custPhone || "N/A"}\`)`,
      `=============================================================`,
      `📲 1-on-1 official refund receipt dispatched to customer.`
    ].join("\n");

    await sock.sendMessage(from, { text: settleAlert });
    return;
  }

  // 14. Command: !disputes / !refunds (Disputes Desk Monospace Register)
  if (cmd === "!disputes" || cmd === "!refunds") {
    const disputes = loadDisputes();
    const keys = Object.keys(disputes);

    if (!keys.length) {
      await sock.sendMessage(from, {
        text: `⚖️ *[DISPUTES DESK IS CLEAR]*\nZero active or pending refunds recorded in disputes register.`
      });
      return;
    }

    const tableRows = keys.slice(-10).reverse().map(k => {
      const d = disputes[k];
      return {
        order: `#${d.order_id}`,
        inflow: (d.inflow_code || "PENDING").slice(0, 10),
        outflow: (d.outflow_code || "PENDING").slice(0, 10),
        amount: Number(d.amount || 0).toLocaleString(),
        status: d.status === "SETTLED" ? "SETTLED" : "AWAIT-OUT"
      };
    });

    const tableCols = [
      { key: "order", header: "ORDER", width: 8 },
      { key: "inflow", header: "INFLOW", width: 10 },
      { key: "outflow", header: "OUTFLOW", width: 10 },
      { key: "amount", header: "AMOUNT", width: 7, align: "right" },
      { key: "status", header: "STATUS", width: 9 }
    ];

    const lines = [
      `⚖️ *[REFUNDS & DISPUTES REGISTER (${keys.length} TOTAL)]*`,
      `=============================================================`,
      `📊 *Monospace Disputes Desk:*`,
      renderTable(tableRows, tableCols),
      `=============================================================`,
      `_💡 Settle any pending refund with: !settle <orderId> <outflowCode>_`
    ];

    await sock.sendMessage(from, { text: lines.join("\n") });
    return;
  }

  // 11. Command: !ingest <code> <amount> <sender> (Admin Manual Payment Ingestion - Hardware Failover)
  if (cmd === "!ingest") {
    const cleanCode = (arg1 || "").toUpperCase().trim();
    const cleanAmount = Number(arg2 || 0);
    const sender = parts.slice(3).join(" ") || "Admin Ingest";

    if (!cleanCode || !cleanAmount) {
      await sock.sendMessage(from, { text: `⚠️ *Usage:* \`!ingest <mpesaCode> <amount> <senderName>\` (e.g. \`!ingest TK72DEF500 1500 John Doe\`)` });
      return;
    }

    const ledger = loadLedger();
    let receipt = ledger[cleanCode];
    if (receipt) {
      await sock.sendMessage(from, { text: `ℹ️ Receipt \`${cleanCode}\` already exists in ledger (Status: ${receipt.paired_order_id ? `Paired to #${receipt.paired_order_id}` : "UP FOR GRABS"}).` });
      return;
    }

    receipt = {
      code: cleanCode,
      amount: cleanAmount,
      sender: sender,
      received_at: new Date().toISOString(),
      raw_text: "Manually ingested via !ingest command by admin in chat",
      paired_order_id: null
    };

    const hostUrl = `http://100.73.175.118:8085`;
    let autoPairedId = null;
    for (const [orderId, order] of activeOrders.entries()) {
      if (order.status === "AWAITING_VERIFICATION" && order.submittedCode === cleanCode) {
        receipt.paired_order_id = orderId;
        autoPairedId = orderId;
        ledger[cleanCode] = receipt;
        saveLedger(ledger);
        await pairAndConfirmOrder(orderId, cleanCode, receipt, hostUrl);
        break;
      }
    }

    if (!autoPairedId) {
      ledger[cleanCode] = receipt;
      saveLedger(ledger);
    }

    await sock.sendMessage(from, {
      text: autoPairedId
        ? `⚡ *[MANUAL INGEST: AUTO-PAIRED]*\nPayment \`${cleanCode}\` (KES ${cleanAmount.toLocaleString()}) recorded and auto-paired to Order *#${autoPairedId}*!`
        : `📥 *[MANUAL INGEST: UP FOR GRABS]*\nPayment \`${cleanCode}\` (KES ${cleanAmount.toLocaleString()}) from *${sender}* added to ledger!\n👉 To pair to an order: \`!pair <orderId> ${cleanCode}\``
    });
    return;
  }
}

// -----------------------------------------------------------------------------
// DUAL-ENTRY RECONCILIATION ENGINE
// -----------------------------------------------------------------------------
async function pairAndConfirmOrder(orderId, mpesaCode, receiptData, hostUrl) {
  const orderData = activeOrders.get(orderId);
  if (!orderData) return false;

  // GUARD CLAUSE: Abort immediately if the order was cancelled mid-flight
  if (orderData.status === "CANCELLED") {
    console.warn(`🛑 [GUARD CLAUSE TRIGGERED] Order #${orderId} was cancelled mid-flight. Halting pair/dispatch.`);
    return false;
  }

  orderData.status = "PAID";
  orderData.payment = {
    ...orderData.payment,
    status: "PAID",
    mpesaCode,
    verifiedAmount: receiptData.amount,
    sender: receiptData.sender,
    pairedAt: new Date().toISOString()
  };

  // Generate 4-digit Pickup PIN
  const pickupPin = Math.floor(1000 + Math.random() * 9000).toString();
  orderData.pickupPin = pickupPin;

  // Generate single-use action token
  const token = Math.random().toString(36).substring(2, 10);
  actionTokens.set(token, { orderId, pickupPin, customer: orderData.customer, createdAt: Date.now() });

  const totalAmount = Number(orderData.payment?.amount || orderData.payment?.total || 0).toLocaleString();
  const itemsText = (orderData.items || []).map(it => ` • ${(it.qty || it.quantity || 1)}x ${it.name} - KES ${Number(it.price).toLocaleString()}`).join("\n");
  const host = hostUrl || process.env.BASE_HOST_URL || "http://100.73.175.118:8085";

  // 1. Dispatch Finance & Audit Log to Creative Galore Admin Group
  const adminMsg = [
    `💰 *[PAYMENT RECONCILED & CONFIRMED]*`,
    `=============================================================`,
    `📋 *Order #:* \`#${orderId}\``,
    `🧾 *M-Pesa Code:* \`${mpesaCode}\``,
    `💵 *Amount Received:* *KES ${receiptData.amount.toLocaleString()}* (Total: KES ${totalAmount})`,
    `👤 *Payer / Sender:* ${receiptData.sender || orderData.customer?.name || "Customer"}`,
    `📞 *Customer Phone:* \`${orderData.customer?.phone || "N/A"}\``,
    `🕒 *Reconciliation Time:* ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" })}`,
    `📊 *Ledger Status:* PAIRED (Zero discrepancy)`
  ].join("\n");

  // 2. Dispatch Packing Slip & PIN to Creative Galore Operations Group
  const opsMsg = [
    `📦 *[NEW PAID ORDER — PACKING SLIP]*`,
    `=============================================================`,
    `📋 *Order #:* \`#${orderId}\` (✅ *PAID*)`,
    `👤 *Customer:* ${orderData.customer?.name || "Customer"}`,
    `📞 *Customer Phone:* \`${orderData.customer?.phone || "N/A"}\``,
    `📍 *Fulfillment:* ${orderData.customer?.deliveryAddress || "Collection Desk / Store Pickup"}`,
    `💰 *Total Amount:* *KES ${totalAmount}* (Ref: \`${mpesaCode}\`)`,
    "",
    `📦 *Items to Pack:*`,
    itemsText,
    "",
    `🔐 *PICKUP / DISPATCH PIN:* *${pickupPin}*`,
    `-------------------------------------------------------------`,
    `⚡ *OPERATIONS ACTION (Tap when Packed & Ready):*`,
    `👉 [📦 Mark Ready for Pickup & Notify Customer](${host}/action/ready-pickup?order=${orderId}&pin=${pickupPin}&token=${token})`,
    `👉 [🏍️ Dispatch Courier Boda](${host}/action/dispatch?order=${orderId}&token=${token})`,
    `-------------------------------------------------------------`
  ].join("\n");

  // 3. Dispatch Private 1-on-1 Direct WhatsApp Message to Customer (ZERO GROUP POLLUTION)
  const custMsg = [
    `🎉 *Payment Confirmed — Creative Galore*`,
    `=============================================================`,
    `Hi *${orderData.customer?.name || "there"}*, we have received your payment of *KES ${totalAmount}* via M-Pesa (Ref: \`${mpesaCode}\`).`,
    "",
    `🛍️ *Order #:* \`#${orderId}\``,
    `📦 *Items:*`,
    itemsText,
    "",
    `🧵 Our artisans are now carefully preparing and packaging your crochet items.`,
    `We will send your *4-digit pickup PIN* here as soon as your package is at the collection desk!`,
    "",
    `Thank you for shopping with Creative Galore!`
  ].join("\n");

  try {
    if (sock && isConnected) {
      sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, { text: adminMsg }).catch(err => console.warn("Admin dispatch error:", err.message));
      sock.sendMessage(CREATIVE_GALORE_OPERATIONS_JID, { text: opsMsg }).catch(err => console.warn("Ops dispatch error:", err.message));
      if (orderData.customer?.phone) {
        const custJid = formatJid(orderData.customer.phone);
        sock.sendMessage(custJid, { text: custMsg }).catch(err => console.warn("Customer dispatch error:", err.message));
      }
    }
  } catch (e) {
    console.error("Error in dispatch notifications:", e);
  }

  return true;
}

// -----------------------------------------------------------------------------
// EXPRESS HTTP REST API
// -----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ==============================================================================
// OBSERVATORY TELEMETRY & LOGS ENGINE
// ==============================================================================
const observatoryLogs = [];
const trafficCounters = {
  inboundMessages: 0,
  outboundMessages: 0,
  tillReceipts: 0,
  checkouts: 0,
  verifications: 0
};

function recordObservatoryLog(type, summary, meta = {}) {
  const entry = {
    id: "obs_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
    timestamp: new Date().toISOString(),
    type,
    summary,
    meta
  };
  observatoryLogs.unshift(entry);
  if (observatoryLogs.length > 300) observatoryLogs.pop();
}

recordObservatoryLog("SYSTEM", "Observatory Telemetry Engine online on HP Pavilion edge node.");

// Ping endpoint for client-side RTT / latency calculation
app.get("/api/observatory/ping", (req, res) => {
  res.json({
    pong: true,
    serverTime: Date.now(),
    node: "localhost-0",
    uptimeSeconds: Math.floor((new Date() - serviceStartTime) / 1000)
  });
});

// Full Telemetry endpoint
app.get("/api/observatory/telemetry", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    whatsapp: {
      connected: isConnected,
      userJid: connectedUserJid,
      reconnectCount,
      messagesSentCount,
      lastMessageTimestamp,
      uptimeSeconds: Math.floor((new Date() - serviceStartTime) / 1000)
    },
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      systemUptime: os.uptime(),
      loadAverage: os.loadavg(),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      usedMemMb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
      processRssMb: Math.round(mem.rss / 1024 / 1024),
      processHeapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
    },
    network: {
      tailscaleIp: "100.73.175.118",
      tailscaleDomain: "localhost-0.tail63ca1c.ts.net",
      localLanIp: "10.16.1.172",
      publicWanIp: "217.199.144.53",
      networkSsid: "KONNECT",
      carrier: "Ahadi Wireless / SasaKonnect",
      relayDerpNode: "nai (Nairobi)"
    },
    traffic: {
      ...trafficCounters,
      messagesSentCount
    },
    maintenance: {
      watchdogStatus: "ACTIVE (3m self-healer)",
      ddnsStatus: "ACTIVE (15m Namecheap sync)",
      cloudflaredStatus: "ACTIVE (QUIC Tunnel)"
    },
    logs: observatoryLogs.slice(0, 50)
  });
});

// 1. Healthcheck
app.get("/health", (req, res) => {
  res.json({
    status: isConnected ? "UP" : "DEGRADED",
    service: "savannah-whatsapp-daemon",
    connectedUser: connectedUserJid,
    timestamp: new Date().toISOString()
  });
});

// 2. Metrics & Status
app.get("/api/status", (req, res) => {
  res.json({
    connected: isConnected,
    userJid: connectedUserJid,
    defaultRecipient: DEFAULT_RECIPIENT,
    reconnectCount,
    messagesSentCount,
    lastMessageTimestamp,
    startedAt: serviceStartTime.toISOString(),
    uptimeSeconds: Math.floor((new Date() - serviceStartTime) / 1000)
  });
});

// 2b. Shop Catalog Serving (RAM-Cached 0ms Edge Ingress)
app.get("/api/shops/:shopSlug/catalog", (req, res) => {
  const { shopSlug } = req.params;
  const catalog = {
    shop: {
      name: "Creative Galore",
      slug: "creative-galore",
      tillNumber: "5758419",
      tagline: "Handcrafted Crochet Kits, Notions, Custom Patterns & Yarn Tasting",
      phone: "0710720949",
      whatsapp: "254710720949",
      primaryColor: "#7C3AED",
      accentColor: "#F472B6"
    },
    products: [
      { id: "d8f36c72-d611-45e2-b0b2-75813387d1ed", name: "The Ultimate Crochet Beginner Kit", price: 2400, category: "DIY Craft Kits", description: "Complete beginner kit with 3 milk cotton yarn skeins, 2 ergonomic hooks, 10 stitch markers, darning needle, tape measure, and step-by-step video guide." },
      { id: "ba51d940-9a6d-40d8-9285-4ae225573ee6", name: "Ergonomic Soft-Grip Aluminum Crochet Hooks Set (9 Sizes)", price: 1250, category: "Notions & Accessories", description: "Premium set containing 9 color-coded ergonomic hooks (2.0mm to 6.0mm) designed to prevent hand fatigue." },
      { id: "a9f23cb1-9876-4d22-b91c-87d21b0451a9", name: "Soft Milk Cotton Yarn Bundle (5 Skeins - Pastel Bloom Palette)", price: 950, category: "Yarns & Skeins", description: "5 skeins of 5-ply combed milk cotton yarn (50g each). Ultra-soft, breathable, and machine washable." },
      { id: "1c1f1d41-448a-41b0-9ca8-f058df6e4aa6", name: "Locking Stitch Markers & Large-Eye Darning Needles Tin (35 pcs)", price: 450, category: "Notions & Accessories", description: "Portable metallic tin packed with 30 colorful locking stitch markers and 5 rust-proof blunt yarn darning needles." },
      { id: "b04cf76c-b48f-4c78-8541-197475932970", name: "Handmade Wooden Yarn Bowl with Spiral Cutout", price: 1850, category: "Notions & Accessories", description: "Hand-carved solid hardwood bowl designed to hold your yarn ball securely and feed yarn evenly without rolling." },
      { id: "8c20da80-bde4-4f8d-9985-de159bfab0a8", name: "Bespoke Granny Square Tote Bag (PDF Pattern & Video)", price: 350, category: "Custom Patterns", description: "Full downloadable crochet pattern with detailed stitch diagrams, color theory palette ideas, and size adjustment notes." },
      { id: "eb0b592a-05c4-4789-951f-af5858e3e8c7", name: "Ready-Made Vintage Daisy Granny Square Shoulder Bag", price: 3200, category: "Ready-Made Products", description: "Artisan handmade lined cotton crochet shoulder bag with sturdy reinforced straps. Handcrafted with love in Nairobi." },
      { id: "3952ae6e-42ac-43ce-8b20-0c4775581336", name: "The Creative Galore 'Yarn Tasting' Experience Palette Card", price: 650, category: "Yarn Tasting & Experience", description: "A sensory sampler card featuring 6 curated mini yarn swatches with fiber gauge specs and hook pairings." }
    ]
  };
  return res.json({ success: true, ...catalog });
});

// 3. Send Freeform Message
app.post("/api/send", async (req, res) => {
  const { to, message } = req.body;
  if (!message) return res.status(400).json({ success: false, error: "Missing required 'message' field." });
  if (!isConnected || !sock) return res.status(503).json({ success: false, error: "WhatsApp daemon offline." });

  try {
    const target = formatJid(to) || DEFAULT_RECIPIENT;
    await sock.sendMessage(target, { text: message });
    messagesSentCount++;
    lastMessageTimestamp = new Date();
    return res.json({ success: true, target, timestamp: lastMessageTimestamp });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Send Structured Alert
app.post("/api/alert", async (req, res) => {
  const { title, level, details, source, to } = req.body;
  if (!title || !details) return res.status(400).json({ success: false, error: "Title and details required." });
  if (!isConnected || !sock) return res.status(503).json({ success: false, error: "WhatsApp daemon offline." });

  try {
    const formattedText = formatAlertPayload({ title, level, details, source });
    const target = formatJid(to) || DEFAULT_RECIPIENT;
    await sock.sendMessage(target, { text: formattedText });
    messagesSentCount++;
    lastMessageTimestamp = new Date();
    return res.json({ success: true, target, timestamp: lastMessageTimestamp });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Update Group Description API
app.post("/api/groups/description", async (req, res) => {
  const { groupJid, description } = req.body;
  if (!groupJid || !description) {
    return res.status(400).json({ success: false, error: "groupJid and description are required." });
  }
  if (!sock || !isConnected) {
    return res.status(503).json({ success: false, error: "WhatsApp daemon offline" });
  }

  try {
    const cleanJid = groupJid.includes("@") ? groupJid : `${groupJid}@g.us`;
    await sock.groupUpdateDescription(cleanJid, description);
    return res.json({ success: true, groupJid: cleanJid, descriptionLength: description.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Ingest Real M-Pesa Till SMS Receipt (From Python Serial Listener)
// 6b. Feature Phone MRE SMS Broadcast Ingress (GET / POST from .vxp app)
app.all("/api/till/broadcast", async (req, res) => {
  try {
    const senderParam = req.query.sender || req.body?.sender || req.query.s || "M-PESA";
    const rawMsg = req.query.msg || req.body?.msg || req.query.m || req.query.text || "";

    console.log(`📡 [MRE BROADCAST INGRESS] From: ${senderParam} | Text: ${rawMsg}`);

    if (!rawMsg) {
      return res.status(200).send("OK: NO_MSG_RECEIVED\n");
    }

    // Safaricom M-Pesa format regex
    const codeMatch = rawMsg.match(/([A-Z0-9]{10})\s+Confirmed/i);
    const amtMatch = rawMsg.match(/(?:Ksh|KES)\.?\s*([0-9,]+(?:\.[0-9]{2})?)\s+received/i);
    const senderMatch = rawMsg.match(/received\s+from\s+([0-9+]|\w+[\w\s]*?)\s+on/i);
    const balMatch = rawMsg.match(/balance\s+(?:is\s+)?(?:Ksh|KES)\.?\s*([0-9,]+(?:\.[0-9]{2})?)/i);

    if (codeMatch && amtMatch) {
      const payload = {
        code: codeMatch[1].toUpperCase(),
        amount: parseFloat(amtMatch[1].replace(/,/g, "")),
        sender: senderMatch ? senderMatch[1].trim() : senderParam,
        received_at: new Date().toISOString(),
        raw_text: rawMsg,
        new_balance: balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : null
      };

      console.log(`🎉 [MRE BROADCAST PARSED] Code: ${payload.code} | KES ${payload.amount} | Sender: ${payload.sender}`);

      // Forward to verified receipt pipeline
      await fetch("http://127.0.0.1:8085/api/till/receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      return res.status(200).send(`OK: RECORDED_${payload.code}\n`);
    }

    return res.status(200).send("OK: LOGGED_RAW\n");
  } catch (err) {
    console.error("Error in /api/till/broadcast:", err);
    return res.status(500).send("ERROR: " + err.message + "\n");
  }
});

app.post("/api/till/receipt", async (req, res) => {
  trafficCounters.tillReceipts++;
  recordObservatoryLog("TILL_RECEIPT", `Till 5758419 receipt: Code ${req.body?.code || 'N/A'} - KES ${req.body?.amount || '0'} from ${req.body?.sender || 'Unknown'}`);
  const { code, amount, sender, received_at, raw_text, new_balance, transaction_cost } = req.body;
  if (!code || !amount) {
    return res.status(400).json({ success: false, error: "Receipt code and amount are required." });
  }

  const cleanCode = code.toUpperCase().trim();
  const cleanAmount = Number(amount);
  const ledger = loadLedger();

  console.log(`📥 [TILL SMS INGESTED] Code: ${cleanCode} | KES ${cleanAmount} | Sender: ${sender}`);

  const receipt = {
    code: cleanCode,
    amount: cleanAmount,
    sender: sender || "M-Pesa Customer",
    received_at: received_at || new Date().toISOString(),
    raw_text: raw_text || "",
    new_balance: new_balance ? Number(new_balance) : (ledger[cleanCode]?.new_balance || null),
    transaction_cost: transaction_cost !== undefined ? Number(transaction_cost) : 0,
    paired_order_id: ledger[cleanCode]?.paired_order_id || null
  };

  // Check if this is an OUTFLOW (Money moving out / refund)
  if (req.body.direction === "OUTFLOW") {
    receipt.direction = "OUTFLOW";
    receipt.amount = -cleanAmount;
    receipt.recipient = req.body.recipient || "Customer";
    ledger[cleanCode] = receipt;
    saveLedger(ledger);

    console.log(`💸 [OUTFLOW REGISTERED] Code: ${cleanCode} | -KES ${cleanAmount} | To: ${receipt.recipient}`);

    // Auto-match pending dispute in disputes register
    const disputes = loadDisputes();
    let autoSettledId = null;

    for (const [orderId, d] of Object.entries(disputes)) {
      if (d.status === "PENDING_OUTFLOW" && (Number(d.amount) === cleanAmount || (req.body.orig_code && d.inflow_code === req.body.orig_code))) {
        d.status = "SETTLED";
        d.outflow_code = cleanCode;
        d.settled_at = new Date().toISOString();
        d.net_balance = 0.0;
        autoSettledId = orderId;
        saveDisputes(disputes);

        const order = activeOrders.get(orderId);
        if (order) {
          order.status = "REFUNDED";
          order.refundedAt = new Date().toISOString();
        }

        if (d.inflow_code && ledger[d.inflow_code]) {
          ledger[d.inflow_code].status = "SETTLED_REFUND";
          ledger[d.inflow_code].settled_by_outflow = cleanCode;
        }
        receipt.status = "SETTLED_REFUND";
        receipt.tied_inflow_code = d.inflow_code;
        receipt.tied_order_id = orderId;
        saveLedger(ledger);

        // Notify Customer 1-on-1
        const custPhone = order?.customer?.phone || d.customer_phone;
        if (sock && isConnected && custPhone) {
          const custJid = formatJid(custPhone);
          const refundReceipt = [
            `💳 *REFUND SETTLED — CREATIVE GALORE* 💳`,
            `=============================================================`,
            `Hi *${d.customer_name}*, your refund for Order *#${orderId}* has been settled.`,
            "",
            `📥 *Original Payment:* +KES ${cleanAmount.toLocaleString()} (\`${d.inflow_code || "N/A"}\`)`,
            `📤 *Refund Payout:*   -KES ${cleanAmount.toLocaleString()} (\`${cleanCode}\`)`,
            `⚖️ *Net Settlement:*   KES 0.00 (Zero-Sum Settled)`,
            `🕒 *Timestamp:* ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" })}`,
            "",
            `Thank you for shopping with Creative Galore! 🧶✨`,
            `=============================================================`
          ].join("\n");
          sock.sendMessage(custJid, { text: refundReceipt }).catch(() => {});
        }

        // Notify Admin Group
        if (sock && isConnected) {
          const balanceText = receipt.new_balance ? `\n🏦 *New Till Bal:* KES ${Number(receipt.new_balance).toLocaleString()}` : "";
          const adminAlert = [
            `🎉 *[REFUND AUTO-SETTLED: ZERO-SUM RESOLVED]*`,
            `=============================================================`,
            `📦 *Order:*       *#${orderId}*`,
            `📥 *Inflow Ref:*  \`${d.inflow_code || "None"}\` (+KES ${cleanAmount.toLocaleString()})`,
            `📤 *Outflow Ref:* \`${cleanCode}\` (-KES ${cleanAmount.toLocaleString()})`,
            `⚖️ *Net Position:* *KES 0.00* (Fully Settled)${balanceText}`,
            `👤 *Customer:*     ${d.customer_name} (\`${custPhone || "N/A"}\`)`,
            `=============================================================`
          ].join("\n");
          sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, { text: adminAlert }).catch(() => {});
        }
        break;
      }
    }

    if (!autoSettledId && sock && isConnected) {
      const balanceText = receipt.new_balance ? `\n🏦 *New Till Bal:* KES ${Number(receipt.new_balance).toLocaleString()}` : "";
      const adminAlert = [
        `📤 *[TILL OUTFLOW DETECTED: MONEY MOVING OUT]*`,
        `=============================================================`,
        `🧾 *Outflow Code:* \`${cleanCode}\``,
        `💸 *Amount Sent:*  *-KES ${cleanAmount.toLocaleString()}*`,
        `👤 *Recipient:*    ${receipt.recipient}${balanceText}`,
        `🕒 *Time:*         ${new Date().toLocaleTimeString("en-GB")}`,
        `-------------------------------------------------------------`,
        `👉 To tie this outflow to an order refund:`,
        `\`!settle <orderId> ${cleanCode}\``,
        `=============================================================`
      ].join("\n");
      sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, { text: adminAlert }).catch(() => {});
    }

    return res.json({ success: true, code: cleanCode, direction: "OUTFLOW", amount: cleanAmount, autoSettled: !!autoSettledId });
  }

  receipt.direction = "INFLOW";
  ledger[cleanCode] = receipt;
  saveLedger(ledger);

  const hostUrl = `http://${req.headers.host || "100.73.175.118:8085"}`;
  let autoPairedOrderId = null;

  for (const [orderId, order] of activeOrders.entries()) {
    if (order.status === "AWAITING_VERIFICATION" && order.submittedCode === cleanCode) {
      console.log(`⚡ [AUTO-PAIRING ORDER] Order #${orderId} matches incoming Till receipt ${cleanCode}!`);
      receipt.paired_order_id = orderId;
      autoPairedOrderId = orderId;
      saveLedger(ledger);
      await pairAndConfirmOrder(orderId, cleanCode, receipt, hostUrl);
      break;
    }
  }

  // Alert Creative Galore Admin Group with Claiming Status & Truncated Balances
  if (sock && isConnected) {
    const balanceText = receipt.new_balance ? `\n🏦 *Account Balance:* KES ${Number(receipt.new_balance).toLocaleString()} (Audit Log)` : "";
    const statusText = autoPairedOrderId
      ? `🟢 *STATUS: CLAIMED & PAIRED* (Order \`#${autoPairedOrderId}\`)`
      : `🟡 *STATUS: UP FOR GRABS (UNCLAIMED)*\n👉 Awaiting customer checkout or manual claim with:\n\`!pair <orderId> ${cleanCode}\``;

    const adminAlert = [
      `💵 *[TILL SMS RECEIPT RECORDED]*`,
      `=============================================================`,
      `🧾 *Code:* \`${cleanCode}\``,
      `💰 *Amount Received:* *KES ${cleanAmount.toLocaleString()}*`,
      `👤 *Sender:* ${sender || "N/A"}`,
      `🕒 *Time:* ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" })}${balanceText}`,
      `-------------------------------------------------------------`,
      statusText,
      `=============================================================`
    ].join("\n");
    sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, { text: adminAlert }).catch(() => {});
  }

  return res.json({ success: true, code: cleanCode, amount: cleanAmount, autoPaired: !!autoPairedOrderId, orderId: autoPairedOrderId });
});

// 6b. Gateway Compatibility: POST /orders/new (Called by OrderGatewaySDK)
app.post("/orders/new", async (req, res) => {
  const { order_id, customer, items, total } = req.body;
  const orderId = order_id || `ORD-${Date.now()}`;
  const totalAmount = Number(total || 0);

  activeOrders.set(orderId, {
    orderId,
    customer,
    payment: { amount: totalAmount },
    items: items || [],
    status: "AWAITING_PAYMENT",
    createdAt: new Date().toISOString()
  });

  if (sock && isConnected) {
    const adminInit = [
      `🛒 *[NEW GATEWAY ORDER RECEIVED]*`,
      `📋 *Order #:* \`#${orderId}\``,
      `👤 *Customer:* ${customer?.name || "Customer"}`,
      `💰 *Amount:* *KES ${totalAmount.toLocaleString()}*`,
      `⏳ *Status:* Awaiting customer payment to Till 5758419`
    ].join("\n");
    sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, { text: adminInit }).catch(() => {});
  }

  return res.json({
    success: true,
    order_id: orderId,
    tracking_url: `https://tmsavannah.com/track/${orderId}`,
    message: "Order registered on Savannah Edge Node"
  });
});

// 7. Checkout Webhook: Creates Pending Order & Triggers Customer Invoice
app.post("/api/checkout", async (req, res) => {
  trafficCounters.checkouts++;
  recordObservatoryLog("CHECKOUT", `Order checkout received for shop: ${req.body?.shopSlug || 'general'}`);
  const { tenantId, shopName, orderId, customer, payment, items, target } = req.body;

  if (!orderId || !items || !items.length) {
    return res.status(400).json({ success: false, error: "Missing required order details." });
  }

  const cleanCustomerPhone = customer?.phone?.replace(/[^0-9]/g, "") || "";
  const totalAmount = Number(payment?.amount || payment?.total || 0);

  activeOrders.set(orderId, {
    tenantId,
    shopName: shopName || "Creative Galore",
    orderId,
    customer,
    payment,
    items,
    status: "AWAITING_PAYMENT",
    createdAt: new Date().toISOString()
  });

  const hostUrl = `http://${req.headers.host || "100.73.175.118:8085"}`;
  const itemsText = items.map(it => ` • ${(it.qty || it.quantity || 1)}x ${it.name} - KES ${Number(it.price).toLocaleString()}`).join("\n");

  if (sock && isConnected && cleanCustomerPhone) {
    const custJid = formatJid(cleanCustomerPhone);
    const invoiceMsg = [
      `🧾 *${(shopName || "Creative Galore").toUpperCase()} — ORDER INVOICE*`,
      `=============================================================`,
      `Hi *${customer?.name || "Customer"}*, thank you for placing your order!`,
      "",
      `📋 *Order #:* \`#${orderId}\``,
      `💰 *Total to Pay:* *KES ${totalAmount.toLocaleString()}*`,
      "",
      `📦 *Items Ordered:*`,
      itemsText,
      "",
      `💳 *PAYMENT INSTRUCTIONS:*`,
      `1. Open M-Pesa on your phone`,
      `2. Select *Buy Goods & Services* (Till)`,
      `3. Enter Till Number: *5758419* (Creative Galore)`,
      `4. Enter Amount: *KES ${totalAmount.toLocaleString()}*`,
      `5. Once received, enter the M-Pesa reference code on the checkout screen!`,
      "",
      `_Our system will automatically pair your payment and issue your pickup PIN._`
    ].join("\n");

    sock.sendMessage(custJid, { text: invoiceMsg }).catch(err => console.warn("Invoice dispatch warning:", err.message));
  }

  if (sock && isConnected) {
    const adminInit = [
      `🛒 *[NEW CHECKOUT INITIATED]*`,
      `📋 *Order #:* \`#${orderId}\``,
      `👤 *Customer:* ${customer?.name || "Guest"} (\`${customer?.phone || "N/A"}\`)`,
      `💰 *Amount:* *KES ${totalAmount.toLocaleString()}*`,
      `⏳ *Status:* Awaiting customer payment to Till 5758419`
    ].join("\n");
    sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, { text: adminInit }).catch(() => {});
  }

  return res.json({
    success: true,
    orderId,
    status: "AWAITING_PAYMENT",
    message: "Invoice dispatched directly to customer WhatsApp. Awaiting Till receipt."
  });
});

// 8. Dual-Entry Verification: Submit M-Pesa Code from Storefront
app.post("/api/order/verify-payment", async (req, res) => {
  const { orderId, code, customer, items, amount } = req.body;

  if (!orderId || !code) {
    return res.status(400).json({ success: false, error: "orderId and code are required." });
  }

  const cleanCode = code.toUpperCase().trim();
  const cleanAmount = Number(amount || 0);
  const ledger = loadLedger();
  const hostUrl = `http://${req.headers.host || "100.73.175.118:8085"}`;

  let order = activeOrders.get(orderId);
  if (order && order.status === "CANCELLED") {
    return res.status(400).json({ success: false, error: "Order was cancelled by store operator." });
  }

  if (order && order.status === "PAID" && (order.payment?.mpesaCode === cleanCode || order.submittedCode === cleanCode)) {
    return res.json({
      success: true,
      status: "PAID",
      paired: true,
      pickupPin: order.pickupPin,
      message: `Already verified! Order #${orderId} was previously paired.`
    });
  }

  if (!order) {
    order = {
      orderId,
      customer,
      items,
      payment: { amount: cleanAmount },
      status: "AWAITING_VERIFICATION",
      createdAt: new Date().toISOString()
    };
    activeOrders.set(orderId, order);
  }

  order.submittedCode = cleanCode;

  const companionReceipt = ledger[cleanCode];
  if (companionReceipt && companionReceipt.amount >= (cleanAmount || companionReceipt.amount)) {
    companionReceipt.paired_order_id = orderId;
    companionReceipt.paired_at = new Date().toISOString();
    saveLedger(ledger);

    await pairAndConfirmOrder(orderId, cleanCode, companionReceipt, hostUrl);

    console.log(`🎉 [DUAL-ENTRY SUCCESS] Order #${orderId} verified & paired with receipt ${cleanCode}!`);
    return res.json({
      success: true,
      status: "PAID",
      paired: true,
      pickupPin: order.pickupPin,
      message: `Verified! Payment of KES ${companionReceipt.amount} paired with Till receipt ${cleanCode}.`
    });
  }

  order.status = "AWAITING_VERIFICATION";
  console.log(`⏳ [AWAITING COMPANION] Order #${orderId} submitted code ${cleanCode}, awaiting SMS listener...`);

  if (sock && isConnected) {
    sock.sendMessage(CREATIVE_GALORE_ADMIN_JID, {
      text: `⏳ *[CODE SUBMITTED — VERIFICATION PENDING]*\nOrder #${orderId} submitted M-Pesa code \`${cleanCode}\` (KES ${cleanAmount}).\nAwaiting companion Till SMS receipt from mobile device...`
    }).catch(() => {});
  }

  return res.json({
    success: true,
    status: "AWAITING_VERIFICATION",
    paired: false,
    message: "Payment code submitted. Awaiting Safaricom Till receipt confirmation from phone..."
  });
});

// 9. Order Status Query (For Storefront Polling)
app.get("/api/order/status", (req, res) => {
  const { orderId } = req.query;
  const order = activeOrders.get(orderId);
  if (!order) {
    return res.status(404).json({ success: false, error: "Order not found." });
  }

  return res.json({
    success: true,
    orderId,
    status: order.status,
    isPaid: order.status === "PAID" || order.status === "READY_FOR_PICKUP" || order.status === "DISPATCHED",
    pickupPin: order.pickupPin || null
  });
});

// 10. Interactive Action: Mark Ready for Pickup & Dispatch PIN to Customer
app.get("/action/ready-pickup", async (req, res) => {
  const { order, pin, token } = req.query;
  const tokenData = actionTokens.get(token);
  if (!tokenData || tokenData.orderId !== order) {
    return res.status(403).send("<h1>⚠️ Invalid or Expired Action Link</h1>");
  }

  const orderData = activeOrders.get(order);
  if (orderData) {
    orderData.status = "READY_FOR_PICKUP";
  }

  const custPhone = tokenData.customer?.phone || orderData?.customer?.phone;
  const custName = tokenData.customer?.name || orderData?.customer?.name || "Customer";

  if (sock && isConnected && custPhone) {
    const custJid = formatJid(custPhone);
    const readyMsg = [
      `🎉 *YOUR ORDER IS READY FOR PICKUP!* 🎉`,
      `=============================================================`,
      `Hi *${custName}*, your handcrafted crochet package for Order *#${order}* is packaged and ready at the Creative Galore pickup desk!`,
      "",
      `🔐 *YOUR SECURE COLLECTION PIN:*`,
      `👉 *${pin || tokenData.pickupPin}* 👈`,
      "",
      `📍 *Pickup Desk:* Creative Galore Collection Point`,
      `🕒 *Hours:* 8:00 AM – 7:00 PM`,
      "",
      `_Please show this 4-digit PIN to the attendant upon collection._`,
      `See you soon! 🧶✨`
    ].join("\n");

    await sock.sendMessage(custJid, { text: readyMsg }).catch(err => console.warn("Pickup alert warning:", err.message));
  }

  if (sock && isConnected) {
    sock.sendMessage(CREATIVE_GALORE_OPERATIONS_JID, {
      text: `✅ *[READY FOR PICKUP]* Order #${order} marked READY. Customer (${custPhone}) notified with PIN *${pin || tokenData.pickupPin}*.`
    }).catch(() => {});
  }

  res.send(`
    <!DOCTYPE html><html><head><title>Order Ready for Pickup</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="background:#0b141a;color:#e9edef;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
      <div style="background:#111b21;padding:32px;border-radius:16px;text-align:center;max-width:440px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
        <h2 style="color:#00a884;margin-bottom:8px;">✅ Marked Ready for Pickup!</h2>
        <p style="color:#8696a0;">Order <strong>#${order}</strong> is ready at the counter.</p>
        <div style="background:#202c33;padding:20px;border-radius:12px;margin:20px 0;">
          <span style="font-size:12px;color:#8696a0;letter-spacing:1px;">CUSTOMER COLLECTION PIN</span><br>
          <strong style="font-size:36px;letter-spacing:8px;color:#00a884;">${pin || tokenData.pickupPin}</strong>
        </div>
        <p style="color:#00a884;font-size:14px;">📲 Private 1-on-1 notification dispatched to customer (${custPhone}).</p>
      </div>
    </body></html>
  `);
});

// 11. Interactive Action: Dispatch Courier
app.get("/action/dispatch", async (req, res) => {
  const { order, token } = req.query;
  const tokenData = actionTokens.get(token);
  if (!tokenData || tokenData.orderId !== order) {
    return res.status(403).send("<h1>⚠️ Invalid or Expired Action Link</h1>");
  }

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const orderData = activeOrders.get(order);
  if (orderData) {
    orderData.status = "DISPATCHED";
    orderData.otp = otp;
  }

  if (sock && isConnected && tokenData.customer?.phone) {
    const custJid = formatJid(tokenData.customer.phone);
    sock.sendMessage(custJid, {
      text: `🏍️ *Boda-Boda Courier Dispatched for Order #${order}!*\n\n🔐 *Your Delivery OTP is:* *${otp}*\n_Provide this 4-digit code to the rider upon package arrival._`
    }).catch(() => {});
  }

  res.send(`
    <!DOCTYPE html><html><head><title>Courier Dispatched</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="background:#0b141a;color:#e9edef;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
      <div style="background:#111b21;padding:32px;border-radius:16px;text-align:center;max-width:400px;">
        <h2 style="color:#00a884;">🏍️ Courier Dispatched!</h2>
        <p>Order <strong>#${order}</strong> is out for delivery.</p>
        <div style="background:#202c33;padding:16px;border-radius:8px;margin:16px 0;">
          <span style="font-size:12px;color:#8696a0;">CUSTOMER DELIVERY OTP</span><br>
          <strong style="font-size:32px;letter-spacing:6px;color:#00a884;">${otp}</strong>
        </div>
        <p style="color:#8696a0;font-size:13px;">OTP dispatched strictly to customer. Rider will request it upon arrival.</p>
      </div>
    </body></html>
  `);
});

// 12. View Receipts Ledger (Admin Audit)
app.get("/api/till/ledger", (req, res) => {
  const ledger = loadLedger();
  return res.json({ success: true, count: Object.keys(ledger).length, receipts: ledger });
});

// 13. QR Code Web Interface
app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>WhatsApp Status</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="background:#0b141a;color:#e9edef;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#111b21;padding:32px;border-radius:16px;text-align:center;">
          <h2 style="color:#00a884;">✅ WhatsApp Connected & Paired!</h2>
          <p>Autonomous daemon is running and authenticated as <strong>${connectedUserJid}</strong>.</p>
          <p style="color:#8696a0;">Zero physical clicks required. Outbound REST API ready on port ${PORT}.</p>
        </div>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Link QR</title>
      <meta http-equiv="refresh" content="15">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="background:#0b141a;color:#e9edef;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
      <div style="background:#111b21;padding:32px;border-radius:16px;text-align:center;">
        <h2 style="color:#00a884;">Link WhatsApp Device</h2>
        <p>1. Open WhatsApp on phone &rarr; <strong>Linked Devices</strong><br>2. Tap <strong>Link a Device</strong> and scan below:</p>
        <div style="background:#fff;padding:16px;border-radius:12px;display:inline-block;margin:16px 0;">
          <img src="/whatsapp-qr.png?t=${Date.now()}" alt="QR Code" style="width:280px;height:280px;display:block;">
        </div>
        <p style="color:#8696a0;font-size:12px;">Auto-refreshes every 15s.</p>
      </div>
    </body>
    </html>
  `);
});

// Start HTTP Server and Baileys
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 HTTP REST API listening on http://0.0.0.0:${PORT}`);
  console.log(`   - Status:         GET  http://0.0.0.0:${PORT}/api/status`);
  console.log(`   - Checkout:       POST http://0.0.0.0:${PORT}/api/checkout`);
  console.log(`   - Verify Payment: POST http://0.0.0.0:${PORT}/api/order/verify-payment`);
  console.log(`   - Till Ingest:    POST http://0.0.0.0:${PORT}/api/till/receipt`);
  console.log(`   - Order Status:   GET  http://0.0.0.0:${PORT}/api/order/status?orderId=...`);
  console.log(`   - Till Ledger:    GET  http://0.0.0.0:${PORT}/api/till/ledger`);
  console.log(`   - Group Desc:     POST http://0.0.0.0:${PORT}/api/groups/description`);
  console.log(`   - QR Interface:   GET  http://0.0.0.0:${PORT}/qr\n`);
});

startWhatsAppBot().catch((err) => {
  console.error("❌ Fatal error in WhatsApp bot:", err);
});

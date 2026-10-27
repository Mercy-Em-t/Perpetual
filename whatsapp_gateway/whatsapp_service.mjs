/**
 * Baileys WhatsApp Gateway Microservice
 * Modular orchestrator for Two-Way Departmental WhatsApp Communication.
 */
import http from "http";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { HTTP_PORT, AUTH_DIR, GROUPS } from "./config.mjs";
import { KNOWN_COMMANDS, handleInboundCommand } from "./command_handler.mjs";
import { handlePassiveGroupMessage } from "./passive_listener.mjs";
import { createHttpRouter } from "./http_routes.mjs";

console.log(`[WHATSAPP GATEWAY] Using Auth Directory: ${AUTH_DIR}`);

let sock = null;
let botJid = null;
let connectionState = "connecting";

// Rolling cache of message IDs programmatically sent by this gateway bot
const botSentMessageIds = new Set();
function recordBotMessageId(id) {
  if (!id) return;
  botSentMessageIds.add(id);
  if (botSentMessageIds.size > 2000) {
    const oldest = botSentMessageIds.values().next().value;
    botSentMessageIds.delete(oldest);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeSendMessage(jid, content) {
  if (!sock || connectionState !== "open") {
    console.warn(`[WHATSAPP] Cannot send message: socket not open (state: ${connectionState})`);
    return null;
  }
  try {
    const res = await sock.sendMessage(jid, content);
    if (res?.key?.id) {
      recordBotMessageId(res.key.id);
    }
    return res;
  } catch (err) {
    console.error(`[WHATSAPP SEND ERROR] to ${jid}:`, err.message);
    return null;
  }
}

async function safeReactMessage(jid, key, emoji) {
  if (!sock || connectionState !== "open") {
    console.warn(`[WHATSAPP] Cannot send reaction: socket not open (state: ${connectionState})`);
    return null;
  }
  try {
    const res = await sock.sendMessage(jid, {
      react: {
        text: emoji,
        key: key
      }
    });
    if (res?.key?.id) {
      recordBotMessageId(res.key.id);
    }
    return res;
  } catch (err) {
    console.error(`[WHATSAPP REACT ERROR] in ${jid}:`, err.message);
    return null;
  }
}

// Provision or auto-discover all 3 Community Groups & sync descriptions
let groupsInitialized = false;

async function setupTargetGroups() {
  if (groupsInitialized) return;
  try {
    console.log(`[WHATSAPP] Fetching all participating groups...`);
    const allGroups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(allGroups);

    // 1. Discover or create "Perpetua Community"
    let communityJid = null;
    try {
      if (typeof sock.communityFetchAllParticipating === "function") {
        const allCommunities = await sock.communityFetchAllParticipating();
        const commList = Object.values(allCommunities);
        const matchedComm = commList.find(c => c.subject && c.subject.trim().toLowerCase() === "perpetua community");
        if (matchedComm) {
          communityJid = matchedComm.id;
          console.log(`[WHATSAPP] Found existing Community "${matchedComm.subject}" -> JID: ${communityJid}`);
        }
      }
    } catch (commErr) {
      console.warn(`[WHATSAPP] Community note:`, commErr.message);
    }

    // 2. Discover the 3 Departmental Groups
    for (const [key, groupConfig] of Object.entries(GROUPS)) {
      const matched = groupList.find(
        (g) => g.subject && g.subject.trim().toLowerCase() === groupConfig.name.toLowerCase()
      );

      if (matched) {
        groupConfig.jid = matched.id;
        console.log(`[WHATSAPP] Bound group "${matched.subject}" -> JID: ${groupConfig.jid}`);
      }
    }
    groupsInitialized = true;
  } catch (err) {
    console.error(`[WHATSAPP] Error during setupTargetGroups:`, err.message);
  }
}

let reconnectCount = 0;
let reconnectTimer = null;

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) console.log(`[WHATSAPP] QR emitted. Terminal scan required.`);

    if (connection === "close") {
      connectionState = "closed";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WHATSAPP] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        reconnectCount++;
        const delay = statusCode === 440 ? Math.min(30000, 4000 * Math.pow(1.5, Math.min(reconnectCount, 5))) : 5000;
        console.log(`[WHATSAPP] Scheduling reconnect in ${(delay / 1000).toFixed(1)}s (Attempt #${reconnectCount})...`);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(startWhatsAppBot, delay);
      }
    } else if (connection === "open") {
      connectionState = "open";
      reconnectCount = 0;
      botJid = sock.user?.id ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : null;
      console.log(`[WHATSAPP] Connected successfully as: ${botJid}`);
      await setupTargetGroups();
    }
  });

  // Inbound interactive command & message listener (Any Group or Direct Message)
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // Ignore programmatic messages generated by this bot instance
      if (botSentMessageIds.has(msg.key.id)) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      let trimmed = text.trim();
      if (!trimmed) continue;

      // Normalize leading prefix and space: e.g. "! product" -> "!product", "/help" -> "!help"
      let normalized = trimmed.replace(/^([!/])\s+/, "$1");
      if (normalized.startsWith("/")) {
        normalized = "!" + normalized.slice(1);
      }

      const senderId = msg.key.participant || (msg.key.fromMe && botJid ? botJid : msg.key.remoteJid);
      const isDirectMessage = remoteJid.endsWith("@s.whatsapp.net");
      const isGroup = remoteJid.endsWith("@g.us");
      const isMentioned = botJid && msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botJid);
      const firstWord = normalized.split(/\s+/)[0].toLowerCase().replace(/^!/, "");
      const hasPrefix = normalized.startsWith("!");

      let isCommand = false;
      let effectiveCommandText = normalized;

      if (isGroup) {
        // Group Discussion Privacy Rule:
        // In groups, the bot ONLY triggers on explicit '!' commands or direct @mentions.
        // This guarantees staff and managers can hold normal human conversations freely.
        if (hasPrefix) {
          isCommand = true;
        } else if (isMentioned) {
          const botNum = botJid ? botJid.replace(/@.*$/, "") : "";
          const textWithoutTag = trimmed.replace(new RegExp(`@${botNum}`, "g"), "").trim();
          if (textWithoutTag) {
            isCommand = true;
            effectiveCommandText = textWithoutTag.startsWith("!") ? textWithoutTag : "!" + textWithoutTag;
          }
        }
      } else if (isDirectMessage) {
        // In 1-on-1 Customer DMs: accept '!' or natural keywords (help, status, order)
        if (hasPrefix) {
          isCommand = true;
        } else if (KNOWN_COMMANDS.includes(firstWord)) {
          isCommand = true;
          effectiveCommandText = "!" + trimmed;
        }
      }

      if (isCommand) {
        console.log(`[WHATSAPP INBOUND] Command from ${senderId} in ${remoteJid}: "${effectiveCommandText}"`);
        await handleInboundCommand(effectiveCommandText, remoteJid, senderId, safeSendMessage);
      } else {
        // PASSIVE AMBIENT LISTENER:
        // Reads conversational order notes, forwarded M-Pesa receipts, courier handoffs,
        // or product photos. Works for any group member OR primary phone owner messages.
        await handlePassiveGroupMessage(trimmed, remoteJid, senderId, msg, safeReactMessage, safeSendMessage, sock);
      }
    }
  });
}

// Start HTTP IPC Server
const router = createHttpRouter({
  GROUPS,
  getConnectionState: () => connectionState,
  getBotJid: () => botJid,
  safeSendMessage,
  getSock: () => sock
});

const server = http.createServer(router);
server.listen(HTTP_PORT, () => {
  console.log(`[WHATSAPP GATEWAY] Listening on http://127.0.0.1:${HTTP_PORT}`);
  startWhatsAppBot();
});

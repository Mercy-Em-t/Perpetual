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
import { createHttpRouter } from "./http_routes.mjs";

console.log(`[WHATSAPP GATEWAY] Using Auth Directory: ${AUTH_DIR}`);

let sock = null;
let botJid = null;
let connectionState = "connecting";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeSendMessage(jid, content) {
  if (!sock || connectionState !== "open") {
    console.warn(`[WHATSAPP] Cannot send message: socket not open (state: ${connectionState})`);
    return null;
  }
  try {
    return await sock.sendMessage(jid, content);
  } catch (err) {
    console.error(`[WHATSAPP SEND ERROR] to ${jid}:`, err.message);
    return null;
  }
}

// Provision or auto-discover all 3 Community Groups & sync descriptions
async function setupTargetGroups() {
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
        } else if (typeof sock.communityCreate === "function") {
          console.log(`[WHATSAPP] Creating new Community "Perpetua Community"...`);
          await sleep(3000);
          const commRes = await sock.communityCreate("Perpetua Community", "Perpetua Shared Room Community: Floor Operations, Quality Desk, and Executive Oversight.");
          if (commRes) {
            communityJid = commRes.id;
            console.log(`[WHATSAPP] Created Community -> JID: ${communityJid}`);
          }
        }
      }
    } catch (commErr) {
      console.warn(`[WHATSAPP] Community note:`, commErr.message);
    }

    // 2. Discover or provision the 3 Departmental Groups
    for (const [key, groupConfig] of Object.entries(GROUPS)) {
      const matched = groupList.find(
        (g) => g.subject && g.subject.trim().toLowerCase() === groupConfig.name.toLowerCase()
      );

      if (matched) {
        groupConfig.jid = matched.id;
        console.log(`[WHATSAPP] Found existing group "${matched.subject}" -> JID: ${groupConfig.jid}`);
      } else {
        console.log(`[WHATSAPP] Creating group "${groupConfig.name}"...`);
        try {
          await sleep(4000);
          const createRes = await sock.groupCreate(groupConfig.name, [botJid]);
          groupConfig.jid = createRes.id;
          console.log(`[WHATSAPP] Created group "${groupConfig.name}" -> JID: ${groupConfig.jid}`);
          await sleep(1000);
          await safeSendMessage(groupConfig.jid, { text: groupConfig.welcome });
        } catch (createErr) {
          console.warn(`[WHATSAPP] Failed creating "${groupConfig.name}":`, createErr.message);
        }
      }

      // Link group into parent community
      if (communityJid && groupConfig.jid && typeof sock.communityLinkGroup === "function") {
        try {
          await sleep(1500);
          await sock.communityLinkGroup(groupConfig.jid, communityJid);
          console.log(`[WHATSAPP] Linked group "${groupConfig.name}" into Community "${communityJid}"`);
        } catch (linkErr) {
          console.log(`[WHATSAPP] Group link notice for "${groupConfig.name}":`, linkErr.message);
        }
      }

      // Sync Group Description with Command Tutorial
      if (groupConfig.jid && groupConfig.description) {
        try {
          await sleep(1000);
          await sock.groupUpdateDescription(groupConfig.jid, groupConfig.description);
          console.log(`[WHATSAPP] Updated description for "${groupConfig.name}" with command cheat-sheet.`);
        } catch (descErr) {
          console.log(`[WHATSAPP] Note: Description sync for "${groupConfig.name}": ${descErr.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[WHATSAPP] Error during setupTargetGroups:`, err.message);
  }
}

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
        setTimeout(startWhatsAppBot, 3000);
      }
    } else if (connection === "open") {
      connectionState = "open";
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

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      let trimmed = text.trim();
      if (!trimmed) continue;

      const senderId = msg.key.participant || msg.key.remoteJid;
      const isDirectMessage = remoteJid.endsWith("@s.whatsapp.net");
      const isMentioned = botJid && msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botJid);
      const firstWord = trimmed.split(/\s+/)[0].toLowerCase().replace(/^!/, "");
      const isCommand = trimmed.startsWith("!") || KNOWN_COMMANDS.includes(firstWord);

      if (isCommand) {
        if (!trimmed.startsWith("!")) {
          trimmed = "!" + trimmed;
        }
        console.log(`[WHATSAPP INBOUND] Command from ${senderId} in ${remoteJid}: "${trimmed}"`);
        await handleInboundCommand(trimmed, remoteJid, senderId, safeSendMessage);
      } else if (isDirectMessage || isMentioned) {
        // Conversational assistance from any other group or private DM
        console.log(`[WHATSAPP INBOUND] Direct query from ${senderId}: "${trimmed}"`);
        const callerName = senderId ? senderId.replace(/@.*$/, "") : "User";
        const reply =
          `👋 *Hello @${callerName}!*\n` +
          `I am your *Perpetua Shared Agent Room Assistant*.\n\n` +
          `You can message me from any group or private chat to manage and inspect your system:\n` +
          `• *!status* — View real-time room health and vitals\n` +
          `• *!pool* — Inspect active task pipeline\n` +
          `• *!orders* — View live storefront orders\n` +
          `• *!details <id>* — Deep-dive audit into any task or order\n` +
          `• *!help* — View all available commands`;
        await safeSendMessage(remoteJid, { text: reply });
      }
    }
  });
}

// Start HTTP IPC Server
const router = createHttpRouter({
  GROUPS,
  getConnectionState: () => connectionState,
  getBotJid: () => botJid,
  safeSendMessage
});

const server = http.createServer(router);
server.listen(HTTP_PORT, () => {
  console.log(`[WHATSAPP GATEWAY] Listening on http://127.0.0.1:${HTTP_PORT}`);
  startWhatsAppBot();
});

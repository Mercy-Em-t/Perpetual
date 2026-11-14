/**
 * Persistent Support Incident Ticketing & Workflow Store
 * Supports the Perpetua - IT Helpdesk WhatsApp Support Group and HTTP/Sentinel escalations.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const TICKETS_FILE = path.join(DATA_DIR, "support_tickets.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(TICKETS_FILE)) {
    fs.writeFileSync(TICKETS_FILE, JSON.stringify({ tickets: [] }, null, 2), "utf8");
  }
}

function loadTickets() {
  try {
    ensureStore();
    const raw = fs.readFileSync(TICKETS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.tickets) ? parsed.tickets : [];
  } catch (err) {
    console.warn("[SUPPORT TICKETS] Read error:", err.message);
    return [];
  }
}

function saveTickets(tickets) {
  try {
    ensureStore();
    // Keep most recent 500 tickets to avoid unbounded growth
    const trimmed = tickets.slice(-500);
    fs.writeFileSync(TICKETS_FILE, JSON.stringify({ tickets: trimmed }, null, 2), "utf8");
  } catch (err) {
    console.error("[SUPPORT TICKETS] Write error:", err.message);
  }
}

export function createSupportTicket({
  title,
  description,
  source = "WHATSAPP",
  severity = "MEDIUM",
  shopSlug = null,
  orderRef = null,
  reportedBy = "SYSTEM"
}) {
  const tickets = loadTickets();
  const id = `INC-${Date.now().toString().slice(-6)}`;
  const ticket = {
    id,
    title: title || description?.slice(0, 80) || "Platform Support Incident",
    description: description || title || "No description provided.",
    source,
    severity: String(severity).toUpperCase(),
    status: "OPEN",
    shopSlug,
    orderRef,
    reportedBy,
    claimedBy: null,
    resolutionNotes: null,
    createdAt: new Date().toISOString(),
    claimedAt: null,
    resolvedAt: null
  };
  tickets.push(ticket);
  saveTickets(tickets);
  return ticket;
}

export function claimSupportTicket(ticketId, actor = "Support Staff") {
  const tickets = loadTickets();
  const idx = tickets.findIndex((t) => t.id.toUpperCase() === String(ticketId).toUpperCase());
  if (idx === -1) return null;
  tickets[idx].status = "INVESTIGATING";
  tickets[idx].claimedBy = actor;
  tickets[idx].claimedAt = new Date().toISOString();
  saveTickets(tickets);
  return tickets[idx];
}

export function resolveSupportTicket(ticketId, notes = "Resolved by operator", actor = "Support Staff") {
  const tickets = loadTickets();
  const idx = tickets.findIndex((t) => t.id.toUpperCase() === String(ticketId).toUpperCase());
  if (idx === -1) return null;
  tickets[idx].status = "RESOLVED";
  tickets[idx].resolutionNotes = notes || "Resolved by operator";
  tickets[idx].resolvedBy = actor;
  tickets[idx].resolvedAt = new Date().toISOString();
  saveTickets(tickets);
  return tickets[idx];
}

export function listSupportTickets({ status = "ACTIVE" } = {}) {
  const tickets = loadTickets();
  if (status === "ACTIVE") {
    return tickets.filter((t) => t.status === "OPEN" || t.status === "INVESTIGATING");
  }
  if (status === "ALL") {
    return tickets;
  }
  return tickets.filter((t) => t.status === String(status).toUpperCase());
}

export function formatTicketCard(ticket) {
  const sevEmoji =
    ticket.severity === "CRITICAL" ? "🚨" :
    ticket.severity === "HIGH" ? "🔴" :
    ticket.severity === "MEDIUM" ? "🟠" : "🟡";

  return (
    `${sevEmoji} *SUPPORT INCIDENT OPENED*\n` +
    `• *Ticket ID:* \`${ticket.id}\`\n` +
    `• *Severity:* ${ticket.severity} • *Status:* ${ticket.status}\n` +
    `• *Title:* ${ticket.title}\n` +
    (ticket.shopSlug ? `• *Shop:* ${ticket.shopSlug}\n` : "") +
    (ticket.orderRef ? `• *Order Ref:* ${ticket.orderRef}\n` : "") +
    `• *Details:* ${ticket.description}\n` +
    `• *Source:* ${ticket.source} (${ticket.reportedBy})\n` +
    `• *Time:* ${ticket.createdAt}\n\n` +
    `_Workflow Actions:_\n` +
    `• \`!claim ${ticket.id}\` — Take ownership\n` +
    `• \`!resolve ${ticket.id} <notes>\` — Close incident`
  );
}

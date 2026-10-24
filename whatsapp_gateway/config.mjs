/**
 * WhatsApp Gateway Configuration & Group Mapping
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT) : 5174;
export const ROOM_SERVER_HOST = process.env.ROOM_SERVER_HOST || "127.0.0.1";
export const ROOM_SERVER_PORT = process.env.ROOM_SERVER_PORT ? parseInt(process.env.ROOM_SERVER_PORT) : 5050;

// Shared authenticated Baileys credential directory
export const AUTH_DIR =
  process.env.WHATSAPP_AUTH_DIR ||
  "C:\\Users\\user\\Documents\\Quality assurance\\tms-whitelabel-core\\docker-data\\auth";

// The 3 Departmental Groups with Descriptions & Tutorials
export const GROUPS = {
  general: {
    name: "perpetua",
    role: "operations",
    jid: null,
    welcome:
      `🚀 *Perpetua Floor Operations Initialized*\n\n` +
      `Welcome to the operational department!\n` +
      `• Real-time order station handoffs\n` +
      `• Spatial scene & decor rendering\n` +
      `• Google Drive reference alerts\n\n` +
      `_Reply with !help to view operational commands._`,
    description:
      `🏬 Perpetua Floor Operations & Creative Hub\n\n` +
      `Commands:\n` +
      `• !add <item> to <target> (e.g. !add books to shelf)\n` +
      `• !remove <item> from <target>\n` +
      `• !turn on/off light\n` +
      `• !paid <order_id> <ref> (Cashier payment verification)\n` +
      `• !pack <order_id> (Warehouse packaging handoff)\n` +
      `• !verify <order_id> (QA scan verification)\n` +
      `• !dispatch <order_id> <rider> (Order delivery handoff)\n` +
      `• !status | !orders | !help`
  },
  itHelpdesk: {
    name: "Perpetua - IT Helpdesk",
    role: "support",
    jid: null,
    welcome:
      `🚨 *Perpetua IT Helpdesk & Quality Desk Active*\n\n` +
      `Channel dedicated to error catching, lease timeout rollbacks, and incident ticketing.\n` +
      `_Reply with !help to view helpdesk commands._`,
    description:
      `🛡️ Perpetua IT Helpdesk & Customer Quality Desk\n\n` +
      `Commands:\n` +
      `• !ticket <issue description>\n` +
      `• !resolve <ticket_id> [resolution notes]\n` +
      `• !health (Query system status and error counters)\n` +
      `• !help`
  },
  adminOversight: {
    name: "Perpetua - Admin Oversight",
    role: "executive",
    jid: null,
    welcome:
      `📊 *Perpetua Executive Oversight Active*\n\n` +
      `Channel dedicated to hourly P&L pulses, revenue rollups, and task governance.\n` +
      `_Reply with !pool to inspect all active tasks._`,
    description:
      `💼 Perpetua Executive & Management Oversight\n\n` +
      `Commands:\n` +
      `• !summary (Real-time P&L and order rollups)\n` +
      `• !pulse (Trigger instant executive shop pulse)\n` +
      `• !pool (Inspect ASADF task pipeline)\n` +
      `• !assign <task_id> to <agent>\n` +
      `• !status | !help`
  }
};

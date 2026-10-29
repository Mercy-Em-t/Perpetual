/**
 * WhatsApp Gateway Configuration & Multi-Tenant Group Mapping
 * Production Clean Slate - Fully Isolated from Legacy Mocks
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Safely load environment variables from local .env if present
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (e) {
  // .env is optional if environment variables are provided by host/systemd/docker
}

export const SUPABASE_URL = process.env.SUPABASE_URL || "https://ocsuqfabqsyrbsewcaez.supabase.co";
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT) : 5174;

// Shared authenticated Baileys credential directory
export const AUTH_DIR =
  process.env.WHATSAPP_AUTH_DIR ||
  "C:\\Users\\user\\Documents\\Quality assurance\\tms-whitelabel-core\\docker-data\\auth";

// The 3 Platform Departmental Groups
export const GROUPS = {
  general: {
    name: "perpetua",
    role: "operations",
    jid: "120363429929736148@g.us",
    welcome:
      `🏬 *Perpetua Platform Operations Live*\n\n` +
      `Multi-Store Dispatch & Station Routing Center.\n` +
      `• Multi-tenant order station handoffs\n` +
      `• Live delivery dispatch tracking\n` +
      `• Edge gateway health\n\n` +
      `_Reply with *!help* to view available platform operations commands._`,
    description:
      `🏬 Perpetua Platform Operations\n\n` +
      `Commands:\n` +
      `• !status (Operational vitals & queue counts)\n` +
      `• !orders [today | pending | paid] (Inspect platform active orders)\n` +
      `• !help`
  },
  itHelpdesk: {
    name: "Perpetua - IT Helpdesk",
    role: "support",
    jid: "120363432040872305@g.us",
    welcome:
      `🛡️ *Perpetua IT Helpdesk Active*\n\n` +
      `Channel dedicated to edge gateway telemetry, database connection health, and incident ticketing.\n` +
      `_Reply with *!help* to view helpdesk commands._`,
    description:
      `🛡️ Perpetua IT Helpdesk & Support\n\n` +
      `Commands:\n` +
      `• !status / !health (Edge containers & gateway uptime)\n` +
      `• !ticket <issue description> (Log platform incident)\n` +
      `• !resolve <ticket_id> [notes] (Close incident ticket)\n` +
      `• !help`
  },
  community: {
    name: "Perpetua Community",
    role: "community",
    jid: "120363429056719427@g.us",
    welcome: `🌐 *Perpetua Platform Community Active*`,
    description: `🌐 Perpetua Platform Community`
  },
  adminOversight: {
    name: "Perpetua - Admin Oversight",
    role: "executive",
    jid: "120363415291701803@g.us",
    welcome:
      `💼 *Perpetua Executive Oversight Active*\n\n` +
      `Channel dedicated to platform-wide GMV, multi-tenant revenue auditing, and store onboarding.\n` +
      `_Type *!shops* to list all stores or *!summary* for platform rollups._`,
    description:
      `💼 Perpetua Executive & Management Oversight\n\n` +
      `Commands:\n` +
      `• !summary (Platform-wide gross merchandise value & orders)\n` +
      `• !summary <shop_slug> (Drill down into a specific store)\n` +
      `• !shops [query] (Directory of all stores & WhatsApp links)\n` +
      `• !shop bind <slug> [ops | mgmt] (Onboard a new WhatsApp group)\n` +
      `• !status | !help`
  }
};

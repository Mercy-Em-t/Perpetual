import assert from "node:assert/strict";
import test from "node:test";
import { handleInboundCommand } from "./command_handler.mjs";
import { GROUPS } from "./config.mjs";

test("Tenant Provisioning: Help display when invoked with help or empty args in SYSTEM tier", async () => {
  const sent = [];
  const safeSendMessage = async (jid, content) => {
    sent.push({ jid, content });
    return true;
  };

  // Dispatch !tenant help from the platform Admin Oversight group
  await handleInboundCommand("!tenant help", GROUPS.adminOversight.jid, "254710720949@s.whatsapp.net", safeSendMessage);

  assert.ok(sent.length >= 1, "Should send a response");
  const text = sent[0].content.text;
  assert.match(text, /TENANT PROVISIONING USAGE/i);
  assert.match(text, /tier1/i);
  assert.match(text, /tier2/i);
  assert.match(text, /KES 5,000/);
  assert.match(text, /KES 25,000/);
});

test("Tenant Provisioning: Rejects invalid or incomplete arguments", async () => {
  const sent = [];
  const safeSendMessage = async (jid, content) => {
    sent.push({ jid, content });
    return true;
  };

  await handleInboundCommand("!tenant provision not-enough-args", GROUPS.adminOversight.jid, "254710720949@s.whatsapp.net", safeSendMessage);

  assert.ok(sent.length >= 1);
  const text = sent[0].content.text;
  assert.match(text, /Invalid Format/i);
  assert.match(text, /!tenant provision <slug> <tier1\|tier2> <Name> <Phone>/);
});

test("Tenant Provisioning: DM passthrough allows platform admin to invoke provisioning", async () => {
  const sent = [];
  const safeSendMessage = async (jid, content) => {
    sent.push({ jid, content });
    return true;
  };

  // Tryphen's DM JID
  const adminJid = "254710720949@s.whatsapp.net";
  await handleInboundCommand("!tenant help", adminJid, adminJid, safeSendMessage);

  assert.ok(sent.length >= 1, "Platform admin should be allowed in DM");
  assert.match(sent[0].content.text, /TENANT PROVISIONING USAGE/i);
});

test("Tenant Provisioning: DM passthrough blocks non-admin users from provisioning", async () => {
  const sent = [];
  const safeSendMessage = async (jid, content) => {
    sent.push({ jid, content });
    return true;
  };

  // Random customer DM JID
  const customerJid = "254799999999@s.whatsapp.net";
  await handleInboundCommand("!tenant help", customerJid, customerJid, safeSendMessage);

  assert.ok(sent.length >= 1);
  // Non-admin DM user is strictly blocked by Default-Deny, NOT given the tenant provisioning console
  const customerReply = sent.find(s => s.jid === customerJid);
  assert.ok(customerReply, "Customer should receive response");
  assert.doesNotMatch(customerReply.content.text, /TENANT PROVISIONING USAGE/i);
  assert.match(customerReply.content.text, /Access Denied|Permission Denied|not authorized/i);
});

test("Tenant Provisioning: Regex extracts arguments accurately for various quoting styles", () => {
  const regex = /^(?:provision\s+)?(\S+)\s+(tier1|tier2)\s+["']?([^"'+0-9]+?)["']?\s+([+0-9]+)$/i;

  // Case 1: Quoted brand name
  const match1 = 'provision afroboutique tier2 "Afro Boutique" +254712345678'.match(regex);
  assert.ok(match1);
  assert.equal(match1[1], "afroboutique");
  assert.equal(match1[2].toLowerCase(), "tier2");
  assert.equal(match1[3].trim(), "Afro Boutique");
  assert.equal(match1[4].trim(), "+254712345678");

  // Case 2: Unquoted brand name
  const match2 = 'nairobi-craft tier1 Nairobi Craft 0710720949'.match(regex);
  assert.ok(match2);
  assert.equal(match2[1], "nairobi-craft");
  assert.equal(match2[2].toLowerCase(), "tier1");
  assert.equal(match2[3].trim(), "Nairobi Craft");
  assert.equal(match2[4].trim(), "0710720949");
});

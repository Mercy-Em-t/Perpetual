import assert from "node:assert/strict";
import test from "node:test";
import { handleVoucherIssuanceCommand } from "./command_handler.mjs";

test("Voucher Issuance: Rejects unauthorized non-management sender", async () => {
  const messages = [];
  const safeSendMessage = async (jid, content) => {
    messages.push({ jid, content });
    return true;
  };

  await handleVoucherIssuanceCommand("ORD-123", "group@g.us", "254700000000@s.whatsapp.net", "StaffMember", safeSendMessage, { id: "shop-1", name: "Botanica" }, false);

  assert.equal(messages.length, 1);
  assert.match(messages[0].content.text, /Access Restricted/);
});

test("Voucher Issuance: Usage guide when no arguments provided", async () => {
  const messages = [];
  const safeSendMessage = async (jid, content) => {
    messages.push({ jid, content });
    return true;
  };

  await handleVoucherIssuanceCommand("", "group@g.us", "254710720949@s.whatsapp.net", "Manager", safeSendMessage, { id: "shop-1", name: "Botanica" }, true);

  assert.equal(messages.length, 1);
  assert.match(messages[0].content.text, /Replacement Voucher Issuance/);
  assert.match(messages[0].content.text, /!voucher <order_id>/);
});

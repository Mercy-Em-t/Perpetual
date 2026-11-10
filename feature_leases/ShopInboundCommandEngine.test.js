import { describe, it, expect } from 'vitest';
import {
  verifyInboundShopMessageSafety,
  parseShopInboundCommand,
  processShopInboundInput
} from './ShopInboundCommandEngine.js';
import { defaultMessageTracker } from './WhatsAppMessageTracker.js';
import { OrderClusteringEngine } from './OrderClusteringEngine.js';

describe('ShopInboundCommandEngine — Bidirectional Shop Operator Input & Anti-Echo Guard', () => {
  it('blocks bot echo messages via Outbox Ledger and Bot Signature Headers', () => {
    defaultMessageTracker.recordSentMessage({
      id: 'bot_outbound_msg_777',
      recipient: '120363412609340679@g.us',
      text: 'PACKED BAG-01'
    });

    // Layer 1: Outbox ID match is rejected immediately
    const ledgerCheck = verifyInboundShopMessageSafety({
      messageId: 'bot_outbound_msg_777',
      text: 'PACKED BAG-01'
    });
    expect(ledgerCheck.safe).toBe(false);
    expect(ledgerCheck.reason).toBe('OUTBOX_LEDGER_BOT_ECHO');

    // Layer 2: Bot signature header is rejected even with unknown messageId
    const headerCheck = verifyInboundShopMessageSafety({
      messageId: 'unknown_id',
      text: '🛍️ *NEW ORDER RECEIVED!*\n🏪 *Leah\'s Kitchen*'
    });
    expect(headerCheck.safe).toBe(false);
    expect(headerCheck.reason).toBe('BOT_SIGNATURE_HEADER');

    // Verified human input passes
    const humanCheck = verifyInboundShopMessageSafety({
      messageId: 'human_shop_msg_001',
      text: 'PACKED BAG-01'
    });
    expect(humanCheck.safe).toBe(true);
  });

  it('parses all shop operator commands and ignores normal conversation', () => {
    expect(parseShopInboundCommand('Hello everyone in the group!')).toBeNull();

    const packCmd = parseShopInboundCommand('PACKED BAG-01, BAG-03');
    expect(packCmd.commandType).toBe('SET_BAG_PACKED_STATE');
    expect(packCmd.packed).toBe(true);
    expect(packCmd.bagLabels).toEqual(['BAG-01', 'BAG-03']);

    const soldOutCmd = parseShopInboundCommand('SOLD OUT Cardamom & Coconut Mandazi');
    expect(soldOutCmd.commandType).toBe('TOGGLE_DISH_AVAILABILITY');
    expect(soldOutCmd.isActive).toBe(false);
    expect(soldOutCmd.dishQuery).toBe('Cardamom & Coconut Mandazi');

    const stockCmd = parseShopInboundCommand('STOCK Swahili Coconut Chicken Stew 15');
    expect(stockCmd.commandType).toBe('UPDATE_DISH_STOCK_CAP');
    expect(stockCmd.dishQuery).toBe('Swahili Coconut Chicken Stew');
    expect(stockCmd.dailyCap).toBe(15);

    const prepCmd = parseShopInboundCommand('!PREP');
    expect(prepCmd.commandType).toBe('FLUSH_PREP_DIGEST');

    const graceCmd = parseShopInboundCommand('GRACE 20m');
    expect(graceCmd.commandType).toBe('UPDATE_GRACE_WINDOW');
    expect(graceCmd.graceMinutes).toBe(20);
  });

  it('executes PACKED BAG-01, SOLD OUT, and PREP commands and emits mobile-formatted ACK receipts', async () => {
    const packedBagsSet = new Set();
    const clusterEngine = new OrderClusteringEngine({
      shopName: "Leah's Kitchen",
      clusterThreshold: 5
    });

    clusterEngine.addOrder({
      orderId: 'LK-901',
      clientName: 'Kevin O.',
      clientPhone: '0710000001',
      deliveryAddress: 'Gate A (Security Desk)',
      totalAmount: 1700,
      items: [{ name: 'Swahili Coconut Chicken Stew', quantity: 2, price: 850 }]
    });

    // 1. Shop marks BAG-01 & BAG-02 as packed
    const packResult = await processShopInboundInput({
      text: 'PACKED BAG-01, BAG-02',
      messageId: 'shop_op_1',
      context: { packedBagsSet, clusteringEngine: clusterEngine }
    });
    expect(packResult.handled).toBe(true);
    expect(packedBagsSet.has('BAG-01')).toBe(true);
    expect(packedBagsSet.has('BAG-02')).toBe(true);
    expect(packResult.replyText).toContain('BAG-01, BAG-02');
    expect(packResult.replyText).toContain('PACKED ✅');

    // 2. Shop marks a dish Sold Out
    const soldOutResult = await processShopInboundInput({
      text: 'SOLD OUT Swahili Coconut Chicken Stew',
      messageId: 'shop_op_2',
      context: { packedBagsSet, clusteringEngine: clusterEngine }
    });
    expect(soldOutResult.handled).toBe(true);
    expect(soldOutResult.replyText).toContain('SOLD OUT 🔴');

    // 3. Shop triggers manual PREP flush
    const prepResult = await processShopInboundInput({
      text: 'PREP',
      messageId: 'shop_op_3',
      context: { packedBagsSet, clusteringEngine: clusterEngine }
    });
    expect(prepResult.handled).toBe(true);
    expect(prepResult.replyText).toContain('STAGE 1 — KITCHEN PREP TOTALS');
    expect(prepResult.replyText).toContain('BAG-01');
  });
});

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  HeroStoryChunk,
  PillarsChunk,
  SensoryTastingChunk,
  CollaborationChunk,
  FooterLinkChunk,
  ActionPillChunk
} from './chunks/index.js';
import LeaseGrammarCanvas from './LeaseGrammarCanvas.jsx';
import { getMsUntilNextMidnightRun, reconcileFeatureLeases } from '../../../scripts/reconcile-feature-leases.mjs';

describe('Leased Feature Chunks (Ripped Components Invariant & SSR Audit)', () => {
  it('HeroStoryChunk renders cleanly with defaults and custom props', () => {
    const defaultHtml = renderToString(React.createElement(HeroStoryChunk));
    expect(defaultHtml).toContain('The Artisan Journey');
    expect(defaultHtml).toContain('Handmade with Intent.');

    const customHtml = renderToString(
      React.createElement(HeroStoryChunk, {
        badge: '🥖 Artisan Bakes',
        headlinePrefix: 'Fresh Out Of The Oven.',
        headlineGradient: 'Brunchbox Daily Specials.',
        bio: 'Gourmet bakery items delivered daily across Nairobi.',
        theme: { primary: '#F59E0B', secondary: '#B45309' }
      })
    );
    expect(customHtml).toContain('Artisan Bakes');
    expect(customHtml).toContain('Fresh Out Of The Oven.');
    expect(customHtml).toContain('Brunchbox Daily Specials.');
    expect(customHtml).toContain('Gourmet bakery items');
  });

  it('PillarsChunk renders custom spectrum pillars cleanly', () => {
    const customPillars = [
      { emoji: '🥐', title: 'Flaky Croissants', desc: 'Baked at dawn', badge: 'Same-day boda' },
      { emoji: '☕', title: 'Single-Origin Coffee', desc: 'Hand-picked beans', badge: 'Fresh roast' }
    ];
    const html = renderToString(
      React.createElement(PillarsChunk, {
        spectrumTitle: 'Taste The Kitchen',
        pillars: customPillars
      })
    );
    expect(html).toContain('Taste The Kitchen');
    expect(html).toContain('Flaky Croissants');
    expect(html).toContain('Single-Origin Coffee');
  });

  it('SensoryTastingChunk renders tasting kit and palette samples cleanly', () => {
    const html = renderToString(
      React.createElement(SensoryTastingChunk, {
        protocolTitle: '☕ Roast Tasting',
        heading: 'Single Origin Flight',
        samples: [
          { name: 'Nyeri AA', desc: 'Bright citrus & blackcurrant' },
          { name: 'Kirinyaga Peaberry', desc: 'Floral jasmine aroma' }
        ],
        price: 'KES 500',
        itemName: 'Coffee Cupping Box'
      })
    );

    expect(html).toContain('Roast Tasting');
    expect(html).toContain('Single Origin Flight');
    expect(html).toContain('Nyeri AA');
    expect(html).toContain('KES 500');
    expect(html).toContain('Coffee Cupping Box');
  });

  it('CollaborationChunk renders WhatsApp commission bridge safely', () => {
    const html = renderToString(
      React.createElement(CollaborationChunk, {
        promptTitle: 'Custom Fabric Dyeing',
        promptText: 'Inquire about bulk orders for weddings and events.',
        phone: '254712345678',
        shopName: 'Digital Nairobi Haberdashery'
      })
    );

    expect(html).toContain('Custom Fabric Dyeing');
    expect(html).toContain('https://wa.me/254712345678');
    expect(html).toContain(encodeURIComponent('Digital Nairobi Haberdashery'));
  });

  it('FooterLinkChunk renders clean link without core tenant leaks', () => {
    const html = renderToString(
      React.createElement(FooterLinkChunk, {
        label: '📖 Leased Story & Guide',
        color: '#10B981',
        href: '/s/haberdashery/story'
      })
    );

    expect(html).toContain('Leased Story &amp; Guide');
    expect(html).toContain('/s/haberdashery/story');
  });

  it('ActionPillChunk renders interactive leased pill button', () => {
    const html = renderToString(
      React.createElement(ActionPillChunk, {
        label: '✨ Explore Sensory Guide'
      })
    );

    expect(html).toContain('Explore Sensory Guide');
  });
});

describe('Noun-Verb-Chunk Grammar Engine (LeaseGrammarCanvas)', () => {
  it('renders canvas with DEFAULT DENY ACCESS security gate active by default', () => {
    const html = renderToString(React.createElement(LeaseGrammarCanvas));
    expect(html).toContain('The Leased Story Canvas &amp; Grammar Engine');
    expect(html).toContain('Subject (Tenant Noun)');
    expect(html).toContain('Verb (Lease Agreement)');
    expect(html).toContain('Object (Ripped Chunk Plug)');
    expect(html).toContain('DEFAULT: DENY ACCESS');
    expect(html).toContain('Access Denied (Quarantine Gate)');
    expect(html).toContain('403 Blocked / Quarantined');
  });
});

describe('Midnight Lease Reconciler Script (scripts/reconcile-feature-leases.mjs)', () => {
  it('getMsUntilNextMidnightRun returns a valid millisecond duration under 24 hours', () => {
    const ms = getMsUntilNextMidnightRun();
    expect(typeof ms).toBe('number');
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('reconcileFeatureLeases audits registered on-disk tenants without crashing', async () => {
    const res = await reconcileFeatureLeases(new Date());
    expect(res).toBeDefined();
    expect(res.evaluatedShops).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.leasesRevoked)).toBe(true);
    expect(Array.isArray(res.errors)).toBe(true);
  });
});

describe('Exploded Reporter Interface & Tabulated Bridge (LeaseReporterInterface)', () => {
  it('renders Exploded Reporter Interface via SSR cleanly without errors', async () => {
    const { default: LeaseReporterInterface } = await import('./LeaseReporterInterface.jsx');
    const html = renderToString(React.createElement(LeaseReporterInterface));
    expect(html).toContain('Exploded Message Interface');
    expect(html).toContain('TMS Leased Feature Broadcaster &amp; Reporter Console');
    expect(html).toContain('Reporter Dispatcher Deck');
    expect(html).toContain('Tabulated Live Broadcast Stream');
  });

  it('tabulateLeaseMessage formats message objects into structured tabular rows', async () => {
    const { tabulateLeaseMessage } = await import('./LeaseBroadcastBridge.js');
    const sample = {
      id: 'test_123',
      reporter: 'Midnight Sweep Worker (00:01:00)',
      type: 'MIDNIGHT_SWEEP_SIMULATION',
      tenantId: 'creative-galore',
      tenantName: 'Creative Galore',
      chunkId: 'sensory_tasting',
      chunkName: 'Sensory Tasting Protocol Chunk',
      status: 'EXPIRED',
      summary: 'Sweep completed.'
    };
    const row = tabulateLeaseMessage(sample);
    expect(row['Message ID']).toBe('test_123');
    expect(row['Reporter / Sender']).toBe('Midnight Sweep Worker (00:01:00)');
    expect(row['Action / Type']).toBe('MIDNIGHT_SWEEP_SIMULATION');
    expect(row['Tenant (Noun)']).toBe('Creative Galore (creative-galore)');
    expect(row['Target Chunk (Object)']).toBe('Sensory Tasting Protocol Chunk');
    expect(row['Lease Status']).toBe('EXPIRED');
  });

  it('Technical Writer can dispatch live broadcasts across channel', async () => {
    const { broadcastWriterMessage } = await import('../../../scripts/archive/writer-broadcast-live.mjs');
    const payload = broadcastWriterMessage('Test broadcast from test suite');
    expect(payload.reporter).toBe('Lead Technical Writer & Documentarian');
    expect(payload.type).toBe('TECHNICAL_CHRONICLE_PUBLISHED');
    expect(payload.status).toBe('ACTIVE');
    expect(payload.metadata.documents.length).toBe(4);
  });
});

describe('Second-by-Second Time Inspector & Packet Reassembly Engine (TimeInspectorEngine)', () => {
  it('generateTimeCard and parseTimeCard format and extract "hh.mm.ss dd.mm.year" accurately', async () => {
    const { generateTimeCard, parseTimeCard, formatTimeComponents } = await import('./TimeInspectorEngine.js');
    const testDate = new Date(2026, 9, 22, 20, 15, 30); // 2026-10-22 20:15:30
    const formatted = formatTimeComponents(testDate);
    expect(formatted).toBe('20.15.30 22.10.2026');

    const card = generateTimeCard(testDate);
    expect(card.tag).toBe('TIME_CARD');
    expect(card.greeting).toBe('Hey!');
    expect(card.rawText).toBe('Hey, the time is 20.15.30 22.10.2026');

    const parsed = parseTimeCard(card);
    expect(parsed.valid).toBe(true);
    expect(parsed.tag).toBe('TIME_CARD');
    expect(parsed.timeString).toBe('20:15:30');
    expect(parsed.dateString).toBe('22/10/2026');
    expect(parsed.hours).toBe(20);
    expect(parsed.minutes).toBe(15);
    expect(parsed.seconds).toBe(30);
    expect(parsed.day).toBe(22);
    expect(parsed.month).toBe(10);
    expect(parsed.year).toBe(2026);
  });

  it('verifyTimeSync detects clock sync within tolerance and calculates drift', async () => {
    const { verifyTimeSync } = await import('./TimeInspectorEngine.js');
    const now = new Date();
    const inSync = verifyTimeSync(now, now, 1000);
    expect(inSync.isSynchronized).toBe(true);
    expect(inSync.driftMs).toBe(0);
    expect(inSync.verdict).toBe('CLOCK_IN_SYNC');

    const oldDate = new Date(now.getTime() - 10000); // 10s drift
    const outOfSync = verifyTimeSync(oldDate, now, 1000);
    expect(outOfSync.isSynchronized).toBe(false);
    expect(outOfSync.driftMs).toBe(10000);
    expect(outOfSync.verdict).toBe('CLOCK_DRIFT_EXCEEDED');
  });

  it('verifyPacketIntegrity certifies full arrival and zero moving packets', async () => {
    const { verifyPacketIntegrity } = await import('./TimeInspectorEngine.js');
    const validBatch = verifyPacketIntegrity();
    expect(validBatch.packetsArrivedInFull).toBe(true);
    expect(validBatch.noPacketsMoving).toBe(true);
    expect(validBatch.packetsCameAllOfThem).toBe(true);
    expect(validBatch.movingPackets).toBe(0);
    expect(validBatch.droppedPackets).toBe(0);
    expect(validBatch.integrityRatio).toBe('100%');

    // Test with in-flight packet
    const inFlightBatch = verifyPacketIntegrity({ movingPackets: 2 });
    expect(inFlightBatch.noPacketsMoving).toBe(false);
    expect(inFlightBatch.packetsCameAllOfThem).toBe(false);
  });

  it('reassembleWorker transitions to HEALTHY_AND_EXECUTABLE with go-ahead', async () => {
    const { verifyPacketIntegrity, reassembleWorker } = await import('./TimeInspectorEngine.js');
    const packetCheck = verifyPacketIntegrity();
    const reassembly = reassembleWorker(packetCheck);
    expect(reassembly.state).toBe('HEALTHY_AND_EXECUTABLE');
    expect(reassembly.goAhead).toBe(true);
    expect(reassembly.verdict).toContain('GO_AHEAD');
  });

  it('unpackWorkerTools unlocks complete 5-tool diagnostic suite', async () => {
    const { unpackWorkerTools } = await import('./TimeInspectorEngine.js');
    const tools = unpackWorkerTools();
    expect(tools.status).toBe('TOOLS_UNPACKED');
    expect(tools.toolsCount).toBe(5);
    expect(tools.tools.map(t => t.id)).toContain('tool-lease-chronometer');
    expect(tools.tools.map(t => t.id)).toContain('tool-packet-reassembler');
    expect(tools.tools.map(t => t.id)).toContain('tool-gdrive-live-streamer');
  });

  it('mountGoogleDriveLiveRoom creates 5-minute live corridor buffer', async () => {
    const { mountGoogleDriveLiveRoom } = await import('./TimeInspectorEngine.js');
    const room = mountGoogleDriveLiveRoom(300);
    expect(room.roomName).toContain('Google Drive Live Files Room');
    expect(room.leaseDurationSeconds).toBe(300);
    expect(room.filesCount).toBe(5);
    expect(room.status).toBe('LIVE_ROOM_MOUNTED_5_MINUTES');
    expect(room.liveFiles.some(f => f.name.includes('.gdoc'))).toBe(true);
  });

  it('executeInspectorTick executes an end-to-end 1s simulation tick cleanly', async () => {
    const { executeInspectorTick } = await import('./TimeInspectorEngine.js');
    const tick = executeInspectorTick(1, 180);
    expect(tick.tickNumber).toBe(1);
    expect(tick.totalSimulationTicks).toBe(180);
    expect(tick.card.greeting).toBe('Hey!');
    expect(tick.card.tag).toBe('TIME_CARD');
    expect(tick.timeSync.isSynchronized).toBe(true);
    expect(tick.packetCheck.packetsCameAllOfThem).toBe(true);
    expect(tick.reassembly.state).toBe('HEALTHY_AND_EXECUTABLE');
    expect(tick.tools.toolsCount).toBe(5);
    expect(tick.driveRoom.filesCount).toBe(5);
    expect(tick.payload.reporter).toContain('Time Inspector Worker');
    expect(tick.payload.type).toBe('TIME_CARD_TICK');
  });

  it('Handshake: creates, acknowledges, and measures RTT accurately', async () => {
    const { createHandshake, acknowledgeHandshake, evaluateHandshake } = await import('./TimeInspectorEngine.js');
    const hs = createHandshake('TEST_PEER', 1000);
    expect(hs.peerId).toBe('TEST_PEER');
    expect(hs.status).toBe('SYN_SENT');

    const acked = acknowledgeHandshake(hs, 1025);
    expect(acked.status).toBe('ACKNOWLEDGED');
    expect(acked.rttMs).toBe(25);

    const evalReport = evaluateHandshake(acked, 1050);
    expect(evalReport.status).toBe('ACKNOWLEDGED');
    expect(evalReport.shouldReportTimeout).toBe(false);
    expect(evalReport.verdict).toBe('HANDSHAKE_ESTABLISHED');
  });

  it('Handshake: does NOT report during grace period ("not always report")', async () => {
    const { createHandshake, evaluateHandshake } = await import('./TimeInspectorEngine.js');
    const start = 10000;
    const hs = createHandshake('TEST_PEER', start);
    
    // Check at 2000ms elapsed (threshold is 5000ms)
    const report = evaluateHandshake(hs, start + 2000, { timeoutThresholdMs: 5000 });
    expect(report.status).toBe('WAITING_WITHIN_GRACE');
    expect(report.shouldReportTimeout).toBe(false);
    expect(report.waitedMs).toBe(2000);
    expect(report.verdict).toBe('WAITING_FOR_HANDSHAKE_WITHIN_GRACE');
  });

  it('Handshake: reports timeout when waiting for too long ("when you have been waiting for too long")', async () => {
    const { createHandshake, evaluateHandshake, executeInspectorTick } = await import('./TimeInspectorEngine.js');
    const start = 10000;
    const hs = createHandshake('TEST_PEER', start);

    // Check at 6000ms elapsed (exceeds 5000ms threshold)
    const report = evaluateHandshake(hs, start + 6000, { timeoutThresholdMs: 5000 });
    expect(report.status).toBe('TIMEOUT_EXCEEDED');
    expect(report.shouldReportTimeout).toBe(true);
    expect(report.waitedMs).toBe(6000);
    expect(report.verdict).toBe('HANDSHAKE_TIMEOUT_EXCEEDED');
    expect(report.incidentDetails).toBeDefined();

    // End-to-end tick with timeout mode triggers HANDSHAKE_TIMEOUT_REPORTED payload
    const timeoutTick = executeInspectorTick(1, 180, { handshakeMode: 'TIMEOUT' });
    expect(timeoutTick.handshake.shouldReportTimeout).toBe(true);
    expect(timeoutTick.payload.type).toBe('HANDSHAKE_TIMEOUT_REPORTED');
    expect(timeoutTick.payload.status).toBe('EXPIRED');
  });
});

describe('WhatsApp Channel Bridge & Message Dispatcher (WhatsAppChannelBridge)', () => {
  it('formats diagnostic messages with WhatsApp markdown styling and emojis', async () => {
    const { formatMessageForWhatsApp } = await import('./WhatsAppChannelBridge.js');
    const msg = {
      reporter: 'Second-by-Second Time Inspector Worker (1s)',
      type: 'TIME_CARD_TICK',
      status: 'ACTIVE',
      summary: 'Card read and verified.',
      timestamp: '2026-10-22T17:30:00.000Z'
    };
    const formatted = formatMessageForWhatsApp(msg);
    expect(formatted).toContain('*[TMS LEASED FEATURE BROADCAST]*');
    expect(formatted).toContain('*Reporter:* Second-by-Second Time Inspector Worker (1s)');
    expect(formatted).toContain('`TIME_CARD_TICK`');
    expect(formatted).toContain('*Status:* *ACTIVE*');
    expect(formatted).toContain('Card read and verified.');
  });

  it('generates direct wa.me link with clean phone and encoded text', async () => {
    const { generateWhatsAppShareUrl } = await import('./WhatsAppChannelBridge.js');
    const url = generateWhatsAppShareUrl('Hello WhatsApp Channel', '+254 (712) 345-678');
    expect(url).toContain('https://wa.me/254712345678?text=Hello%20WhatsApp%20Channel');
  });

  it('generates universal api.whatsapp.com share link when phone is omitted', async () => {
    const { generateWhatsAppShareUrl } = await import('./WhatsAppChannelBridge.js');
    const url = generateWhatsAppShareUrl('Broadcast to Channel');
    expect(url).toContain('https://api.whatsapp.com/send?text=Broadcast%20to%20Channel');
  });

  it('generates public WhatsApp Channel link from channel ID', async () => {
    const { generateWhatsAppChannelUrl } = await import('./WhatsAppChannelBridge.js');
    const url = generateWhatsAppChannelUrl('0029VaABCD123456');
    expect(url).toBe('https://whatsapp.com/channel/0029VaABCD123456');
  });

  it('dispatchToWhatsAppChannel returns successful client payload in client mode', async () => {
    const { dispatchToWhatsAppChannel } = await import('./WhatsAppChannelBridge.js');
    const msg = {
      reporter: 'Emergency Unplug Supervisor',
      type: 'EMERGENCY_UNPLUG',
      status: 'REVOKED',
      summary: 'Quarantine sweep executed.'
    };
    const res = await dispatchToWhatsAppChannel(msg);
    expect(res.success).toBe(true);
    expect(res.transport).toBe('DEEP_LINK_CLIENT');
    expect(res.shareUrl).toContain('api.whatsapp.com/send');
    expect(res.formattedText).toContain('EMERGENCY_UNPLUG');
  });

  it('formats ORDER_PLACED messages as structured kitchen tickets', async () => {
    const { formatMessageForWhatsApp } = await import('./WhatsAppChannelBridge.js');
    const orderMsg = {
      reporter: 'Storefront Checkout Gateway',
      type: 'ORDER_PLACED',
      tenantId: 'leahs-kitchen',
      tenantName: "Leah's Kitchen",
      status: 'CONFIRMED',
      metadata: {
        orderId: 'LK-9901',
        customer: { name: 'Juma Ali', phone: '+254712345678' },
        tableNumber: 'Table 5',
        fulfillmentType: 'dine_in',
        items: [
          { name: 'Biryani Special', quantity: 2, price: 700 }
        ],
        totalAmount: 1400
      }
    };
    const formatted = formatMessageForWhatsApp(orderMsg);
    expect(formatted).toContain("NEW ORDER RECEIVED!");
    expect(formatted).toContain("Leah's Kitchen");
    expect(formatted).toContain("#LK-9901");
    expect(formatted).toContain("2x Biryani Special — KES 1,400");
    expect(formatted).toContain("KES 1,400");
    expect(formatted).toContain("Table: Table 5");
  });
});

describe('WhatsApp Message Tracker & Localized Outbox Ledger', () => {
  it('records outbound messages and identifies them via isBotMessage', async () => {
    const { WhatsAppMessageTracker } = await import('./WhatsAppMessageTracker.js');
    const tracker = new WhatsAppMessageTracker({ storageFile: null });

    const entry = tracker.recordSentMessage({
      id: 'msg_test_101',
      recipient: '254700000001@s.whatsapp.net',
      text: '🤖 Test reply from bot',
      eventType: 'INBOUND_COMMAND_REPLY',
    });

    expect(entry.id).toBe('msg_test_101');
    expect(tracker.isBotMessage('msg_test_101')).toBe(true);
    expect(tracker.isBotMessage('msg_unknown_999')).toBe(false);
    expect(tracker.getCount()).toBe(1);
  });

  it('enforces recipient cooldown rate-limiting', async () => {
    const { WhatsAppMessageTracker } = await import('./WhatsAppMessageTracker.js');
    const tracker = new WhatsAppMessageTracker({ cooldownMs: 2000, storageFile: null });

    // Initial check: allowed
    const initialCheck = tracker.canSend('254700000001@s.whatsapp.net');
    expect(initialCheck.allowed).toBe(true);

    // Record send
    tracker.recordSentMessage({
      id: 'msg_rate_1',
      recipient: '254700000001@s.whatsapp.net',
      text: 'First message',
    });

    // Immediate check: blocked by cooldown
    const immediateCheck = tracker.canSend('254700000001@s.whatsapp.net');
    expect(immediateCheck.allowed).toBe(false);
    expect(immediateCheck.remainingMs).toBeGreaterThan(0);

    // Different recipient: allowed
    const otherCheck = tracker.canSend('other_recipient@s.whatsapp.net');
    expect(otherCheck.allowed).toBe(true);
  });

  it('caps buffer to maxLedgerSize and evicts oldest IDs', async () => {
    const { WhatsAppMessageTracker } = await import('./WhatsAppMessageTracker.js');
    const tracker = new WhatsAppMessageTracker({ maxLedgerSize: 3, storageFile: null });

    tracker.recordSentMessage({ id: 'msg_1', recipient: 'user_1', text: '1' });
    tracker.recordSentMessage({ id: 'msg_2', recipient: 'user_2', text: '2' });
    tracker.recordSentMessage({ id: 'msg_3', recipient: 'user_3', text: '3' });
    expect(tracker.getCount()).toBe(3);
    expect(tracker.isBotMessage('msg_1')).toBe(true);

    // 4th message should evict msg_1
    tracker.recordSentMessage({ id: 'msg_4', recipient: 'user_4', text: '4' });
    expect(tracker.getCount()).toBe(3);
    expect(tracker.isBotMessage('msg_1')).toBe(false);
    expect(tracker.isBotMessage('msg_4')).toBe(true);
  });

  it('produces structured tabulated telemetry', async () => {
    const { WhatsAppMessageTracker } = await import('./WhatsAppMessageTracker.js');
    const tracker = new WhatsAppMessageTracker({ storageFile: null });

    tracker.recordSentMessage({
      id: 'tab_msg_1',
      recipient: '254700000001@s.whatsapp.net',
      text: 'Long kitchen order text snippet exceeding limit',
      eventType: 'ORDER_PLACED',
    });

    const table = tracker.tabulate(5);
    expect(table).toHaveLength(1);
    expect(table[0]['Message ID']).toBe('tab_msg_1');
    expect(table[0]['Recipient']).toBe('254700000001@s.whatsapp.net');
    expect(table[0]['Event Type']).toBe('ORDER_PLACED');
    expect(table[0]['Snippet']).toContain('Long kitchen order');
  });
});

describe('Order Clustering & Executive Prep Summary Engine', () => {
  it('aggregates quantities and generates clean WhatsApp prep table', async () => {
    const { OrderClusteringEngine, formatClusteredPrepDigest } = await import('./OrderClusteringEngine.js');
    const engine = new OrderClusteringEngine({ shopName: "Leah's Kitchen", clusterThreshold: 2 });

    const order1 = {
      orderId: 'LK-1001',
      customer: { name: 'Kevin O.', phone: '0710000001' },
      deliveryAddress: 'Gate A',
      totalAmount: 1700,
      items: [
        { name: 'Swahili Coconut Chicken Stew', quantity: 2, price: 850 }
      ]
    };

    const order2 = {
      orderId: 'LK-1002',
      customer: { name: 'Sarah M.', phone: '0710000002' },
      deliveryAddress: 'Gate B',
      totalAmount: 1050,
      items: [
        { name: 'Swahili Coconut Chicken Stew', quantity: 1, price: 850 },
        { name: 'Fresh Passion Juice', quantity: 1, price: 200 }
      ]
    };

    engine.addOrder(order1);
    expect(engine.isClusterReady()).toBe(false);

    engine.addOrder(order2);
    expect(engine.isClusterReady()).toBe(true);

    const summary = engine.flush();
    expect(summary.orderCount).toBe(2);
    expect(summary.digestText).toContain("EXECUTIVE KITCHEN PREP DIGEST");
    expect(summary.digestText).toContain("Swahili Coconut Chicken Stew");
    expect(summary.digestText).toContain("Fresh Passion Juice");
    expect(summary.digestText).toContain("Kevin O.");
    expect(summary.digestText).toContain("Sarah M.");
    expect(summary.digestText).toContain("TOTAL BATCH REVENUE");
    expect(summary.digestText).toContain("KES 2,750");

    // Engine should be empty after flush
    expect(engine.getOrders()).toHaveLength(0);
  });
});



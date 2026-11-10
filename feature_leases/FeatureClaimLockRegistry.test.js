import { describe, it, expect } from 'vitest';
import {
  FeatureClaimLockRegistry,
  DEFAULT_CANDIDATE_POOL
} from './FeatureClaimLockRegistry.js';
import { JitCadenceNotificationWorker } from '../../tenants/leahs-kitchen/modules/JitCadenceNotificationWorker.js';

describe('FeatureClaimLockRegistry — Lock-Triggered Pipelined Parallel Agent Execution', () => {
  it('allows Agent 2, 3, and 4 to choose immediately after Agent 1 acquires its lock without waiting for Agent 1 build to finish', async () => {
    const registry = new FeatureClaimLockRegistry(DEFAULT_CANDIDATE_POOL);

    const executionLog = [];

    // Agent 1 takes 80ms to finish building, Agent 2 takes 40ms, Agent 3 takes 20ms, Agent 4 takes 10ms.
    // Because selection only waits for the lock (not the build!), all 4 agents acquire their locks
    // in < 5ms and then finish their parallel builds in reverse duration order!
    const pipelineResult = await registry.executeLockTriggeredParallelPipeline([
      {
        agentId: 'Agent-1',
        preferredFeatureId: 'PreorderGraceBannerWidget.jsx',
        processFn: async (feature, ticket) => {
          executionLog.push(`START_WORK:${ticket.agentId}:${feature.featureId}:poolLeft=${ticket.remainingPoolCount}`);
          await new Promise((r) => setTimeout(r, 80));
          executionLog.push(`DONE_WORK:${ticket.agentId}:${feature.featureId}`);
          return { testsPassed: 7 };
        }
      },
      {
        agentId: 'Agent-2',
        preferredFeatureId: 'KitchenPrepDigestBoard.jsx',
        processFn: async (feature, ticket) => {
          executionLog.push(`START_WORK:${ticket.agentId}:${feature.featureId}:poolLeft=${ticket.remainingPoolCount}`);
          await new Promise((r) => setTimeout(r, 40));
          executionLog.push(`DONE_WORK:${ticket.agentId}:${feature.featureId}`);
          return { testsPassed: 7 };
        }
      },
      {
        agentId: 'Agent-3',
        preferredFeatureId: 'MerchantDishStockToggle.jsx',
        processFn: async (feature, ticket) => {
          executionLog.push(`START_WORK:${ticket.agentId}:${feature.featureId}:poolLeft=${ticket.remainingPoolCount}`);
          await new Promise((r) => setTimeout(r, 20));
          executionLog.push(`DONE_WORK:${ticket.agentId}:${feature.featureId}`);
          return { testsPassed: 6 };
        }
      },
      {
        agentId: 'Agent-4',
        processFn: async (feature, ticket) => {
          executionLog.push(`START_WORK:${ticket.agentId}:${feature.featureId}:poolLeft=${ticket.remainingPoolCount}`);
          await new Promise((r) => setTimeout(r, 10));
          executionLog.push(`DONE_WORK:${ticket.agentId}:${feature.featureId}`);
          return { testsPassed: 5 };
        }
      }
    ]);

    // 1. Verify (n -> n-1 -> n-2 -> n-3) pool reduction at lock time
    expect(pipelineResult.lockTickets[0].poolSizeBefore).toBe(4);
    expect(pipelineResult.lockTickets[0].remainingPoolCount).toBe(3);

    expect(pipelineResult.lockTickets[1].poolSizeBefore).toBe(3);
    expect(pipelineResult.lockTickets[1].remainingPoolCount).toBe(2);

    expect(pipelineResult.lockTickets[2].poolSizeBefore).toBe(2);
    expect(pipelineResult.lockTickets[2].remainingPoolCount).toBe(1);

    expect(pipelineResult.lockTickets[3].poolSizeBefore).toBe(1);
    expect(pipelineResult.lockTickets[3].remainingPoolCount).toBe(0);
    expect(pipelineResult.lockTickets[3].lockedFeature.featureId).toBe('JitCadenceNotificationWorker.js');

    // 2. Crucial Proof of Parallelism after Lock Acquisition:
    // All 4 START_WORK events happen BEFORE Agent-1's DONE_WORK event!
    const firstDoneIndex = executionLog.findIndex((entry) => entry.startsWith('DONE_WORK:'));
    const allStartIndices = executionLog
      .map((entry, idx) => (entry.startsWith('START_WORK:') ? idx : -1))
      .filter((idx) => idx !== -1);

    expect(allStartIndices).toHaveLength(4);
    for (const startIdx of allStartIndices) {
      expect(startIdx).toBeLessThan(firstDoneIndex);
    }

    // 3. Verify zero duplicate selections across all 4 agents
    const chosenIds = pipelineResult.lockTickets.map((t) => t.lockedFeature.featureId);
    expect(new Set(chosenIds).size).toBe(4);
    expect(pipelineResult.unclaimedReserve).toHaveLength(0);
  });

  it('verifies JitCadenceNotificationWorker debounces orders and scales cadence with exponential backoff', () => {
    const worker = new JitCadenceNotificationWorker({
      baseWindowMs: 1000,
      maxBatchSize: 3
    });

    // Initial cadence window = 1000ms (2^0)
    expect(worker.getCurrentCadenceWindowMs()).toBe(1000);

    const r1 = worker.enqueueOrder({
      orderId: 'LK-801',
      clientName: 'Kevin O.',
      deliveryAddress: 'Gate A',
      totalAmount: 850,
      items: [{ name: 'Swahili Coconut Chicken Stew', quantity: 1, price: 850 }]
    });
    expect(r1.queued).toBe(true);
    expect(worker.getPendingCount()).toBe(1);

    worker.enqueueOrder({
      orderId: 'LK-802',
      clientName: 'Sarah M.',
      deliveryAddress: 'Gate B',
      totalAmount: 1050,
      items: [{ name: 'Swahili Coconut Chicken Stew', quantity: 1, price: 850 }]
    });
    expect(worker.getPendingCount()).toBe(2);

    // 3rd order hits maxBatchSize=3 and triggers auto-flush into Stage 1 + Stage 2 BAG-01..03 Slips!
    const flushed = worker.enqueueOrder({
      orderId: 'LK-803',
      clientName: 'Alex K.',
      deliveryAddress: 'Gate A',
      totalAmount: 2200,
      items: [{ name: 'Slow-Roasted Beef Platter', quantity: 1, price: 2200 }]
    });

    expect(flushed.reason).toBe('MAX_BATCH_SIZE_REACHED');
    expect(flushed.orderCount).toBe(3);
    expect(flushed.packingSlips).toHaveLength(3);
    expect(flushed.packingSlips[0].bagLabel).toBe('BAG-01');
    expect(worker.getPendingCount()).toBe(0);

    // After 1st burst flush, exponential backoff doubles the cadence window: 1000 * 2^1 = 2000ms
    expect(worker.getCurrentCadenceWindowMs()).toBe(2000);
    worker.reset();
  });

  it('executes Simultaneous Priority-Scavenger Selection where Scavengers take their eye off Agent 1 choice upon pile lock release', async () => {
    const registry = new FeatureClaimLockRegistry(DEFAULT_CANDIDATE_POOL);

    // All 3 agents inspect the pile AT THE EXACT SAME TIME and even have overlapping top preferences!
    const result = await registry.executeSimultaneousScavengerSelection([
      {
        agentId: 'Agent-1-Priority',
        priority: 1,
        rankedPreferences: [
          'PreorderGraceBannerWidget.jsx',
          'KitchenPrepDigestBoard.jsx'
        ],
        processFn: async (feature) => ({ built: feature.featureId })
      },
      {
        agentId: 'Agent-2-Scavenger',
        priority: 2,
        // Even if Agent 2 initially looked at PreorderGraceBannerWidget.jsx first,
        // as a non-hungry scavenger it takes its eye off Agent 1's choice!
        rankedPreferences: [
          'PreorderGraceBannerWidget.jsx',
          'KitchenPrepDigestBoard.jsx',
          'MerchantDishStockToggle.jsx'
        ],
        processFn: async (feature) => ({ built: feature.featureId })
      },
      {
        agentId: 'Agent-3-Scavenger',
        priority: 3,
        rankedPreferences: [
          'PreorderGraceBannerWidget.jsx',
          'KitchenPrepDigestBoard.jsx',
          'MerchantDishStockToggle.jsx'
        ],
        processFn: async (feature) => ({ built: feature.featureId })
      }
    ]);

    expect(result.simultaneousWaveCount).toBe(3);

    const [t1, t2, t3] = result.lockTickets;

    // Agent 1 (Priority Apex) claims its #1 choice and releases the pile lock
    expect(t1.roleType).toBe('PRIORITY_APEX');
    expect(t1.lockedFeature.featureId).toBe('PreorderGraceBannerWidget.jsx');
    expect(t1.eyeOffSkippedIds).toEqual([]);
    expect(t1.pileLockReleasedToNext).toBe(true);

    // Agent 2 (Scavenger) takes its eye off Agent 1's choice and picks KitchenPrepDigestBoard.jsx from the released pile
    expect(t2.roleType).toBe('SCAVENGER');
    expect(t2.eyeOffSkippedIds).toEqual(['PreorderGraceBannerWidget.jsx']);
    expect(t2.lockedFeature.featureId).toBe('KitchenPrepDigestBoard.jsx');
    expect(t2.pileLockReleasedToNext).toBe(true);

    // Agent 3 (Scavenger) takes its eye off both Agent 1 & Agent 2 choices and picks MerchantDishStockToggle.jsx
    expect(t3.roleType).toBe('SCAVENGER');
    expect(t3.eyeOffSkippedIds).toEqual([
      'PreorderGraceBannerWidget.jsx',
      'KitchenPrepDigestBoard.jsx'
    ]);
    expect(t3.lockedFeature.featureId).toBe('MerchantDishStockToggle.jsx');

    // Remaining 1 item in pile is JitCadenceNotificationWorker.js
    expect(result.unclaimedReserve).toHaveLength(1);
    expect(result.unclaimedReserve[0].featureId).toBe('JitCadenceNotificationWorker.js');
  });
});

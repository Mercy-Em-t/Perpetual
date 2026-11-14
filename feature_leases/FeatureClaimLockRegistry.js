/**
 * ==============================================================================
 * TMS LEASED FEATURE — ATOMIC LOCK-AND-PIPELINE PARALLEL AGENT COORDINATOR
 * ==============================================================================
 * Implements the Lock-Triggered Parallel Processing pattern:
 *   1. Pool starts with `n` available candidate features.
 *   2. Agent 1 acquires the Selection Mutex, claims 1 feature (marking it
 *      `LOCKED_PROCESSING`), and IMMEDIATELY releases the Selection Mutex
 *      to begin parallel implementation work.
 *   3. Immediately upon Agent 1 obtaining the processing lock (without waiting
 *      for Agent 1's build to finish!), Agent 2 inspects the remaining (n - 1)
 *      unlocked pool, claims its feature lock, and begins parallel work.
 *   4. Agent k selects from (n - (k - 1)) remaining candidates and all agents
 *      execute their heavy build/verification tasks concurrently in parallel.
 *
 * Wall-Clock Complexity:
 *   Sequential Blocking:  T_total = sum(T_build_i)
 *   Lock-Then-Parallel:   T_total = k * T_lock + max(T_build_i)
 * ==============================================================================
 */

import { broadcastLeaseMessage } from "./LeaseBroadcastBridge.js";

export const DEFAULT_CANDIDATE_POOL = [
  {
    featureId: "PreorderGraceBannerWidget.jsx",
    title: "15-Minute Soft-Landing Pre-Order Grace Banner Widget",
    targetPath: "src/tenants/leahs-kitchen/components/PreorderGraceBannerWidget.jsx"
  },
  {
    featureId: "KitchenPrepDigestBoard.jsx",
    title: "Two-Stage Kitchen Prep & Customer Bagging Digest Board",
    targetPath: "src/tenants/leahs-kitchen/components/KitchenPrepDigestBoard.jsx"
  },
  {
    featureId: "MerchantDishStockToggle.jsx",
    title: "Real-Time Merchant Dish Availability & Daily Stock Cap Toggle",
    targetPath: "src/tenants/leahs-kitchen/components/MerchantDishStockToggle.jsx"
  },
  {
    featureId: "JitCadenceNotificationWorker.js",
    title: "Just-In-Time (JIT) 30s Debounced Order Notification & Cadence Worker",
    targetPath: "src/tenants/leahs-kitchen/modules/JitCadenceNotificationWorker.js"
  }
];

export class FeatureClaimLockRegistry {
  /**
   * @param {Array<Object>} [initialCandidates=DEFAULT_CANDIDATE_POOL]
   */
  constructor(initialCandidates = DEFAULT_CANDIDATE_POOL) {
    this.pool = initialCandidates.map((item, idx) => ({
      ...item,
      index: idx,
      status: "AVAILABLE", // AVAILABLE | LOCKED_PROCESSING | COMPLETED
      lockedByAgent: null,
      lockedAt: null,
      completedAt: null,
      remainingPoolSizeAfterLock: null,
      result: null
    }));
    this._mutexPromise = Promise.resolve();
    this.timelineEvents = [];
  }

  /**
   * Returns all currently unclaimed (AVAILABLE) features in the (n - k) pool.
   */
  getAvailablePool() {
    return this.pool.filter((f) => f.status === "AVAILABLE");
  }

  /**
   * Returns a snapshot of all features and their current lock/processing states.
   */
  getPoolSnapshot() {
    return this.pool.map((f) => ({ ...f }));
  }

  /**
   * Atomically acquires a processing lock on ONE available feature from the
   * remaining (n - k) pool. As soon as this method resolves (O(1) ms), the
   * next agent in line can immediately choose from the remaining (n - k - 1)
   * pool while the current agent executes its build work in parallel!
   *
   * @param {Object} options
   * @param {string} options.agentId - Unique agent identifier
   * @param {Function} [options.selectorFn] - Optional function `(availablePool) => chosenFeature`
   * @param {string} [options.preferredFeatureId] - Optional preferred feature ID if still available
   * @returns {Promise<Object>} Lock ticket with `completeProcessing(result)` callback
   */
  acquireFeatureLock({ agentId, selectorFn = null, preferredFeatureId = null }) {
    const runCriticalSection = async () => {
      const availableBefore = this.getAvailablePool();
      if (availableBefore.length === 0) {
        return {
          acquired: false,
          agentId,
          reason: "POOL_EXHAUSTED",
          remainingPoolCount: 0
        };
      }

      let chosen = null;
      if (preferredFeatureId) {
        chosen = availableBefore.find((f) => f.featureId === preferredFeatureId) || null;
      }
      if (!chosen && typeof selectorFn === "function") {
        chosen = selectorFn(availableBefore);
      }
      if (!chosen) {
        chosen = availableBefore[0];
      }

      // Mutate state inside critical section
      const targetEntry = this.pool.find((f) => f.featureId === chosen.featureId);
      const lockTimestamp = Date.now();
      targetEntry.status = "LOCKED_PROCESSING";
      targetEntry.lockedByAgent = agentId;
      targetEntry.lockedAt = lockTimestamp;

      const remainingAvailable = this.getAvailablePool();
      targetEntry.remainingPoolSizeAfterLock = remainingAvailable.length;

      const lockEvent = {
        phase: "LOCK_ACQUIRED",
        agentId,
        featureId: targetEntry.featureId,
        poolSizeBefore: availableBefore.length,
        poolSizeAfter: remainingAvailable.length,
        remainingFeatureIds: remainingAvailable.map((f) => f.featureId),
        timestamp: lockTimestamp
      };
      this.timelineEvents.push(lockEvent);

      // Broadcast immediate handoff signal so the next agent can choose right away
      broadcastLeaseMessage({
        reporter: `FeatureClaimLockRegistry (${agentId})`,
        type: "FEATURE_LOCK_ACQUIRED_NEXT_AGENT_GO",
        tenantId: "leahs-kitchen",
        tenantName: "Leah's Kitchen",
        status: "ACTIVE",
        summary: `${agentId} locked "${targetEntry.featureId}" (${availableBefore.length} -> ${remainingAvailable.length} left). Next agent may now choose while ${agentId} processes in parallel.`,
        metadata: lockEvent
      });

      return {
        acquired: true,
        agentId,
        lockedFeature: { ...targetEntry },
        poolSizeBefore: availableBefore.length,
        remainingPoolCount: remainingAvailable.length,
        remainingCandidates: remainingAvailable.map((f) => ({ ...f })),
        completeProcessing: (buildResult = {}) => {
          const doneTimestamp = Date.now();
          targetEntry.status = "COMPLETED";
          targetEntry.completedAt = doneTimestamp;
          targetEntry.result = buildResult;
          this.timelineEvents.push({
            phase: "PROCESSING_COMPLETED",
            agentId,
            featureId: targetEntry.featureId,
            timestamp: doneTimestamp,
            durationMs: doneTimestamp - lockTimestamp
          });
          return { ...targetEntry };
        }
      };
    };

    // Chain onto internal promise mutex so lock claims are strictly atomic,
    // while releasing immediately before the agent's heavy parallel processing starts.
    const ticketPromise = this._mutexPromise.then(runCriticalSection);
    this._mutexPromise = ticketPromise.catch(() => {});
    return ticketPromise;
  }

  /**
   * Executes an array of agent specs using Lock-Triggered Pipelined Parallelism:
   * - Agent k+1 is triggered to choose IMMEDIATELY after Agent k acquires its lock,
   *   WITHOUT waiting for Agent k's `processFn` to finish!
   * - All agents run their `processFn` concurrently in parallel.
   *
   * @param {Array<{agentId: string, preferredFeatureId?: string, selectorFn?: Function, processFn: Function}>} agentSpecs
   */
  async executeLockTriggeredParallelPipeline(agentSpecs = []) {
    const parallelProcessingPromises = [];
    const lockTickets = [];

    for (const spec of agentSpecs) {
      // 1. Agent acquires lock on 1 feature from remaining (n - k) pool (O(1) ms)
      const ticket = await this.acquireFeatureLock({
        agentId: spec.agentId,
        preferredFeatureId: spec.preferredFeatureId,
        selectorFn: spec.selectorFn
      });
      lockTickets.push(ticket);

      if (ticket.acquired && typeof spec.processFn === "function") {
        // 2. Immediately start parallel processing in the background (DO NOT await here!)
        //    so the loop immediately advances to let the next agent choose!
        const workPromise = Promise.resolve()
          .then(() => spec.processFn(ticket.lockedFeature, ticket))
          .then((output) => ticket.completeProcessing(output));

        parallelProcessingPromises.push(workPromise);
      }
    }

    // 3. Wait for all parallel worker streams to finish their builds concurrently
    const completedFeatures = await Promise.all(parallelProcessingPromises);

    return {
      lockTickets,
      completedFeatures,
      timelineEvents: [...this.timelineEvents],
      unclaimedReserve: this.getAvailablePool()
    };
  }

  /**
   * Simultaneous Priority-Scavenger Selection Model:
   * - All agents inspect the full pile AT THE EXACT SAME TIME (t = 0) and form
   *   their ranked preference vectors simultaneously (`Promise.all`).
   * - Agent 1 holds Priority 1: it locks its choice and immediately releases the
   *   pile lock (`PILE_LOCK_RELEASED`).
   * - Scavenger Agents (Agent 2..k) are NEVER hungry for a higher-priority agent's
   *   work: if a Scavenger's first eye was on Agent 1's choice, it immediately
   *   "takes its eye off" Agent 1's claimed item (`eyeOffSkippedIds`) and locks
   *   its top remaining choice from the released pile.
   * - All agents then run their `processFn` in full parallel!
   *
   * @param {Array<{agentId: string, priority?: number, rankedPreferences?: string[], evaluatePileFn?: Function, processFn?: Function}>} agentSpecs
   */
  async executeSimultaneousScavengerSelection(agentSpecs = []) {
    const initialPileSnapshot = this.getAvailablePool().map((f) => ({ ...f }));

    // STEP 1: All agents inspect the pile AT THE EXACT SAME TIME (Simultaneous Evaluation)
    const simultaneousEvaluations = await Promise.all(
      agentSpecs.map(async (spec, idx) => {
        let preferences = Array.isArray(spec.rankedPreferences) ? [...spec.rankedPreferences] : [];
        if (typeof spec.evaluatePileFn === "function") {
          const evaluated = await spec.evaluatePileFn(initialPileSnapshot);
          if (Array.isArray(evaluated)) {
            preferences = evaluated;
          }
        }
        if (spec.preferredFeatureId && !preferences.includes(spec.preferredFeatureId)) {
          preferences.unshift(spec.preferredFeatureId);
        }
        return {
          ...spec,
          priorityRank: spec.priority ?? idx + 1,
          roleType: (spec.priority ?? idx + 1) === 1 ? "PRIORITY_APEX" : "SCAVENGER",
          simultaneousPreferences: preferences,
          evaluatedAtSimultaneousWave: true
        };
      })
    );

    // Sort by priorityRank (Agent 1 is Priority 1, Agent 2+ are Scavengers)
    simultaneousEvaluations.sort((a, b) => a.priorityRank - b.priorityRank);

    // STEP 2: Priority 1 locks & releases pile lock -> Scavengers take eye off claimed work & pick from remaining pile
    const claimedByHigherPriority = new Set();
    const lockTickets = [];
    const parallelWorkPromises = [];

    for (const agentEval of simultaneousEvaluations) {
      const eyeOffSkippedIds = [];

      const ticket = await this.acquireFeatureLock({
        agentId: agentEval.agentId,
        selectorFn: (availablePool) => {
          // Scavenger scans its simultaneous preference list, taking its eye off any item already claimed by Priority 1..k-1
          for (const prefId of agentEval.simultaneousPreferences) {
            if (claimedByHigherPriority.has(prefId)) {
              eyeOffSkippedIds.push(prefId);
              continue;
            }
            const match = availablePool.find((f) => f.featureId === prefId);
            if (match) return match;
          }
          // Fallback to first available item in the released pile
          return availablePool[0];
        }
      });

      if (ticket.acquired) {
        claimedByHigherPriority.add(ticket.lockedFeature.featureId);
        ticket.roleType = agentEval.roleType;
        ticket.priorityRank = agentEval.priorityRank;
        ticket.eyeOffSkippedIds = eyeOffSkippedIds;
        ticket.pileLockReleasedToNext = true;

        this.timelineEvents.push({
          phase: "PILE_LOCK_RELEASED",
          agentId: agentEval.agentId,
          roleType: agentEval.roleType,
          lockedFeatureId: ticket.lockedFeature.featureId,
          eyeOffSkippedIds,
          remainingPileCount: ticket.remainingPoolCount,
          timestamp: Date.now()
        });
      }

      lockTickets.push(ticket);

      if (ticket.acquired && typeof agentEval.processFn === "function") {
        const workPromise = Promise.resolve()
          .then(() => agentEval.processFn(ticket.lockedFeature, ticket))
          .then((output) => ticket.completeProcessing(output));
        parallelWorkPromises.push(workPromise);
      }
    }

    // STEP 3: All agents execute their builds simultaneously in parallel
    const completedFeatures = await Promise.all(parallelWorkPromises);

    return {
      simultaneousWaveCount: simultaneousEvaluations.length,
      lockTickets,
      completedFeatures,
      timelineEvents: [...this.timelineEvents],
      unclaimedReserve: this.getAvailablePool()
    };
  }
}

export const defaultFeatureClaimRegistry = new FeatureClaimLockRegistry();


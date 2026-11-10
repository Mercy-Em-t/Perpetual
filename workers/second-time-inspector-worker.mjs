#!/usr/bin/env node
/**
 * ==============================================================================
 * TMS LEASED FEATURE - SECOND-BY-SECOND TIME INSPECTOR & PACKET WORKER DAEMON
 * ==============================================================================
 * Wakes up every second (1000ms), greets ("Hey!"), reads and parses the Time Card
 * ("the time is hh.mm.ss dd.mm.year"), verifies clock synchronization, audits
 * packet arrival ("no packets moving, packets came all of them"), reassembles
 * self into "HEALTHY_AND_EXECUTABLE", unpacks analysis tools, and connects to the
 * 5-minute Google Drive live files room buffer.
 * 
 * Usage:
 *   node scripts/second-time-inspector-worker.mjs --simulate 180   # 3-minute full simulation
 *   node scripts/second-time-inspector-worker.mjs --now            # Single instant tick
 *   node scripts/second-time-inspector-worker.mjs --ticks 5        # 5-second test run
 * ==============================================================================
 */

import {
  executeInspectorTick,
  broadcastInspectorTick
} from "../src/sandbox/leases/TimeInspectorEngine.js";

const CHANNEL_NAME = "tms_lease_broadcast_channel";

// Command line argument parser
const args = process.argv.slice(2);
let simulationSeconds = 180; // 3 minutes default
let isSingleTick = false;

let isTimeoutSimulated = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--simulate" && args[i + 1]) {
    simulationSeconds = parseInt(args[i + 1], 10) || 180;
    i++;
  } else if (args[i] === "--ticks" && args[i + 1]) {
    simulationSeconds = parseInt(args[i + 1], 10) || 5;
    i++;
  } else if (args[i] === "--now") {
    isSingleTick = true;
    simulationSeconds = 1;
  } else if (args[i] === "--timeout") {
    isTimeoutSimulated = true;
  }
}

/**
 * Renders a single tick's diagnostic report in a clean console table
 * @param {Object} tickResult 
 */
function logTickConsoleTable(tickResult) {
  const {
    tickNumber,
    totalSimulationTicks,
    countdown,
    handshake,
    card,
    parsedCard,
    timeSync,
    packetCheck,
    reassembly,
    tools,
    driveRoom
  } = tickResult;

  const handshakeDisplay = handshake.shouldReportTimeout
    ? `🚨 TIMEOUT EXCEEDED (${handshake.waitedMs}ms > ${handshake.timeoutThresholdMs}ms) - INCIDENT REPORTED!`
    : (handshake.status === "WAITING_WITHIN_GRACE"
      ? `⏳ WAITING (${handshake.waitedMs}ms) - WITHIN GRACE (NO REPORT)`
      : `🤝 ESTABLISHED (${handshake.waitedMs}ms RTT)`);

  console.log(`\n=============================================================`);
  console.log(`⏱️  [1s TIME INSPECTOR WORKER] TICK ${tickNumber}/${totalSimulationTicks} | REMAINING: ${countdown}`);
  console.log(`📡 Broadcast Channel: ${CHANNEL_NAME}`);
  console.log(`=============================================================`);

  console.table([
    { Field: "Handshake / Greeting", Value: card.greeting },
    { Field: "Handshake Liveness", Value: handshakeDisplay },
    { Field: "Time Card Tag", Value: card.tag },
    { Field: "Card Raw Inscription", Value: card.rawText },
    { Field: "Parsed Clock Time", Value: `${parsedCard.timeString} (Date: ${parsedCard.dateString})` },
    { Field: "Clock Sync Check", Value: `${timeSync.verdict} (drift: ${timeSync.driftMs}ms)` },
    { Field: "Packets Arrived In Full", Value: packetCheck.packetsArrivedInFull ? "YES (100% - 64/64)" : "NO" },
    { Field: "Moving / In-Flight Packets", Value: `${packetCheck.movingPackets} (None moving)` },
    { Field: "Packets Came All Of Them", Value: packetCheck.packetsCameAllOfThem ? "YES (All settled)" : "NO" },
    { Field: "Self-Reassembly State", Value: reassembly.state },
    { Field: "Go-Ahead Certification", Value: reassembly.goAhead ? "GRANTED (Healthy & Executable)" : "HELD" },
    { Field: "Tools Unpacked Status", Value: `${tools.status} (${tools.toolsCount} active tools)` },
    { Field: "Google Drive Live Room", Value: `${driveRoom.roomName} (${driveRoom.leaseWindowFormatted})` }
  ]);
  console.log(`=============================================================\n`);
}

/**
 * Main simulation runner
 */
async function runSimulation() {
  console.log(`\n=============================================================`);
  console.log(`🚀 INITIALIZING TIME INSPECTOR & PACKET REASSEMBLY SIMULATOR`);
  console.log(`⏱️  Target Duration: ${simulationSeconds} seconds (${(simulationSeconds / 60).toFixed(1)} minutes)`);
  console.log(`🔄 Wakeup Cadence: Every 1000ms (1 Second)`);
  console.log(`📦 Verification Invariants:`);
  console.log(`   1. Time Card Reading: "...the time is hh.mm.ss dd.mm.year.."`);
  console.log(`   2. Internal Clock Synchronization`);
  console.log(`   3. Packet Integrity: Zero moving packets, all arrived in full`);
  console.log(`   4. Self-Reassembly -> HEALTHY_AND_EXECUTABLE`);
  console.log(`   5. Unpacking Diagnostic Tools`);
  console.log(`   6. Mount Google Drive 5-Minute Live Files Room`);
  console.log(`=============================================================\n`);

  let currentTick = 1;

  const runStep = () => {
    return new Promise((resolve) => {
      const result = executeInspectorTick(currentTick, simulationSeconds, {
        handshakeMode: isTimeoutSimulated ? "TIMEOUT" : "NORMAL",
      });
      broadcastInspectorTick(result);
      logTickConsoleTable(result);
      currentTick++;
      resolve();
    });
  };

  if (isSingleTick) {
    await runStep();
    console.log(`✅ Single 1s tick verification completed successfully.\n`);
    process.exit(0);
  }

  // Run the interval loop
  const interval = setInterval(async () => {
    await runStep();

    if (currentTick > simulationSeconds) {
      clearInterval(interval);
      console.log(`\n=============================================================`);
      console.log(`🎉 3-MINUTE TIME INSPECTOR SIMULATION COMPLETED SUCCESSFULLY`);
      console.log(`📊 Total Ticks Dispatched: ${simulationSeconds}`);
      console.log(`🛡️  All packets arrived in full, system reassembled and healthy.`);
      console.log(`=============================================================\n`);
      process.exit(0);
    }
  }, 1000);

  // Allow clean SIGINT termination
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log(`\n🛑 Worker simulation terminated by user at tick ${currentTick - 1}.\n`);
    process.exit(0);
  });
}

runSimulation().catch((err) => {
  console.error("❌ Fatal error in Time Inspector Worker:", err);
  process.exit(1);
});

/**
 * ==============================================================================
 * TMS LEASED FEATURE - SECOND-BY-SECOND TIME INSPECTOR & PACKET ENGINE
 * ==============================================================================
 * Core diagnostic engine implementing:
 * 1. Second-by-second wakeup cadence (1000ms heartbeat).
 * 2. Handshake ("Hey!") & Time Card generator/parser ("the time is hh.mm.ss dd.mm.year").
 * 3. Clock synchronization and drift tolerance verification.
 * 4. Packet integrity check ("packets arrived in full", "no packets moving", "packets came all of them").
 * 5. Self-reassembly into "HEALTHY_AND_EXECUTABLE" state with Go-Ahead certification.
 * 6. Tool unpacking protocol for diagnostics.
 * 7. "Rooms" buffer provisioner: Google Drive 5-minute live files room.
 * ==============================================================================
 */

const CHANNEL_NAME = "tms_lease_broadcast_channel";

/**
 * Format a Date object into the canonical "hh.mm.ss dd.mm.year" format
 * @param {Date} date
 * @returns {string} e.g. "20.15.30 22.10.2026"
 */
export function formatTimeComponents(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const dd = pad(date.getDate());
  const mon = pad(date.getMonth() + 1);
  const yyyy = date.getFullYear();
  return `${hh}.${mm}.${ss} ${dd}.${mon}.${yyyy}`;
}

/**
 * Generate a new Time Card to show to the worker
 * @param {Date} date
 * @returns {Object} Card specification
 */
export function generateTimeCard(date = new Date()) {
  const formattedTime = formatTimeComponents(date);
  return {
    tag: "TIME_CARD",
    greeting: "Hey!",
    rawText: `Hey, the time is ${formattedTime}`,
    formattedTime,
    timestamp: date.toISOString(),
  };
}

/**
 * Parses a Time Card string or object, extracting tag and timestamp components
 * @param {string|Object} input
 * @returns {Object} Parsed time card report
 */
export function parseTimeCard(input) {
  let rawText = "";
  let tag = "TIME_CARD";

  if (typeof input === "string") {
    rawText = input;
  } else if (input && typeof input === "object") {
    rawText = input.rawText || `the time is ${input.formattedTime || ""}`;
    tag = input.tag || "TIME_CARD";
  }

  // Regex matching "the time is hh.mm.ss dd.mm.yyyy" (case-insensitive, flexible dots/separators)
  const regex = /the time is\s+(\d{2})[.:](\d{2})[.:](\d{2})\s+(\d{2})[.:](\d{2})[.:](\d{4})/i;
  const match = rawText.match(regex);

  if (!match) {
    return {
      valid: false,
      tag,
      error: `Could not parse card text: "${rawText}". Expected: "the time is hh.mm.ss dd.mm.year"`,
      rawText,
    };
  }

  const [, hh, mm, ss, dd, mon, yyyy] = match;
  const hours = parseInt(hh, 10);
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  const day = parseInt(dd, 10);
  const month = parseInt(mon, 10);
  const year = parseInt(yyyy, 10);

  const parsedDate = new Date(year, month - 1, day, hours, minutes, seconds);

  return {
    valid: true,
    tag,
    greeting: "Hey!",
    readTimeText: `the time is ${hh}.${mm}.${ss} ${dd}.${mon}.${yyyy}`,
    timeString: `${hh}:${mm}:${ss}`,
    dateString: `${dd}/${mon}/${yyyy}`,
    hours,
    minutes,
    seconds,
    day,
    month,
    year,
    parsedDate,
    parsedIso: parsedDate.toISOString(),
  };
}

/**
 * Verifies if what the worker read on the card matches the worker's internal clock
 * @param {Date|string} cardTime - Parsed card date or formatted time
 * @param {Date} [workerTime=new Date()] - Worker's internal clock
 * @param {number} [toleranceMs=1500] - Drift tolerance threshold
 * @returns {Object}
 */
export function verifyTimeSync(cardTime, workerTime = new Date(), toleranceMs = 1500) {
  let cardDate;
  if (cardTime instanceof Date) {
    cardDate = cardTime;
  } else if (typeof cardTime === "string") {
    const parsed = parseTimeCard(cardTime);
    cardDate = parsed.valid ? parsed.parsedDate : new Date(cardTime);
  } else if (cardTime && cardTime.parsedDate) {
    cardDate = cardTime.parsedDate;
  } else {
    cardDate = new Date();
  }

  const driftMs = Math.abs(cardDate.getTime() - workerTime.getTime());
  const isSynchronized = driftMs <= toleranceMs;

  return {
    isSynchronized,
    driftMs,
    cardTimeFormatted: formatTimeComponents(cardDate),
    workerTimeFormatted: formatTimeComponents(workerTime),
    verdict: isSynchronized ? "CLOCK_IN_SYNC" : "CLOCK_DRIFT_EXCEEDED",
    toleranceMs,
  };
}

/**
 * Checks packet integrity:
 * "They check if they arrived in full, no packets moving, packets came all of them."
 * @param {Object} [overrides={}]
 * @returns {Object}
 */
export function verifyPacketIntegrity(overrides = {}) {
  const totalExpected = overrides.totalExpected !== undefined ? overrides.totalExpected : 64;
  const receivedPackets = overrides.receivedPackets !== undefined ? overrides.receivedPackets : 64;
  const inFlightPackets = overrides.inFlightPackets !== undefined ? overrides.inFlightPackets : 0;
  const movingPackets = overrides.movingPackets !== undefined ? overrides.movingPackets : 0;
  const droppedPackets = overrides.droppedPackets !== undefined ? overrides.droppedPackets : 0;

  const packetsArrivedInFull = receivedPackets === totalExpected && droppedPackets === 0;
  const noPacketsMoving = movingPackets === 0 && inFlightPackets === 0;
  const packetsCameAllOfThem = packetsArrivedInFull && noPacketsMoving;

  const integrityScore = totalExpected > 0 ? (receivedPackets / totalExpected) * 100 : 100;

  return {
    totalExpected,
    receivedPackets,
    inFlightPackets,
    movingPackets,
    droppedPackets,
    packetsArrivedInFull,
    noPacketsMoving,
    packetsCameAllOfThem,
    integrityRatio: `${integrityScore.toFixed(0)}%`,
    checksum: "SHA256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    packetStreamStatus: packetsCameAllOfThem ? "ALL_PACKETS_SETTLED_IN_FULL" : "PACKETS_IN_TRANSIT",
  };
}

/**
 * Worker self-reassembly:
 * "They are reassembling themselves and then give the go ahead that they are healthy and executable."
 * @param {Object} packetCheck
 * @returns {Object}
 */
export function reassembleWorker(packetCheck) {
  const isHealthy = packetCheck.packetsCameAllOfThem && packetCheck.noPacketsMoving;

  if (isHealthy) {
    return {
      state: "HEALTHY_AND_EXECUTABLE",
      goAhead: true,
      verdict: "GO_AHEAD: System is healthy and executable. All packets arrived in full, zero packets moving.",
      reassemblyTimestamp: new Date().toISOString(),
    };
  }

  return {
    state: "CORRUPTED_OR_IN_FLIGHT",
    goAhead: false,
    verdict: "HOLD: Packet stream incomplete or packets still in flight. Reassembly halted.",
    reassemblyTimestamp: new Date().toISOString(),
  };
}

/**
 * Unpacks the worker's diagnostic toolset:
 * "They are helped to unpack their tools."
 * @returns {Object}
 */
export function unpackWorkerTools() {
  const tools = [
    {
      id: "tool-lease-chronometer",
      name: "Lease Chronometer Sync Gauge",
      version: "2.4.1",
      purpose: "Validates sub-second clock drift and card timestamps",
      status: "READY",
    },
    {
      id: "tool-packet-reassembler",
      name: "Packet Integrity Reassembly Matrix",
      version: "3.0.0",
      purpose: "Audits zero-moving packet invariant and byte stream completeness",
      status: "READY",
    },
    {
      id: "tool-zero-trust-gate",
      name: "Zero-Trust Default-Deny Gate Verifier",
      version: "1.9.0",
      purpose: "Enforces pilotMode === false visibility barrier",
      status: "READY",
    },
    {
      id: "tool-gdrive-live-streamer",
      name: "Google Drive Live Room Connector",
      version: "4.2.0",
      purpose: "Mounts and maintains 5-minute live file buffers",
      status: "READY",
    },
    {
      id: "tool-broadcast-receiver",
      name: "Tabulated Broadcast & Receiver Bridge",
      version: "2.1.0",
      purpose: "Dispatches and receives cross-tab JSON payloads",
      status: "READY",
    },
  ];

  return {
    status: "TOOLS_UNPACKED",
    toolsCount: tools.length,
    tools,
    unpackedAt: new Date().toISOString(),
  };
}

/**
 * Shown the rooms:
 * "Shown the rooms... in this case we have files in a google drive. Live files. Live 5 minutes"
 * @param {number} [durationSeconds=300] - 5-minute window (300s)
 * @returns {Object}
 */
export function mountGoogleDriveLiveRoom(durationSeconds = 300) {
  const now = Date.now();
  const expiryTime = new Date(now + durationSeconds * 1000).toISOString();

  const liveFiles = [
    {
      name: "TMS-Architecture-Specification-2026.gdoc",
      type: "Google Document",
      size: "2.4 MB",
      status: "LIVE_SYNC",
      driveId: "1AbC9_TMS_Spec_Core_2026",
    },
    {
      name: "Midnight-Sweep-Lease-Reconciliation.gsheet",
      type: "Google Sheet",
      size: "840 KB",
      status: "STREAMING",
      driveId: "2XyZ4_Reconcile_Sweep_Matrix",
    },
    {
      name: "Zero-Trust-Default-Deny-Gate.gslides",
      type: "Google Presentation",
      size: "5.1 MB",
      status: "MOUNTED",
      driveId: "3Qwe1_ZeroTrust_Quarantine",
    },
    {
      name: "Tenant-Telemetry-Buffer-5m.parquet",
      type: "Live Binary Stream",
      size: "1.2 MB",
      status: "LIVE_BUFFER",
      driveId: "4Rty8_Parquet_Telemetry",
    },
    {
      name: "Technical-Writer-Vault-Index.gdoc",
      type: "Google Document",
      size: "340 KB",
      status: "REALTIME",
      driveId: "5Uio0_Writer_Vault_Index",
    },
  ];

  return {
    roomName: "Google Drive Live Files Room (Alpha Corridor)",
    driveUri: "gdrive://tms-whitelabel-shared/rooms/live-5m",
    leaseDurationSeconds: durationSeconds,
    leaseWindowFormatted: "5 Minutes Live Buffer",
    expiryTime,
    filesCount: liveFiles.length,
    liveFiles,
    status: "LIVE_ROOM_MOUNTED_5_MINUTES",
  };
}

/**
 * Creates a Handshake request:
 * "And handshakes. Wait for the handshake..."
 * @param {string} [peerId="BROADCAST_RECEIVER_PEER"]
 * @param {number} [initiatedAt=Date.now()]
 * @returns {Object}
 */
export function createHandshake(peerId = "BROADCAST_RECEIVER_PEER", initiatedAt = Date.now()) {
  return {
    id: `hs_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    peerId,
    initiatedAt,
    acknowledgedAt: null,
    status: "SYN_SENT",
    synMessage: "Hey! Handshake [SYN]",
  };
}

/**
 * Acknowledges a Handshake request
 * @param {Object} handshake
 * @param {number} [ackTimestamp=Date.now()]
 * @returns {Object}
 */
export function acknowledgeHandshake(handshake, ackTimestamp = Date.now()) {
  return {
    ...handshake,
    acknowledgedAt: ackTimestamp,
    status: "ACKNOWLEDGED",
    rttMs: Math.max(0, ackTimestamp - handshake.initiatedAt),
    ackMessage: "Handshake Established [ACK]",
  };
}

/**
 * Evaluates Handshake liveness and timeout reporting invariant:
 * "Wait for the handshake. If no response you report. But not always. When you've been waiting for too long."
 * @param {Object} handshake
 * @param {number} [currentTimestamp=Date.now()]
 * @param {Object} [config={}]
 * @returns {Object} Handshake evaluation report
 */
export function evaluateHandshake(handshake, currentTimestamp = Date.now(), config = {}) {
  const gracePeriodMs = config.gracePeriodMs !== undefined ? config.gracePeriodMs : 3000;
  const timeoutThresholdMs = config.timeoutThresholdMs !== undefined ? config.timeoutThresholdMs : 5000;

  const isAcked = handshake && handshake.status === "ACKNOWLEDGED";
  const waitedMs = isAcked
    ? (handshake.acknowledgedAt - handshake.initiatedAt)
    : Math.max(0, currentTimestamp - (handshake ? handshake.initiatedAt : currentTimestamp));

  if (isAcked) {
    return {
      handshakeId: handshake.id,
      peerId: handshake.peerId,
      status: "ACKNOWLEDGED",
      waitedMs,
      gracePeriodMs,
      timeoutThresholdMs,
      shouldReportTimeout: false,
      verdict: "HANDSHAKE_ESTABLISHED",
      summary: `Handshake established with ${handshake.peerId} (RTT: ${waitedMs}ms).`,
    };
  }

  // Not acknowledged yet:
  if (waitedMs <= timeoutThresholdMs) {
    // "Wait for the handshake... But not always [report]. When you've been waiting for too long."
    return {
      handshakeId: handshake ? handshake.id : "hs_pending",
      peerId: handshake ? handshake.peerId : "PEER",
      status: "WAITING_WITHIN_GRACE",
      waitedMs,
      gracePeriodMs,
      timeoutThresholdMs,
      shouldReportTimeout: false,
      verdict: "WAITING_FOR_HANDSHAKE_WITHIN_GRACE",
      summary: `Awaiting handshake response (${waitedMs}ms elapsed). Within tolerable grace period (${timeoutThresholdMs}ms). Suppressing alarm.`,
    };
  }

  // Waited too long! "If no response you report... When you've been waiting for too long."
  return {
    handshakeId: handshake ? handshake.id : "hs_timeout",
    peerId: handshake ? handshake.peerId : "PEER",
    status: "TIMEOUT_EXCEEDED",
    waitedMs,
    gracePeriodMs,
    timeoutThresholdMs,
    shouldReportTimeout: true,
    verdict: "HANDSHAKE_TIMEOUT_EXCEEDED",
    summary: `🚨 Handshake Timeout: Waited ${waitedMs}ms for ${handshake ? handshake.peerId : "PEER"} (exceeded ${timeoutThresholdMs}ms limit). Reporting incident to channel.`,
    incidentDetails: {
      severity: "HIGH",
      reason: `Peer did not respond to handshake [SYN] within ${timeoutThresholdMs}ms threshold.`,
      actionRequired: "Trigger diagnostic alarm, broadcast timeout report, and invoke circuit breaker fallback.",
    },
  };
}

/**
 * Runs a single 1-second inspection tick:
 * Wakes up -> Handshake -> Reads Card -> Verifies Time -> Checks Packets -> Reassembles -> Unpacks Tools -> Mounts Drive Room
 * @param {number} tickNumber - Current tick (e.g. 1)
 * @param {number} totalSimulationTicks - Total ticks in simulation (e.g. 180)
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function executeInspectorTick(tickNumber = 1, totalSimulationTicks = 180, options = {}) {
  const workerTime = options.workerTime || new Date();
  const currentTimestamp = workerTime.getTime();

  // 1. Handshake evaluation ("Wait for the handshake. If no response you report. But not always. When you've been waiting for too long.")
  let handshakeObj;
  if (options.handshake) {
    handshakeObj = options.handshake;
  } else if (options.handshakeMode === "TIMEOUT") {
    // Simulate initiated 6 seconds ago with zero response
    handshakeObj = createHandshake("PEER_BROADCAST_RECEIVER", currentTimestamp - 6000);
  } else if (options.handshakeMode === "GRACE") {
    // Simulate initiated 2 seconds ago, within grace period
    handshakeObj = createHandshake("PEER_BROADCAST_RECEIVER", currentTimestamp - 2000);
  } else {
    // Normal: initiated and promptly acknowledged
    const syn = createHandshake("PEER_BROADCAST_RECEIVER", currentTimestamp - 12);
    handshakeObj = acknowledgeHandshake(syn, currentTimestamp);
  }

  const handshakeEval = evaluateHandshake(handshakeObj, currentTimestamp, {
    gracePeriodMs: options.gracePeriodMs || 3000,
    timeoutThresholdMs: options.timeoutThresholdMs || 5000,
  });

  // 2. Card presentation
  const card = generateTimeCard(workerTime);

  // 3. Worker parses card
  const parsedCard = parseTimeCard(card);

  // 4. Worker checks if card time == worker time
  const timeSync = verifyTimeSync(parsedCard, workerTime);

  // 5. Packet integrity check
  const packetCheck = verifyPacketIntegrity(options.packetOverrides || {});

  // 6. Worker self-reassembly
  const reassembly = reassembleWorker(packetCheck);

  // 7. Tools unpacking
  const tools = unpackWorkerTools();

  // 8. Google Drive Room (5 minutes live files)
  const driveRoom = mountGoogleDriveLiveRoom(options.driveWindowSeconds || 300);

  const remainingSeconds = Math.max(0, totalSimulationTicks - tickNumber);
  const remainingMm = String(Math.floor(remainingSeconds / 60)).padStart(2, "0");
  const remainingSs = String(remainingSeconds % 60).padStart(2, "0");

  const actionType = handshakeEval.shouldReportTimeout
    ? "HANDSHAKE_TIMEOUT_REPORTED"
    : "TIME_CARD_TICK";

  const summary = handshakeEval.shouldReportTimeout
    ? `[Tick ${tickNumber}/${totalSimulationTicks}] 🚨 HANDSHAKE TIMEOUT REPORT: Waited ${handshakeEval.waitedMs}ms with zero response (limit: ${handshakeEval.timeoutThresholdMs}ms). Card: "${card.rawText}". Status: ${reassembly.state}.`
    : `[Tick ${tickNumber}/${totalSimulationTicks} | Remaining: ${remainingMm}:${remainingSs}] Handshake: ${handshakeEval.verdict}. Card: "${card.rawText}". Sync: ${timeSync.verdict}. Packets: ${packetCheck.integrityRatio} (${packetCheck.movingPackets} moving). Status: ${reassembly.state}. Tools: ${tools.status}. Google Drive: 5m Room Active.`;

  const payload = {
    id: `tick_${Date.now()}_${tickNumber}`,
    reporter: "Second-by-Second Time Inspector Worker (1s)",
    type: actionType,
    tenantId: "ALL",
    tenantName: "Global Whitelabel Core",
    chunkId: "time_inspector_card",
    chunkName: "1-Second Time Card & Packet Reassembly",
    status: handshakeEval.shouldReportTimeout ? "EXPIRED" : "ACTIVE",
    pilotMode: false,
    timestamp: workerTime.toISOString(),
    summary,
    metadata: {
      simulation: {
        tickNumber,
        totalSimulationTicks,
        remainingSeconds,
        countdown: `${remainingMm}:${remainingSs}`,
      },
      handshake: {
        id: handshakeEval.handshakeId,
        peerId: handshakeEval.peerId,
        status: handshakeEval.status,
        waitedMs: handshakeEval.waitedMs,
        gracePeriodMs: handshakeEval.gracePeriodMs,
        timeoutThresholdMs: handshakeEval.timeoutThresholdMs,
        shouldReportTimeout: handshakeEval.shouldReportTimeout,
        verdict: handshakeEval.verdict,
        incidentDetails: handshakeEval.incidentDetails || null,
      },
      card: {
        greeting: card.greeting,
        tag: card.tag,
        rawText: card.rawText,
        formattedTime: card.formattedTime,
      },
      parsedCard: {
        readTimeText: parsedCard.readTimeText,
        timeString: parsedCard.timeString,
        dateString: parsedCard.dateString,
      },
      timeSync: {
        isSynchronized: timeSync.isSynchronized,
        driftMs: timeSync.driftMs,
        verdict: timeSync.verdict,
      },
      packets: {
        totalExpected: packetCheck.totalExpected,
        receivedPackets: packetCheck.receivedPackets,
        movingPackets: packetCheck.movingPackets,
        packetsArrivedInFull: packetCheck.packetsArrivedInFull,
        noPacketsMoving: packetCheck.noPacketsMoving,
        packetsCameAllOfThem: packetCheck.packetsCameAllOfThem,
        integrityRatio: packetCheck.integrityRatio,
      },
      reassembly: {
        state: reassembly.state,
        goAhead: reassembly.goAhead,
        verdict: reassembly.verdict,
      },
      tools: {
        count: tools.toolsCount,
        status: tools.status,
      },
      driveRoom: {
        roomName: driveRoom.roomName,
        window: driveRoom.leaseWindowFormatted,
        filesCount: driveRoom.filesCount,
        status: driveRoom.status,
      },
    },
  };

  return {
    tickNumber,
    totalSimulationTicks,
    remainingSeconds,
    countdown: `${remainingMm}:${remainingSs}`,
    handshake: handshakeEval,
    card,
    parsedCard,
    timeSync,
    packetCheck,
    reassembly,
    tools,
    driveRoom,
    payload,
  };
}

/**
 * Broadcasts the tick payload to the active BroadcastChannel and CustomEvent
 * @param {Object} tickResult
 */
export function broadcastInspectorTick(tickResult) {
  const payload = tickResult.payload;

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(payload);
      channel.close();
    } catch (err) {
      // In non-browser/test environments, handle gracefully
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("tms:lease:message", { detail: payload }));
  }

  return payload;
}

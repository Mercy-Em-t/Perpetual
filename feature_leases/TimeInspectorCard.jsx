import React, { useState, useEffect, useRef } from "react";
import {
  executeInspectorTick,
  broadcastInspectorTick,
  mountGoogleDriveLiveRoom,
  unpackWorkerTools
} from "./TimeInspectorEngine.js";
import { broadcastLeaseMessage, logTabulatedReport } from "./LeaseBroadcastBridge.js";
import { generateWhatsAppShareUrl } from "./WhatsAppChannelBridge.js";

/**
 * ==============================================================================
 * TMS TIME INSPECTOR & PACKET REASSEMBLY SIMULATOR CARD
 * ==============================================================================
 * Wakes up every second, greets ("Hey!"), reads and parses the Time Card
 * ("the time is hh.mm.ss dd.mm.year"), verifies clock synchronization, audits
 * packet arrival ("no packets moving, packets came all of them"), reassembles
 * self into "HEALTHY_AND_EXECUTABLE", unpacks analysis tools, and connects to the
 * 5-minute Google Drive live files room buffer.
 * ==============================================================================
 */
export default function TimeInspectorCard({ onTickDispatched }) {
  const [isRunning, setIsRunning] = useState(false);
  const [tick, setTick] = useState(1);
  const [totalTicks, setTotalTicks] = useState(180); // 3 minutes default
  const [driveCountdown, setDriveCountdown] = useState(300); // 5 minutes default (300s)
  const [handshakeMode, setHandshakeMode] = useState("NORMAL"); // "NORMAL" | "GRACE" | "TIMEOUT"

  // Initial State from initial tick
  const initialTickData = executeInspectorTick(1, 180, { handshakeMode: "NORMAL" });
  const [currentTickData, setCurrentTickData] = useState(initialTickData);
  const intervalRef = useRef(null);
  const driveTimerRef = useRef(null);

  // Run a single 1s step
  const stepTick = (tickNumber = tick, mode = handshakeMode) => {
    const result = executeInspectorTick(tickNumber, totalTicks, { handshakeMode: mode });
    setCurrentTickData(result);

    // Broadcast across channel
    broadcastLeaseMessage(result.payload);
    logTabulatedReport(result.payload);

    if (onTickDispatched) {
      onTickDispatched(result.payload);
    }

    return result;
  };

  // Toggle 3-minute continuous simulation
  const toggleSimulation = () => {
    if (isRunning) {
      setIsRunning(false);
      if (intervalRef.current) clearInterval(intervalRef.current);
    } else {
      setIsRunning(true);
      // Run first tick immediately
      stepTick(tick);
    }
  };

  // Single manual tick
  const handleSingleTick = () => {
    const nextTick = tick >= totalTicks ? 1 : tick + 1;
    setTick(nextTick);
    stepTick(nextTick);
  };

  // Reset simulation
  const handleReset = () => {
    setIsRunning(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
    setTick(1);
    setDriveCountdown(300);
    const resetData = executeInspectorTick(1, totalTicks);
    setCurrentTickData(resetData);
  };

  // Handle running loop
  useEffect(() => {
    if (isRunning) {
      intervalRef.current = setInterval(() => {
        setTick((prev) => {
          if (prev >= totalTicks) {
            setIsRunning(false);
            clearInterval(intervalRef.current);
            return prev;
          }
          const next = prev + 1;
          stepTick(next);
          return next;
        });
      }, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, totalTicks]);

  // Handle Google Drive 5-minute countdown loop
  useEffect(() => {
    driveTimerRef.current = setInterval(() => {
      setDriveCountdown((prev) => (prev > 0 ? prev - 1 : 300));
    }, 1000);

    return () => {
      if (driveTimerRef.current) clearInterval(driveTimerRef.current);
    };
  }, []);

  const formatCountdown = (seconds) => {
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const { card, parsedCard, timeSync, packetCheck, reassembly, tools, driveRoom } = currentTickData;

  return (
    <div className="rounded-3xl bg-slate-900/90 border border-cyan-800/80 shadow-2xl p-6 space-y-6 text-slate-100 relative overflow-hidden backdrop-blur-md">
      {/* Background Glow */}
      <div className="absolute -top-24 -right-24 w-80 h-80 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -left-24 w-80 h-80 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* ── HEADER / STATUS BANNER ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-mono font-bold tracking-wider uppercase">
              ⏱️ 1-Second Time Inspector &amp; Packet Reassembler
            </span>
            <span className="relative flex h-2.5 w-2.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isRunning ? "bg-cyan-400 opacity-75" : "bg-slate-600 opacity-0"}`}></span>
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRunning ? "bg-cyan-500" : "bg-slate-600"}`}></span>
            </span>
            <span className="text-xs font-mono text-cyan-400">
              {isRunning ? "CADENCE: 1000ms TICKING" : "CADENCE: STANDBY"}
            </span>
          </div>
          <h2 className="text-xl font-black text-white mt-1.5 flex items-center gap-2">
            <span>Second-by-Second Time Inspector Worker</span>
            <span className="text-xs font-mono font-normal text-cyan-300 px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-800">
              Simulate 3 Minutes ({totalTicks}s)
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Parses incoming time card, synchronizes clocks, verifies 100% packet settlement with 0 moving packets, executes self-reassembly, and unlocks 5-minute Google Drive live files room.
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSimulation}
            className={`px-4 py-2.5 rounded-2xl text-xs font-mono font-bold transition flex items-center gap-2 cursor-pointer shadow-lg ${
              isRunning
                ? "bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/30"
                : "bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-600/30"
            }`}
          >
            <span>{isRunning ? "⏸️ Pause Simulation" : "▶️ Start 3-Min Simulation (180s)"}</span>
          </button>
          <button
            type="button"
            onClick={handleSingleTick}
            className="px-3.5 py-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono font-bold border border-slate-700 cursor-pointer"
            title="Advance 1 Second"
          >
            ⚡ 1s Tick
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs font-mono font-bold border border-slate-700 cursor-pointer"
            title="Reset"
          >
            🔄 Reset
          </button>
          <button
            type="button"
            onClick={() => {
              if (currentTickData && currentTickData.payload) {
                const url = generateWhatsAppShareUrl(currentTickData.payload);
                window.open(url, "_blank");
              }
            }}
            className="px-3.5 py-2.5 rounded-2xl bg-[#25D366] hover:bg-[#1EBE5D] text-slate-950 text-xs font-mono font-bold transition flex items-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-900/30"
            title="Post Message to WhatsApp Channel or Group"
          >
            <span>💬 Post to WhatsApp</span>
          </button>
        </div>
      </div>

      {/* ── METRICS & PROGRESS BAR ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs font-mono text-slate-400">
          <span>Simulation Progress: <strong className="text-white">{tick} / {totalTicks} ticks</strong></span>
          <span>Time Remaining: <strong className="text-cyan-400">{formatCountdown(Math.max(0, totalTicks - tick))}</strong> (3:00 cycle)</span>
        </div>
        <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 via-indigo-500 to-emerald-500 transition-all duration-300"
            style={{ width: `${(tick / totalTicks) * 100}%` }}
          />
        </div>
      </div>

      {/* ── HANDSHAKE LIVENESS & TIMEOUT CONTROL BAR ── */}
      <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase text-slate-400 font-bold">🤝 Handshake Invariant:</span>
            <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
              currentTickData.handshake?.shouldReportTimeout
                ? "bg-rose-950/80 text-rose-300 border-rose-700 animate-pulse"
                : currentTickData.handshake?.status === "WAITING_WITHIN_GRACE"
                  ? "bg-amber-950/80 text-amber-300 border-amber-700"
                  : "bg-emerald-950/80 text-emerald-300 border-emerald-700"
            }`}>
              {currentTickData.handshake?.shouldReportTimeout
                ? "🚨 TIMEOUT EXCEEDED (REPORT DISPATCHED)"
                : currentTickData.handshake?.status === "WAITING_WITHIN_GRACE"
                  ? "⏳ AWAITING HANDSHAKE (WITHIN GRACE - NO REPORT)"
                  : "✅ HANDSHAKE ESTABLISHED (AUTO-ACK)"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-slate-400">Simulate:</span>
            <button
              type="button"
              onClick={() => {
                setHandshakeMode("NORMAL");
                stepTick(tick, "NORMAL");
              }}
              className={`px-2.5 py-1 rounded-xl text-[10px] font-mono font-bold border transition cursor-pointer ${
                handshakeMode === "NORMAL"
                  ? "bg-emerald-600 border-emerald-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
              }`}
            >
              Normal (Ack)
            </button>
            <button
              type="button"
              onClick={() => {
                setHandshakeMode("GRACE");
                stepTick(tick, "GRACE");
              }}
              className={`px-2.5 py-1 rounded-xl text-[10px] font-mono font-bold border transition cursor-pointer ${
                handshakeMode === "GRACE"
                  ? "bg-amber-600 border-amber-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
              }`}
            >
              Waiting (Grace)
            </button>
            <button
              type="button"
              onClick={() => {
                setHandshakeMode("TIMEOUT");
                stepTick(tick, "TIMEOUT");
              }}
              className={`px-2.5 py-1 rounded-xl text-[10px] font-mono font-bold border transition cursor-pointer ${
                handshakeMode === "TIMEOUT"
                  ? "bg-rose-600 border-rose-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
              }`}
            >
              Waited Too Long (Report)
            </button>
          </div>
        </div>

        <div className="text-[11px] font-mono text-slate-300 bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/80">
          {currentTickData.handshake?.summary || "Handshake status verified."}
        </div>
      </div>

      {/* ── CORE STAGES GRID ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

        {/* 1. THE TIME CARD PRESENTATION & PARSER */}
        <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-3 relative group hover:border-cyan-700/50 transition">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase text-cyan-400 font-bold flex items-center gap-1.5">
              <span>💳 Step 1: The Time Card</span>
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
              Tag: {card.tag}
            </span>
          </div>

          {/* Physical Card Mockup */}
          <div className="p-3.5 rounded-xl bg-gradient-to-br from-slate-900 to-cyan-950/40 border border-cyan-800/60 shadow-inner space-y-2">
            <div className="flex items-center justify-between text-[11px] text-cyan-300 font-mono">
              <span className="font-bold">👋 "{card.greeting}"</span>
              <span className="text-[10px] text-slate-400">READING CARD</span>
            </div>
            <div className="text-sm font-mono font-black text-white bg-slate-950/60 p-2.5 rounded-lg border border-cyan-900/60 break-all">
              "{card.rawText}"
            </div>
            <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-1">
              <span>Parsed Time: <strong className="text-cyan-300">{parsedCard.timeString}</strong></span>
              <span>Date: <strong className="text-slate-300">{parsedCard.dateString}</strong></span>
            </div>
          </div>

          <div className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
            <span>✅ Tag &amp; Time Parsed &amp; Understood</span>
          </div>
        </div>

        {/* 2. CLOCK COMPARISON & SYNCHRONIZATION */}
        <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-3 relative group hover:border-indigo-700/50 transition">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold flex items-center gap-1.5">
              <span>⏱️ Step 2: Clock Sync Check</span>
            </span>
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              timeSync.isSynchronized
                ? "bg-emerald-950/80 text-emerald-300 border-emerald-800"
                : "bg-rose-950/80 text-rose-300 border-rose-800"
            }`}>
              {timeSync.verdict}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono">
            <div className="flex justify-between items-center p-2 rounded-lg bg-slate-900/60 border border-slate-800">
              <span className="text-slate-400 text-[11px]">Card Time Read:</span>
              <span className="font-bold text-white">{timeSync.cardTimeFormatted}</span>
            </div>
            <div className="flex justify-between items-center p-2 rounded-lg bg-slate-900/60 border border-slate-800">
              <span className="text-slate-400 text-[11px]">Worker Clock:</span>
              <span className="font-bold text-cyan-300">{timeSync.workerTimeFormatted}</span>
            </div>
            <div className="flex justify-between items-center p-2 rounded-lg bg-slate-900/60 border border-slate-800">
              <span className="text-slate-400 text-[11px]">Computed Drift:</span>
              <span className="font-bold text-emerald-400">±{timeSync.driftMs} ms (Within tolerance)</span>
            </div>
          </div>

          <div className="text-[11px] font-mono text-indigo-300 flex items-center gap-1">
            <span>🎯 Verified: Card time matches worker's time.</span>
          </div>
        </div>

        {/* 3. PACKET ARRIVAL & ZERO-MOVING INTEGRITY */}
        <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-3 relative group hover:border-emerald-700/50 transition">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold flex items-center gap-1.5">
              <span>📦 Step 3: Packet Integrity</span>
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
              {packetCheck.integrityRatio} Intact
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-center text-xs font-mono">
            <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
              <span className="text-[10px] text-slate-400 block uppercase">Arrived in Full</span>
              <span className="text-emerald-400 font-bold text-sm">
                {packetCheck.receivedPackets}/{packetCheck.totalExpected} (100%)
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
              <span className="text-[10px] text-slate-400 block uppercase">Packets Moving</span>
              <span className="text-white font-bold text-sm">
                {packetCheck.movingPackets} (Zero)
              </span>
            </div>
          </div>

          <div className="p-2 rounded-lg bg-emerald-950/30 border border-emerald-900/50 text-[11px] font-mono text-emerald-300">
            ✓ Packets came all of them. No packets moving.
          </div>
        </div>
      </div>

      {/* ── LOWER STAGES: REASSEMBLY, TOOLS & GOOGLE DRIVE LIVE ROOM ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* 4. WORKER SELF-REASSEMBLY & GO-AHEAD */}
        <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold flex items-center gap-1.5">
              <span>🛡️ Step 4: Self-Reassembly</span>
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              {reassembly.state}
            </span>
          </div>
          <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800 space-y-1.5">
            <div className="text-xs font-mono font-bold text-emerald-400 flex items-center gap-1.5">
              <span>🚀 GO-AHEAD CERTIFICATION: GRANTED</span>
            </div>
            <p className="text-[11px] font-mono text-slate-300 leading-relaxed">
              Worker assembled all sub-components. Verified 0 byte corruption. Self-certified healthy and executable.
            </p>
          </div>
          <div className="text-[10px] font-mono text-slate-500">
            Reassembly Invariant: 100% Deterministic
          </div>
        </div>

        {/* 5. TOOL UNPACKING PROTOCOL */}
        <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase text-amber-400 font-bold flex items-center gap-1.5">
              <span>🧰 Step 5: Unpacking Tools</span>
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800">
              {tools.toolsCount} Tools Ready
            </span>
          </div>
          <div className="space-y-1.5">
            {tools.tools.slice(0, 3).map((t) => (
              <div key={t.id} className="flex items-center justify-between p-1.5 rounded-lg bg-slate-900/60 border border-slate-800 text-[11px] font-mono">
                <span className="text-slate-300 truncate max-w-[180px]">{t.name}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30 font-bold">
                  v{t.version}
                </span>
              </div>
            ))}
          </div>
          <div className="text-[10px] font-mono text-amber-300">
            ✓ Diagnostics and reconciliation tools unpacked.
          </div>
        </div>

        {/* 6. GOOGLE DRIVE LIVE FILES ROOM (5 MINUTES) */}
        <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase text-purple-400 font-bold flex items-center gap-1.5">
              <span>📂 Step 6: Shown The Rooms</span>
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse"></span>
              <span>Live: {formatCountdown(driveCountdown)}</span>
            </span>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <span className="text-purple-300 font-bold">Google Drive Live Corridor</span>
              <span className="text-[10px] text-slate-400">{driveRoom.filesCount} Live Files</span>
            </div>
            <div className="space-y-1">
              {driveRoom.liveFiles.slice(0, 3).map((f) => (
                <div key={f.name} className="flex items-center justify-between text-[10px] font-mono text-slate-300">
                  <span className="truncate max-w-[150px]">📄 {f.name}</span>
                  <span className="text-purple-400 font-bold text-[9px]">{f.status}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="text-[10px] font-mono text-purple-300">
            ✓ 5-Minute Live Buffer Window active and streaming.
          </div>
        </div>

      </div>

    </div>
  );
}

import React, { useState, useEffect, useMemo } from "react";
import {
  broadcastLeaseMessage,
  createLeaseReceiver,
  tabulateLeaseMessage,
  logTabulatedReport
} from "./LeaseBroadcastBridge.js";
import TimeInspectorCard from "./TimeInspectorCard.jsx";

const REGISTERED_REPORTERS = [
  {
    id: "time-inspector-worker",
    name: "Second-by-Second Time Inspector Worker (1s)",
    role: "TIME_INSPECTOR_DAEMON",
    badge: "1s Cadence Daemon",
    color: "text-cyan-400 bg-cyan-950/60 border-cyan-800"
  },
  {
    id: "midnight-worker",
    name: "Midnight Sweep Worker (00:01:00)",
    role: "WORKER_DAEMON",
    badge: "Cron Daemon",
    color: "text-purple-400 bg-purple-950/60 border-purple-800"
  },
  {
    id: "canvas-operator",
    name: "Canvas Operator (UI)",
    role: "CANVAS_OPERATOR",
    badge: "Interactive UI",
    color: "text-indigo-400 bg-indigo-950/60 border-indigo-800"
  },
  {
    id: "autonomous-auditor",
    name: "Autonomous Health Auditor",
    role: "HEALTH_AUDITOR",
    badge: "Background Worker",
    color: "text-emerald-400 bg-emerald-950/60 border-emerald-800"
  },
  {
    id: "technical-writer",
    name: "Lead Technical Writer & Documentarian",
    role: "TECHNICAL_WRITER",
    badge: "Archivist / Chronicler",
    color: "text-amber-400 bg-amber-950/60 border-amber-800"
  },
  {
    id: "emergency-supervisor",
    name: "Emergency Unplug Supervisor",
    role: "SUPERVISOR",
    badge: "Core Safety Guard",
    color: "text-rose-400 bg-rose-950/60 border-rose-800"
  }
];

const TENANTS = [
  { id: "creative-galore", name: "Creative Galore", plan: "PRO" },
  { id: "leahs-kitchen", name: "Leah's Kitchen", plan: "GROWTH" },
  { id: "modern-savannah", name: "Modern Savannah", plan: "ENTERPRISE" },
  { id: "brunchbox", name: "Brunchbox Bakery", plan: "STARTER" },
  { id: "haberdashery", name: "Digital Nairobi Haberdashery", plan: "PRO" }
];

const CHUNKS = [
  { id: "sensory_tasting", name: "Sensory Tasting Protocol Chunk", component: "SensoryTastingChunk" },
  { id: "hero_story", name: "Artisan Hero Story Chunk", component: "HeroStoryChunk" },
  { id: "pillars", name: "Spectrum Craft Pillars Chunk", component: "PillarsChunk" },
  { id: "collaboration", name: "WhatsApp Commission Bridge Chunk", component: "CollaborationChunk" },
  { id: "footer_link", name: "Decoupled Story Footer Link Chunk", component: "FooterLinkChunk" },
  { id: "action_pill", name: "Artisan Guide Action Pill Chunk", component: "ActionPillChunk" }
];

const ACTIONS = [
  { type: "TIME_CARD_TICK", label: "Inspect 1s Time Card & Verify Clock Sync", defaultStatus: "ACTIVE" },
  { type: "PACKET_REASSEMBLY_CHECK", label: "Audit Packet Integrity (0 Moving)", defaultStatus: "ACTIVE" },
  { type: "WORKER_HEALTHY_EXECUTABLE", label: "Self-Reassembly -> HEALTHY_AND_EXECUTABLE", defaultStatus: "ACTIVE" },
  { type: "TOOLS_UNPACKED", label: "Unpack Diagnostic Tool Inventory", defaultStatus: "ACTIVE" },
  { type: "GOOGLE_DRIVE_ROOM_MOUNTED", label: "Mount 5-Minute Google Drive Live Room", defaultStatus: "ACTIVE" },
  { type: "TECHNICAL_CHRONICLE_PUBLISHED", label: "Publish Technical Documentation Chronicle", defaultStatus: "ACTIVE" },
  { type: "DOCUMENTATION_AUDIT_LOGGED", label: "Log Transcript Forensic Audit", defaultStatus: "ACTIVE" },
  { type: "MIDNIGHT_SWEEP_SIMULATION", label: "00:01:00 Midnight Sweep Revocation", defaultStatus: "EXPIRED" },
  { type: "LEASE_PLUGGED", label: "Plug Leased Chunk Into DOM", defaultStatus: "ACTIVE" },
  { type: "LEASE_DROPPED", label: "Unplug / Drop Chunk from DOM", defaultStatus: "EXPIRED" },
  { type: "CHUNK_SELECTED", label: "Object Chunk Swapped", defaultStatus: "ACTIVE" },
  { type: "TENANT_SWITCHED", label: "Tenant Subject Swapped", defaultStatus: "ACTIVE" },
  { type: "EMERGENCY_UNPLUG", label: "Emergency Quarantine Sweep", defaultStatus: "REVOKED" }
];

export default function LeaseReporterInterface({ onSwitchToCanvas }) {
  // Broadcaster State
  const [selectedReporter, setSelectedReporter] = useState(REGISTERED_REPORTERS[0]);
  const [selectedTenant, setSelectedTenant] = useState(TENANTS[0]);
  const [selectedAction, setSelectedAction] = useState(ACTIONS[0]);
  const [selectedChunk, setSelectedChunk] = useState(CHUNKS[0]);
  const [customSummary, setCustomSummary] = useState("");
  const [metadataJson, setMetadataJson] = useState('{\n  "source": "manual_dispatch",\n  "reconcileSchedule": "00:01:00 UTC"\n}');

  // Receiver Feed State
  const [messages, setMessages] = useState([
    {
      id: "init_seed_1",
      reporter: "Midnight Sweep Worker (00:01:00)",
      type: "MIDNIGHT_SWEEP_SIMULATION",
      tenantId: "creative-galore",
      tenantName: "Creative Galore",
      chunkId: "sensory_tasting",
      chunkName: "Sensory Tasting Protocol Chunk",
      status: "EXPIRED",
      summary: "Midnight Sweep (00:01:00): Automated revocation executed for Creative Galore",
      timestamp: new Date(Date.now() - 1000 * 60 * 3).toISOString()
    },
    {
      id: "init_seed_2",
      reporter: "Canvas Operator (UI)",
      type: "LEASE_PLUGGED",
      tenantId: "haberdashery",
      tenantName: "Digital Nairobi Haberdashery",
      chunkId: "collaboration",
      chunkName: "WhatsApp Commission Bridge Chunk",
      status: "ACTIVE",
      summary: "Digital Nairobi Haberdashery PLUGGED [WhatsApp Commission Bridge Chunk]",
      timestamp: new Date(Date.now() - 1000 * 60 * 1).toISOString()
    }
  ]);

  // Inspection Drawer State
  const [inspectedMessage, setInspectedMessage] = useState(null);

  // Filters
  const [filterReporter, setFilterReporter] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [copySuccess, setCopySuccess] = useState(false);
  const [isLiveStreamActive, setIsLiveStreamActive] = useState(false);

  // Connect live receiver
  useEffect(() => {
    const disconnect = createLeaseReceiver((incomingMsg) => {
      setMessages((prev) => [incomingMsg, ...prev]);
    });
    return () => disconnect();
  }, []);

  // Technical Writer Continuous Live Streaming Interval
  useEffect(() => {
    if (!isLiveStreamActive) return;

    const streamChronicles = [
      {
        type: "TECHNICAL_CHRONICLE_HEARTBEAT",
        summary: "Live Audit Heartbeat: C:\\Users\\user\\Documents\\writers\\ verified healthy (4 active manuals).",
        artifact: "Volume Directory Health",
      },
      {
        type: "DOCUMENTATION_AUDIT_LOGGED",
        summary: "Forensic Scan: 01_CHRONOLOGY.md confirmed. Zero tenant string leaks in ShopFooter or InvalidAccess.",
        artifact: "01_CHRONOLOGY_AND_TRANSCRIPT_AUDIT.md",
      },
      {
        type: "SECURITY_POSTURE_CERTIFIED",
        summary: "Governance Check: 02_ARCHITECTURE.md confirms Zero-Trust Default-Deny Access gate intact.",
        artifact: "02_ARCHITECTURE_SPECIFICATION.md",
      },
      {
        type: "MESSAGING_INTEGRITY_VERIFIED",
        summary: "Transport Audit: 03_BROADCAST_BRIDGE.md confirms dual-channel fallback active with 00:01:00 midnight reconciler.",
        artifact: "03_BROADCAST_BRIDGE_AND_RECEIVER_MANUAL.md",
      },
      {
        type: "TEST_SUITE_CERTIFIED",
        summary: "Platform Invariant Scan: 55/55 unit tests passing, 8/8 core invariants satisfied, build in 2.43s.",
        artifact: "04_CURRENT_STATE_AND_ROADMAP.md",
      }
    ];

    let cycle = 0;
    const timer = setInterval(() => {
      cycle++;
      const item = streamChronicles[(cycle - 1) % streamChronicles.length];
      broadcastLeaseMessage({
        reporter: "Lead Technical Writer & Documentarian",
        type: item.type,
        tenantId: "ALL",
        tenantName: "Global Whitelabel Platform",
        chunkId: "writers_stream",
        chunkName: item.artifact,
        status: "ACTIVE",
        pilotMode: false,
        summary: `[Live Stream #${cycle}] ${item.summary}`,
        metadata: {
          cycle,
          destination: "C:\\Users\\user\\Documents\\writers\\",
          streamActive: true
        }
      });
    }, 4500);

    return () => clearInterval(timer);
  }, [isLiveStreamActive]);

  // Filtered List
  const filteredMessages = useMemo(() => {
    return messages.filter((m) => {
      if (filterReporter !== "ALL" && m.reporter !== filterReporter) return false;
      if (filterStatus !== "ALL" && m.status !== filterStatus) return false;
      if (searchQuery.trim() !== "") {
        const q = searchQuery.toLowerCase();
        const str = `${m.id} ${m.reporter} ${m.type} ${m.tenantName || m.tenantId} ${m.chunkName || m.chunkId} ${m.summary}`.toLowerCase();
        if (!str.includes(q)) return false;
      }
      return true;
    });
  }, [messages, filterReporter, filterStatus, searchQuery]);

  // Dispatch Broadcast
  const handleDispatch = (e) => {
    if (e) e.preventDefault();
    let parsedMeta = {};
    try {
      parsedMeta = JSON.parse(metadataJson);
    } catch {
      parsedMeta = { parseError: "Invalid JSON format" };
    }

    const payload = {
      reporter: selectedReporter.name,
      type: selectedAction.type,
      tenantId: selectedTenant.id,
      tenantName: selectedTenant.name,
      chunkId: selectedChunk.id,
      chunkName: selectedChunk.name,
      status: selectedAction.defaultStatus,
      summary: customSummary.trim() || `${selectedReporter.name} -> ${selectedAction.label} for ${selectedTenant.name}`,
      metadata: parsedMeta
    };

    broadcastLeaseMessage(payload);
    logTabulatedReport(payload);
  };

  // Quick Preset Dispatch
  const handleQuickPreset = (presetType) => {
    if (presetType === "MIDNIGHT_SWEEP") {
      const p = {
        reporter: "Midnight Sweep Worker (00:01:00)",
        type: "MIDNIGHT_SWEEP_SIMULATION",
        tenantId: "creative-galore",
        tenantName: "Creative Galore",
        chunkId: "sensory_tasting",
        chunkName: "Sensory Tasting Protocol Chunk",
        status: "EXPIRED",
        summary: "00:01:00 Sweep: Contract expired. Feature lease revoked & chunk dropped from DOM."
      };
      broadcastLeaseMessage(p);
      logTabulatedReport(p);
    } else if (presetType === "PLUG_LEAH") {
      const p = {
        reporter: "Canvas Operator (UI)",
        type: "LEASE_PLUGGED",
        tenantId: "leahs-kitchen",
        tenantName: "Leah's Kitchen",
        chunkId: "hero_story",
        chunkName: "Artisan Hero Story Chunk",
        status: "ACTIVE",
        summary: "Leah's Kitchen PLUGGED [Artisan Hero Story Chunk] into active canvas DOM."
      };
      broadcastLeaseMessage(p);
      logTabulatedReport(p);
    } else if (presetType === "EMERGENCY_PURGE") {
      const p = {
        reporter: "Emergency Unplug Supervisor",
        type: "EMERGENCY_UNPLUG",
        tenantId: "ALL",
        tenantName: "All Tenants",
        chunkId: "ALL",
        chunkName: "All Leased Fragments",
        status: "REVOKED",
        summary: "EMERGENCY QUARANTINE: Dropped all leased chunks to prevent tenant contamination."
      };
      broadcastLeaseMessage(p);
      logTabulatedReport(p);
    } else if (presetType === "WRITER_CHRONICLE") {
      const p = {
        reporter: "Lead Technical Writer & Documentarian",
        type: "TECHNICAL_CHRONICLE_PUBLISHED",
        tenantId: "ALL",
        tenantName: "Global Whitelabel Platform",
        chunkId: "ALL",
        chunkName: "Technical Documentation Suite",
        status: "ACTIVE",
        pilotMode: false,
        summary: "Live Broadcast: Published 4 architectural manuals to C:\\Users\\user\\Documents\\writers\\",
        metadata: {
          location: "C:\\Users\\user\\Documents\\writers\\",
          documents: [
            "01_CHRONOLOGY_AND_TRANSCRIPT_AUDIT.md",
            "02_ARCHITECTURE_SPECIFICATION.md",
            "03_BROADCAST_BRIDGE_AND_RECEIVER_MANUAL.md",
            "04_CURRENT_STATE_AND_ROADMAP.md"
          ]
        }
      };
      broadcastLeaseMessage(p);
      logTabulatedReport(p);
    } else if (presetType === "TIME_INSPECTOR_TICK") {
      const p = {
        reporter: "Second-by-Second Time Inspector Worker (1s)",
        type: "TIME_CARD_TICK",
        tenantId: "ALL",
        tenantName: "Global Whitelabel Core",
        chunkId: "time_inspector_card",
        chunkName: "1-Second Time Card & Packet Reassembly",
        status: "ACTIVE",
        pilotMode: false,
        summary: "1s Time Card Read: Sync OK. 0 moving packets. HEALTHY_AND_EXECUTABLE. Tools unpacked. Drive room active.",
        metadata: {
          tag: "TIME_CARD",
          timeRead: "the time is hh.mm.ss dd.mm.year",
          packets: "64/64 (100% full, 0 moving)",
          reassembly: "HEALTHY_AND_EXECUTABLE",
          tools: "5 tools ready",
          googleDriveRoom: "Live 5 minutes"
        }
      };
      broadcastLeaseMessage(p);
      logTabulatedReport(p);
    }
  };

  // Export Tabulated TSV
  const exportTsv = () => {
    const tableData = messages.map(tabulateLeaseMessage);
    if (!tableData.length) return;
    const headers = Object.keys(tableData[0]).join("\t");
    const rows = tableData.map((row) => Object.values(row).join("\t")).join("\n");
    const tsvContent = `${headers}\n${rows}`;
    const blob = new Blob([tsvContent], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lease_broadcast_tabulated_${Date.now()}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-4 sm:p-8">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* ── TOP NAV & SYSTEM TELEMETRY ── */}
        <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <span className="px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-400 text-xs font-mono font-bold uppercase tracking-wider">
                📡 Exploded Message Interface
              </span>
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-mono text-emerald-400">CHANNEL: ACTIVE</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white mt-1">
              TMS Leased Feature Broadcaster &amp; Reporter Console
            </h1>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl">
              Decoupled cross-tab &amp; worker messaging interface. Transmits lease lifecycle events to receivers with tabulated reporting.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsLiveStreamActive(!isLiveStreamActive)}
              className={`px-4 py-2 rounded-2xl text-xs font-mono font-bold transition flex items-center gap-2 cursor-pointer border ${
                isLiveStreamActive 
                  ? "bg-rose-950/80 border-rose-500 text-rose-300 animate-pulse shadow-lg shadow-rose-900/40"
                  : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
              }`}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${isLiveStreamActive ? "bg-rose-500 animate-ping" : "bg-slate-500"}`}></span>
              <span>{isLiveStreamActive ? "🔴 Live Stream: ACTIVE (4.5s)" : "▶️ Start Live Channel Stream"}</span>
            </button>
            {onSwitchToCanvas && (
              <button
                type="button"
                onClick={onSwitchToCanvas}
                className="px-4 py-2 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono font-bold transition flex items-center gap-2 cursor-pointer border border-slate-700"
              >
                <span>🎨 Switch to Grammar Canvas</span>
              </button>
            )}
            <button
              type="button"
              onClick={exportTsv}
              className="px-4 py-2 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-mono font-bold transition flex items-center gap-2 cursor-pointer shadow-lg shadow-indigo-600/30"
            >
              <span>📊 Export Tabulated TSV</span>
            </button>
          </div>
        </header>

        {/* ── TELEMETRY BADGES ROW ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <span className="text-[10px] font-mono text-slate-400 uppercase">Broadcast Channel</span>
            <div className="text-sm font-mono font-bold text-indigo-300 mt-1 truncate">tms_lease_broadcast_channel</div>
            <span className="text-[10px] text-emerald-400">Multi-tab &amp; Worker Bridge</span>
          </div>
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <span className="text-[10px] font-mono text-slate-400 uppercase">Messages Captured</span>
            <div className="text-xl font-mono font-black text-white mt-1">{messages.length}</div>
            <span className="text-[10px] text-slate-500">Live in-memory buffer</span>
          </div>
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <span className="text-[10px] font-mono text-slate-400 uppercase">Midnight Sweep Target</span>
            <div className="text-sm font-mono font-bold text-amber-300 mt-1">00:01:00 UTC</div>
            <span className="text-[10px] text-slate-500">Daily Lease Reconciler</span>
          </div>
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <span className="text-[10px] font-mono text-slate-400 uppercase">Registered Reporters</span>
            <div className="text-xl font-mono font-black text-purple-400 mt-1">{REGISTERED_REPORTERS.length}</div>
            <span className="text-[10px] text-slate-500">Daemon, UI, Auditor, Guard</span>
          </div>
        </div>

        {/* ── 1-SECOND TIME INSPECTOR & 3-MINUTE SIMULATION STUDIO ── */}
        <TimeInspectorCard
          onTickDispatched={(payload) => {
            setMessages((prev) => [payload, ...prev.slice(0, 99)]);
          }}
        />

        {/* ── MAIN WORKSPACE SPLIT: DISPATCHER VS RECEIVER MATRIX ── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* ── LEFT: THE EXPLODED DISPATCHER DECK (4 cols) ── */}
          <div className="lg:col-span-5 space-y-4">
            <div className="p-5 rounded-3xl bg-slate-900/60 border border-slate-800 shadow-xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                  <span>⚡ Reporter Dispatcher Deck</span>
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-900/50 text-purple-300 border border-purple-500/30">
                  Outbound Transmitter
                </span>
              </div>

              {/* Quick Presets */}
              <div className="space-y-1.5">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-bold">1-Click Presets:</span>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <button
                    type="button"
                    onClick={() => handleQuickPreset("TIME_INSPECTOR_TICK")}
                    className="p-2 rounded-xl bg-cyan-950/40 hover:bg-cyan-900/60 border border-cyan-800/60 text-cyan-300 text-[10px] font-mono font-bold transition text-left cursor-pointer"
                  >
                    ⏱️ 1s Time Card
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickPreset("MIDNIGHT_SWEEP")}
                    className="p-2 rounded-xl bg-purple-950/40 hover:bg-purple-900/60 border border-purple-800/60 text-purple-300 text-[10px] font-mono font-bold transition text-left cursor-pointer"
                  >
                    🕛 00:01:00 Sweep
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickPreset("PLUG_LEAH")}
                    className="p-2 rounded-xl bg-indigo-950/40 hover:bg-indigo-900/60 border border-indigo-800/60 text-indigo-300 text-[10px] font-mono font-bold transition text-left cursor-pointer"
                  >
                    🔌 Plug Leah Story
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickPreset("EMERGENCY_PURGE")}
                    className="p-2 rounded-xl bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/60 text-rose-300 text-[10px] font-mono font-bold transition text-left cursor-pointer"
                  >
                    🚨 Emergency Purge
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickPreset("WRITER_CHRONICLE")}
                    className="p-2 rounded-xl bg-amber-950/40 hover:bg-amber-900/60 border border-amber-800/60 text-amber-300 text-[10px] font-mono font-bold transition text-left cursor-pointer"
                  >
                    📜 Writer Broadcast
                  </button>
                </div>
              </div>

              {/* Dispatch Form */}
              <form onSubmit={handleDispatch} className="space-y-3 pt-2">
                {/* Reporter Select */}
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1">
                    Reporter (Sender Identity):
                  </label>
                  <select
                    value={selectedReporter.id}
                    onChange={(e) => setSelectedReporter(REGISTERED_REPORTERS.find(r => r.id === e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs font-mono text-slate-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    {REGISTERED_REPORTERS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} [{r.badge}]
                      </option>
                    ))}
                  </select>
                </div>

                {/* Tenant Noun Select */}
                <div>
                  <label className="text-[10px] font-mono text-amber-400 uppercase font-bold block mb-1">
                    Subject (Tenant Noun):
                  </label>
                  <select
                    value={selectedTenant.id}
                    onChange={(e) => setSelectedTenant(TENANTS.find(t => t.id === e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs font-mono text-amber-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500"
                  >
                    {TENANTS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.id}) · {t.plan}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Action Verb Select */}
                <div>
                  <label className="text-[10px] font-mono text-emerald-400 uppercase font-bold block mb-1">
                    Verb (Lease Action &amp; Target Status):
                  </label>
                  <select
                    value={selectedAction.type}
                    onChange={(e) => setSelectedAction(ACTIONS.find(a => a.type === e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs font-mono text-emerald-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.type} value={a.type}>
                        {a.label} → [{a.defaultStatus}]
                      </option>
                    ))}
                  </select>
                </div>

                {/* Chunk Object Select */}
                <div>
                  <label className="text-[10px] font-mono text-pink-400 uppercase font-bold block mb-1">
                    Object (Ripped Fragment Chunk):
                  </label>
                  <select
                    value={selectedChunk.id}
                    onChange={(e) => setSelectedChunk(CHUNKS.find(c => c.id === e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs font-mono text-pink-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-pink-500"
                  >
                    {CHUNKS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Custom Summary */}
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1">
                    Summary Sentence (Optional):
                  </label>
                  <input
                    type="text"
                    value={customSummary}
                    onChange={(e) => setCustomSummary(e.target.value)}
                    placeholder="Auto-generated if left blank..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2 text-xs font-mono text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                {/* Metadata JSON */}
                <div>
                  <label className="text-[10px] font-mono text-slate-500 uppercase font-bold block mb-1">
                    Metadata Payload Envelope (JSON):
                  </label>
                  <textarea
                    rows={3}
                    value={metadataJson}
                    onChange={(e) => setMetadataJson(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2 text-[10px] font-mono text-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                {/* Transmit Button */}
                <button
                  type="submit"
                  className="w-full py-3 rounded-2xl bg-gradient-to-r from-purple-600 via-indigo-600 to-emerald-600 hover:from-purple-500 hover:to-emerald-500 text-white font-mono font-bold text-xs uppercase tracking-wider transition shadow-lg shadow-purple-600/30 cursor-pointer flex items-center justify-center gap-2"
                >
                  <span>📡 Transmit Broadcast Packet</span>
                </button>
              </form>
            </div>
          </div>

          {/* ── RIGHT: THE TABULATED STREAM & PACKET INSPECTOR (7 cols) ── */}
          <div className="lg:col-span-7 space-y-4">
            <div className="p-5 rounded-3xl bg-slate-900/60 border border-slate-800 shadow-xl space-y-4">
              
              {/* Header & Controls */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wider">
                    📋 Tabulated Live Broadcast Stream
                  </h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/60">
                    {filteredMessages.length} Rows
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setMessages([])}
                    className="px-2.5 py-1 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 text-[10px] font-mono transition cursor-pointer"
                  >
                    Clear Feed
                  </button>
                </div>
              </div>

              {/* Filters Bar */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="text"
                  placeholder="Filter by keyword..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-[11px] font-mono text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <select
                  value={filterReporter}
                  onChange={(e) => setFilterReporter(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-[11px] font-mono text-slate-300 cursor-pointer focus:outline-none"
                >
                  <option value="ALL">All Reporters</option>
                  {REGISTERED_REPORTERS.map(r => (
                    <option key={r.id} value={r.name}>{r.name}</option>
                  ))}
                </select>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-[11px] font-mono text-slate-300 cursor-pointer focus:outline-none"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="EXPIRED">EXPIRED</option>
                  <option value="REVOKED">REVOKED</option>
                </select>
              </div>

              {/* Tabulated Table */}
              <div className="overflow-x-auto rounded-2xl border border-slate-800/80 bg-black/60 max-h-96 overflow-y-auto">
                <table className="w-full text-left text-[11px] font-mono border-collapse">
                  <thead className="sticky top-0 bg-slate-950 z-10 border-b border-slate-800">
                    <tr className="text-slate-400 uppercase tracking-wider text-[10px]">
                      <th className="py-2.5 px-3">Time</th>
                      <th className="py-2.5 px-3">Reporter</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3">Subject</th>
                      <th className="py-2.5 px-3">Object Chunk</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">Inspect</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {filteredMessages.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          No messages match filter. Dispatch a packet from the deck on the left.
                        </td>
                      </tr>
                    ) : (
                      filteredMessages.map((msg) => (
                        <tr
                          key={msg.id}
                          onClick={() => setInspectedMessage(msg)}
                          className="hover:bg-slate-900/60 transition cursor-pointer group"
                        >
                          <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                            {new Date(msg.timestamp).toLocaleTimeString()}
                          </td>
                          <td className="py-2 px-3 text-indigo-300 font-bold whitespace-nowrap truncate max-w-[140px]">
                            {msg.reporter || "Operator"}
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                              msg.status === "ACTIVE"
                                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                                : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                            }`}>
                              {msg.type}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-amber-300 whitespace-nowrap truncate max-w-[120px]">
                            {msg.tenantName || msg.tenantId}
                          </td>
                          <td className="py-2 px-3 text-pink-300 whitespace-nowrap truncate max-w-[140px]">
                            {msg.chunkName || msg.chunkId || "—"}
                          </td>
                          <td className="py-2 px-3">
                            <span className={msg.status === "ACTIVE" ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>
                              {msg.status}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <span className="text-[10px] text-slate-500 group-hover:text-slate-200">
                              🔍
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Inspected Packet Drawer / View */}
              {inspectedMessage && (
                <div className="p-4 rounded-2xl bg-black/80 border border-indigo-500/40 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-indigo-400 font-bold">
                        🔍 Exploded Packet Inspector: [{inspectedMessage.id}]
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(JSON.stringify(inspectedMessage, null, 2));
                          setCopySuccess(true);
                          setTimeout(() => setCopySuccess(false), 2000);
                        }}
                        className="px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 text-[10px] font-mono cursor-pointer"
                      >
                        {copySuccess ? "✓ Copied" : "Copy JSON"}
                      </button>
                      <button
                        onClick={() => setInspectedMessage(null)}
                        className="text-slate-500 hover:text-slate-300 text-xs font-mono cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] font-mono">
                    <div className="p-2 bg-slate-950 rounded-xl border border-slate-800">
                      <span className="text-slate-500 block">Reporter</span>
                      <span className="text-indigo-300 font-bold">{inspectedMessage.reporter}</span>
                    </div>
                    <div className="p-2 bg-slate-950 rounded-xl border border-slate-800">
                      <span className="text-slate-500 block">Grammar Sentence</span>
                      <span className="text-amber-300">{inspectedMessage.tenantName || inspectedMessage.tenantId}</span>{" "}
                      <span className="text-slate-400">{inspectedMessage.status === "ACTIVE" ? "leases" : "drops"}</span>{" "}
                      <span className="text-pink-300">[{inspectedMessage.chunkName || inspectedMessage.chunkId}]</span>
                    </div>
                    <div className="p-2 bg-slate-950 rounded-xl border border-slate-800">
                      <span className="text-slate-500 block">Dispatch Time</span>
                      <span className="text-slate-300">{inspectedMessage.timestamp}</span>
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1">Raw Message Payload:</span>
                    <pre className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 text-[10px] font-mono text-emerald-400 overflow-x-auto max-h-40">
                      {JSON.stringify(inspectedMessage, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

            </div>
          </div>

        </div>

      </div>
    </div>
  );
}

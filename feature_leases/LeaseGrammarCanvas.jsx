import React, { useState, useEffect } from 'react';
import {
  HeroStoryChunk,
  PillarsChunk,
  SensoryTastingChunk,
  CollaborationChunk,
  FooterLinkChunk,
  ActionPillChunk
} from './chunks/index.js';
import {
  PreorderGraceBannerWidget,
  KitchenPrepDigestBoard,
  MerchantDishStockToggle
} from '../../tenants/leahs-kitchen/components/index.js';
import { broadcastLeaseMessage, createLeaseReceiver } from './LeaseBroadcastBridge.js';
import LeaseReporterInterface from './LeaseReporterInterface.jsx';

// Tenant Presets available as Nouns in our Grammar
const TENANT_NOUNS = [
  {
    id: "creative-galore",
    name: "Creative Galore",
    industry: "crafts",
    pilotMode: true,
    theme: { primary: "#EC4899", secondary: "#A855F7", bg: "#0F0728" },
    defaultSamples: [
      { name: 'Milk Cotton', desc: 'Anti-pilling, ultra-soft' },
      { name: 'Organic Bamboo', desc: 'Silky sheen & cool drape' },
      { name: 'Pure Merino', desc: 'Natural elastic warmth' },
    ]
  },
  {
    id: "leahs-kitchen",
    name: "Leah's Kitchen",
    industry: "food",
    pilotMode: true,
    theme: { primary: "#F97316", secondary: "#C2410C", bg: "#0F0804" },
    defaultSamples: [
      { name: 'Artisan Sourdough', desc: 'Naturally fermented loaf' },
      { name: 'Vanilla Bean Choux', desc: 'Bourbon vanilla cream filling' },
      { name: 'Kenya Highlands Blend', desc: 'Medium roast cold brew' },
    ]
  },
  {
    id: "brunchbox",
    name: "Brunchbox (Hot & Tasty)",
    industry: "food",
    pilotMode: true,
    theme: { primary: "#F59E0B", secondary: "#3A2318", bg: "#0B0F17" },
    defaultSamples: [
      { name: 'Cold-Brew Roast', desc: 'Single-origin Kenyan Arabica' },
      { name: 'Brioche Tasting', desc: 'French butter artisan mini-loaf' },
      { name: 'Berry Glaze Sample', desc: 'Organic Naivasha strawberries' },
    ]
  },
  {
    id: "haberdashery",
    name: "Digital Nairobi Haberdashery",
    industry: "textile",
    pilotMode: true,
    theme: { primary: "#10B981", secondary: "#065F46", bg: "#061A14" },
    defaultSamples: [
      { name: 'Maasai Shúkà', desc: '100% heavy weave acrylic wool' },
      { name: 'Kikoy Swatch', desc: 'Combed coastal cotton striping' },
      { name: 'Ankara Wax Swatch', desc: 'Genuine Dutch wax block print' },
    ]
  },
  {
    id: "modern-savannah",
    name: "Modern Savannah (Enterprise)",
    industry: "textile",
    pilotMode: false,
    theme: { primary: "#0EA5E9", secondary: "#0369A1", bg: "#041424" },
    defaultSamples: [
      { name: 'Savannah Silk Twill', desc: 'Hand-screened Nairobi motif' },
      { name: 'Highlands Linen Blend', desc: 'Breathable structured drape' },
      { name: 'Meru Cashmere Soft', desc: 'Ultra-luxurious warmth' },
    ]
  }
];

// Available Chunks acting as Noun 2 (The Object)
const CHUNK_NOUNS = [
  { id: "kitchen_prep", name: "KitchenPrepDigestBoard", label: "👩🏾‍🍳 Kitchen Prep & WhatsApp Command Board", component: KitchenPrepDigestBoard },
  { id: "grace_banner", name: "PreorderGraceBannerWidget", label: "⚡ 15m Soft-Landing Grace Banner", component: PreorderGraceBannerWidget },
  { id: "stock_toggle", name: "MerchantDishStockToggle", label: "🎛️ Real-Time Dish Stock Cap Toggle", component: MerchantDishStockToggle },
  { id: "hero", name: "HeroStoryChunk", label: "🌸 Hero Story Banner", component: HeroStoryChunk },
  { id: "pillars", name: "PillarsChunk", label: "🏛️ 3 Spectrum Pillars", component: PillarsChunk },
  { id: "tasting", name: "SensoryTastingChunk", label: "🧶 Sensory Tasting Protocol", component: SensoryTastingChunk },
  { id: "collab", name: "CollaborationChunk", label: "💬 WhatsApp Commission Bridge", component: CollaborationChunk },
  { id: "footer", name: "FooterLinkChunk", label: "📖 Ripped Footer Link Fragment", component: FooterLinkChunk },
  { id: "pill", name: "ActionPillChunk", label: "✨ Menu Custom Action Pill", component: ActionPillChunk }
];

export default function LeaseGrammarCanvas() {
  const [activeView, setActiveView] = useState("CANVAS"); // "CANVAS" | "EXPLODED_INTERFACE"
  const [selectedTenant, setSelectedTenant] = useState(TENANT_NOUNS[0]);
  const [selectedChunk, setSelectedChunk] = useState(CHUNK_NOUNS[2]); // Default to Sensory Tasting
  const [leaseStatus, setLeaseStatus] = useState("ACTIVE"); // "ACTIVE" | "EXPIRED"
  const [isPilotMode, setIsPilotMode] = useState(true); // Default to true (Pilot Mode ON): Enforces DEFAULT DENY ACCESS security posture
  const [inboxMessages, setInboxMessages] = useState([
    {
      id: "init_1",
      reporter: "Lease System Init",
      type: "BROADCASTER_READY",
      summary: "Broadcast channel initialized. DEFAULT DENY ACCESS security posture active.",
      timestamp: new Date().toISOString(),
      status: "ACTIVE"
    }
  ]);

  useEffect(() => {
    const disconnect = createLeaseReceiver((msg) => {
      setInboxMessages((prev) => [msg, ...prev].slice(0, 10));
    });
    return () => disconnect();
  }, []);

  const handleTogglePilotMode = (forcedState) => {
    const nextState = forcedState !== undefined ? forcedState : !isPilotMode;
    setIsPilotMode(nextState);
    broadcastLeaseMessage({
      reporter: "Pilot Governance Guard",
      type: "PILOT_MODE_TOGGLED",
      tenantId: selectedTenant.id,
      tenantName: selectedTenant.name,
      chunkId: selectedChunk.id,
      chunkName: selectedChunk.name,
      status: leaseStatus,
      pilotMode: nextState,
      summary: nextState
        ? `Pilot Mode switched ON: Leased features suppressed into dormant quarantine.`
        : `Pilot Mode switched OFF (Commercial): Leased feature condition SATISFIED - chunk visible!`
    });
  };

  const handleUpdateLease = (newStatus, chunk = selectedChunk, tenant = selectedTenant) => {
    setLeaseStatus(newStatus);
    broadcastLeaseMessage({
      reporter: "Canvas Operator (UI)",
      type: newStatus === "ACTIVE" ? "LEASE_PLUGGED" : "LEASE_DROPPED",
      tenantId: tenant.id,
      tenantName: tenant.name,
      chunkId: chunk.id,
      chunkName: chunk.name,
      status: newStatus,
      pilotMode: isPilotMode,
      summary: `${tenant.name} ${newStatus === "ACTIVE" ? "PLUGGED" : "DROPPED"} [${chunk.name}]`
    });
  };

  const handleSelectChunk = (chunk) => {
    setSelectedChunk(chunk);
    broadcastLeaseMessage({
      reporter: "Canvas Operator (UI)",
      type: "CHUNK_SELECTED",
      tenantId: selectedTenant.id,
      tenantName: selectedTenant.name,
      chunkId: chunk.id,
      chunkName: chunk.name,
      status: leaseStatus,
      pilotMode: isPilotMode,
      summary: `Selected [${chunk.name}] for ${selectedTenant.name}`
    });
  };

  const handleSelectTenant = (tenant) => {
    setSelectedTenant(tenant);
    broadcastLeaseMessage({
      reporter: "Canvas Operator (UI)",
      type: "TENANT_SWITCHED",
      tenantId: tenant.id,
      tenantName: tenant.name,
      chunkId: selectedChunk.id,
      chunkName: selectedChunk.name,
      status: leaseStatus,
      pilotMode: isPilotMode,
      summary: `Active Subject Noun switched to ${tenant.name}`
    });
  };

  const ActiveComponent = selectedChunk.component;

  if (activeView === "EXPLODED_INTERFACE") {
    return <LeaseReporterInterface onSwitchToCanvas={() => setActiveView("CANVAS")} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="border-b border-slate-800 pb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 text-xs font-mono uppercase tracking-widest mb-2">
              <span>🧪 TMS Leased Feature Sandbox</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              The Leased Story Canvas &amp; Grammar Engine
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-xl">
              Ported fragments from ripped components. Compose modular leased features using functional grammar: <span className="text-amber-400 font-mono font-bold">[Subject: Tenant]</span> + <span className="text-emerald-400 font-mono font-bold">[Verb: Leases]</span> + <span className="text-pink-400 font-mono font-bold">[Object: Chunk]</span>.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setActiveView("EXPLODED_INTERFACE")}
              className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-mono font-bold transition flex items-center gap-2 cursor-pointer shadow-lg shadow-purple-600/30"
            >
              <span>📡 Explode to Interface</span>
            </button>
            <a
              href="/"
              className="text-xs font-bold text-slate-400 hover:text-white px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 transition"
            >
              ← Back to App
            </a>
          </div>
        </header>

        {/* ── THE GRAMMAR BAR (Noun + Verb + Noun/Chunk) ── */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-4">
          <div className="text-xs font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
            <span>📐 Composable Feature Sentence:</span>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            {/* NOUN 1 (Subject / Tenant) */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase font-mono text-amber-400 font-bold">Subject (Tenant Noun)</span>
              <select
                value={selectedTenant.id}
                onChange={(e) => handleSelectTenant(TENANT_NOUNS.find(t => t.id === e.target.value))}
                className="bg-amber-950/40 border border-amber-500/40 text-amber-200 px-4 py-2.5 rounded-2xl font-bold text-xs cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                {TENANT_NOUNS.map(t => (
                  <option key={t.id} value={t.id} className="bg-slate-900 text-white">
                    {t.name} ({t.industry})
                  </option>
                ))}
              </select>
            </div>

            {/* GOVERNANCE CONDITION (Pilot Mode Gate - Default Deny Access) */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase font-mono text-rose-400 font-bold">Policy: Default Deny Access</span>
              <button
                type="button"
                onClick={() => handleTogglePilotMode(!isPilotMode)}
                className={`px-3 py-2 rounded-2xl text-xs font-mono font-bold transition border cursor-pointer flex items-center gap-1.5 ${
                  !isPilotMode 
                    ? "bg-emerald-950/60 border-emerald-500/50 text-emerald-200 hover:bg-emerald-900/60" 
                    : "bg-rose-950/60 border-rose-500/50 text-rose-200 hover:bg-rose-900/60"
                }`}
              >
                <span>{!isPilotMode ? "🟢 Access Granted (Pilot OFF)" : "⛔ DEFAULT: DENY ACCESS (Pilot ON)"}</span>
              </button>
            </div>

            {/* VERB (Lease State) */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase font-mono text-emerald-400 font-bold">Verb (Lease Agreement)</span>
              <div className="flex rounded-2xl overflow-hidden border border-emerald-500/40 bg-emerald-950/30 p-1">
                <button
                  type="button"
                  onClick={() => handleUpdateLease("ACTIVE")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-black transition cursor-pointer ${
                    leaseStatus === "ACTIVE" 
                      ? "bg-emerald-500 text-slate-950 shadow-md" 
                      : "text-emerald-300 hover:bg-emerald-500/20"
                  }`}
                >
                  LEASES (🟢 Active)
                </button>
                <button
                  type="button"
                  onClick={() => handleUpdateLease("EXPIRED")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-black transition cursor-pointer ${
                    leaseStatus === "EXPIRED" 
                      ? "bg-rose-500 text-white shadow-md" 
                      : "text-rose-300 hover:bg-rose-500/20"
                  }`}
                >
                  EXPIRES (🔴 Terminated)
                </button>
              </div>
            </div>

            {/* NOUN 2 (Object / The Ripped Chunk) */}
            <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
              <span className="text-[10px] uppercase font-mono text-pink-400 font-bold">Object (Ripped Chunk Plug)</span>
              <select
                value={selectedChunk.id}
                onChange={(e) => handleSelectChunk(CHUNK_NOUNS.find(c => c.id === e.target.value))}
                className="bg-pink-950/40 border border-pink-500/40 text-pink-200 px-4 py-2.5 rounded-2xl font-bold text-xs cursor-pointer focus:outline-none focus:ring-2 focus:ring-pink-500"
              >
                {CHUNK_NOUNS.map(c => (
                  <option key={c.id} value={c.id} className="bg-slate-900 text-white">
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Natural Language Sentence Preview */}
          <div className="mt-3 p-3 bg-black/40 rounded-2xl border border-slate-800 text-xs font-mono text-slate-300 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <span className="text-slate-500">Sentence: </span>
              <span className="text-amber-400 font-bold">"{selectedTenant.name}"</span>
              <span className="text-slate-400"> {leaseStatus === "ACTIVE" ? "currently leases" : "has terminated lease of"} </span>
              <span className="text-pink-400 font-bold">[{selectedChunk.name}]</span>
              <span className="text-slate-400"> (reconciled daily at 00:01:00).</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                !isPilotMode ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
              }`}>
                {!isPilotMode ? "Policy: Access Authorized" : "Policy: Default Deny Access"}
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                (!isPilotMode && leaseStatus === "ACTIVE") ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
              }`}>
                {(!isPilotMode && leaseStatus === "ACTIVE") ? "Rendered on Canvas" : "Quarantined / Denied"}
              </span>
            </div>
          </div>
        </section>

        {/* ── BROADCAST RECEIVER MONITOR (Receives Message & Broadcasts to Receiver) ── */}
        <section className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-slate-300">
                📡 Message Broadcaster &amp; Receiver Channel (Active)
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  broadcastLeaseMessage({
                    reporter: "Midnight Sweep Worker (00:01:00)",
                    type: "MIDNIGHT_SWEEP_SIMULATION",
                    tenantId: selectedTenant.id,
                    tenantName: selectedTenant.name,
                    chunkId: selectedChunk.id,
                    chunkName: selectedChunk.name,
                    status: "EXPIRED",
                    pilotMode: isPilotMode,
                    summary: `Midnight Sweep (00:01:00): Automated revocation executed for ${selectedTenant.name}`
                  });
                }}
                className="px-3 py-1 rounded-xl bg-purple-900/50 hover:bg-purple-800 text-purple-200 border border-purple-500/30 text-[10px] font-mono font-bold transition cursor-pointer"
              >
                ⚡ Trigger Midnight Broadcast
              </button>
              <span className="text-[10px] font-mono text-slate-500">
                {inboxMessages.length} Messages Captured
              </span>
            </div>
          </div>

          {/* Tabulated Message Report Table */}
          <div className="overflow-x-auto rounded-2xl border border-slate-800/80 bg-black/50">
            <table className="w-full text-left text-[11px] font-mono border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400 uppercase tracking-wider text-[10px]">
                  <th className="py-2 px-3">Time</th>
                  <th className="py-2 px-3">Reporter (Sender)</th>
                  <th className="py-2 px-3">Action / Type</th>
                  <th className="py-2 px-3">Tenant (Subject)</th>
                  <th className="py-2 px-3">Chunk (Object)</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {inboxMessages.map((msg) => (
                  <tr key={msg.id} className="hover:bg-slate-900/50 transition">
                    <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2 px-3 text-indigo-300 font-bold whitespace-nowrap">
                      {msg.reporter || "Lease Operator"}
                    </td>
                    <td className="py-2 px-3">
                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                        msg.status === "ACTIVE" 
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" 
                          : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                      }`}>
                        {msg.type}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-amber-300 whitespace-nowrap">
                      {msg.tenantName || msg.tenantId || "ALL"}
                    </td>
                    <td className="py-2 px-3 text-pink-300 whitespace-nowrap">
                      {msg.chunkName || msg.chunkId || "—"}
                    </td>
                    <td className="py-2 px-3">
                      <span className={msg.status === "ACTIVE" ? "text-emerald-400" : "text-rose-400 font-bold"}>
                        {msg.status || "—"}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-300 truncate max-w-xs">
                      {msg.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── THE LIVE CANVAS STAGE ── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 uppercase tracking-wider font-bold">
              🎨 Live Canvas Render Stage:
            </span>
            <div className="flex items-center gap-3">
              <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                !isPilotMode ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
              }`}>
                {!isPilotMode ? "Condition Met: Pilot Mode is OFF (Visible)" : "Condition Unmet: Pilot Mode is ON (Suppressed)"}
              </span>
              <span className="text-xs text-slate-500">
                Theme: {selectedTenant.theme.primary}
              </span>
            </div>
          </div>

          <div 
            className="rounded-3xl p-6 sm:p-10 border transition-all duration-300 min-h-[300px] flex items-center justify-center relative overflow-hidden"
            style={{ 
              backgroundColor: selectedTenant.theme.bg,
              borderColor: (!isPilotMode && leaseStatus === "ACTIVE") ? `${selectedTenant.theme.primary}40` : "#334155" 
            }}
          >
            {/* CONDITION 1: PILOT MODE IS ON -> DEFAULT: DENY ACCESS GATE */}
            {isPilotMode ? (
              <div className="text-center py-12 px-6 space-y-4 max-w-lg mx-auto animate-fade-in-up">
                {/* Security Shield Icon */}
                <div className="w-16 h-16 rounded-3xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-3xl mx-auto shadow-inner text-rose-400">
                  🛡️
                </div>

                {/* Default Deny Access Badges */}
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <span className="px-3 py-1 rounded-full bg-rose-500/10 border border-rose-500/40 text-rose-400 text-xs font-mono font-black uppercase tracking-wider">
                    ⛔ POLICY: DEFAULT DENY ACCESS
                  </span>
                  <span className="px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-mono font-bold uppercase tracking-wider">
                    Pilot Mode Active
                  </span>
                </div>

                <h3 className="text-xl font-black text-white uppercase tracking-wider">
                  Access Denied (Quarantine Gate)
                </h3>

                <p className="text-xs text-slate-400 leading-relaxed max-w-md mx-auto">
                  By TMS zero-trust security invariant, all unvetted leased features are set to <span className="text-rose-400 font-bold font-mono">DEFAULT DENY ACCESS</span>. 
                  During active pilot mode, experimental and leased story chunks cannot leak into shared tenant views.
                </p>

                {/* Audit Grid */}
                <div className="p-3.5 bg-black/60 rounded-2xl border border-slate-800 text-[11px] font-mono text-left space-y-1.5 shadow-inner">
                  <div className="flex justify-between text-slate-400">
                    <span>Gate Policy:</span>
                    <span className="text-rose-400 font-bold">DEFAULT DENY ACCESS</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Required Condition:</span>
                    <span className="text-cyan-300 font-bold">Pilot Mode == OFF</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Target Tenant:</span>
                    <span className="text-amber-300">{selectedTenant.name}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Target Chunk:</span>
                    <span className="text-pink-300">{selectedChunk.name}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Current Access State:</span>
                    <span className="text-rose-400 font-bold uppercase">403 Blocked / Quarantined</span>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => handleTogglePilotMode(false)}
                    className="px-6 py-3 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-mono font-bold text-xs uppercase tracking-wider transition cursor-pointer shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-2 mx-auto"
                  >
                    <span>🔓 Authorize Access (Turn Pilot Mode OFF)</span>
                  </button>
                </div>
              </div>
            ) : leaseStatus === "ACTIVE" ? (
              /* CONDITION 2: PILOT MODE IS OFF AND LEASE IS ACTIVE -> RENDER FEATURE */
              <div className="w-full animate-fade-in-up">
                {/* Dynamically instantiate chunk noun */}
                {selectedChunk.id === "hero" && (
                  <HeroStoryChunk
                    badge={`🌸 ${selectedTenant.name} Story`}
                    headlinePrefix={selectedTenant.industry === "food" ? "Artisan Baking with Passion." : "Handmade with Intent."}
                    headlineGradient={selectedTenant.industry === "food" ? "Crafted Daily for Nairobi Foodies." : "Crafted for the Modern Maker."}
                    bio={`Created to celebrate the authentic essence of ${selectedTenant.name}. Experience our fresh offerings crafted with care.`}
                    theme={selectedTenant.theme}
                  />
                )}

                {selectedChunk.id === "pillars" && (
                  <PillarsChunk
                    spectrumTitle={selectedTenant.industry === "food" ? "Three Ways to Taste Our Kitchen" : "Three Ways to Experience the Craft"}
                    pillars={selectedTenant.industry === "food" ? [
                      { emoji: "🥐", title: "Daily Fresh Bakes", desc: "Warm pastries baked before dawn using pure French butter.", badge: "✓ Same-day boda delivery" },
                      { emoji: "☕", title: "Specialty Brews", desc: "Cold-press roasts and handcrafted botanical syrups.", badge: "✓ Freshly brewed daily" },
                      { emoji: "📦", title: "Artisan Brunch Boxes", desc: "Curated picnic and corporate catering boxes for any occasion.", badge: "✓ Custom menu customization" }
                    ] : undefined}
                  />
                )}

                {selectedChunk.id === "tasting" && (
                  <SensoryTastingChunk
                    protocolTitle={selectedTenant.industry === "food" ? "🍽️ Chef's Tasting Protocol" : "🧶 The Tasting Protocol"}
                    heading={selectedTenant.industry === "food" ? "What is a Culinary Tasting Box?" : "What is a \"Tasting\" Palette Card?"}
                    description={selectedTenant.industry === "food" 
                      ? "Sampling food before large catering orders shouldn't be stressful. Our tasting boxes let you sample our mini artisan bites before booking:"
                      : undefined}
                    samples={selectedTenant.defaultSamples}
                    price={selectedTenant.industry === "food" ? "KES 450" : "KES 650"}
                    itemName={selectedTenant.industry === "food" ? "Chef's Tasting Box" : "Sensory Palette Card"}
                  />
                )}

                {selectedChunk.id === "collab" && (
                  <CollaborationChunk
                    promptTitle={selectedTenant.industry === "food" ? "Catering or Custom Cake in Mind?" : "Have a Custom Project in Mind?"}
                    promptText={selectedTenant.industry === "food" 
                      ? "Need custom event catering, private brunch sets, or branded corporate pastries? Reach out to our head chef directly on WhatsApp."
                      : undefined}
                    shopName={selectedTenant.name}
                  />
                )}

                {selectedChunk.id === "footer" && (
                  <div className="text-center py-8">
                    <FooterLinkChunk
                      label={`📖 ${selectedTenant.name} • Leased Story Guide`}
                      color={selectedTenant.theme.primary}
                    />
                  </div>
                )}

                {selectedChunk.id === "pill" && (
                  <div className="text-center py-8">
                    <ActionPillChunk
                      label={`✨ Leased Action: Explore ${selectedTenant.name}`}
                      className="bg-amber-500/20 text-amber-300 border border-amber-400/30 hover:bg-amber-500/30"
                    />
                  </div>
                )}
              </div>
            ) : (
              /* CONDITION 3: PILOT MODE IS OFF BUT LEASE IS EXPIRED */
              <div className="text-center py-16 px-4 space-y-4 max-w-md mx-auto animate-fade-in-up">
                <div className="w-16 h-16 rounded-3xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-3xl mx-auto shadow-inner text-rose-400">
                  🚫
                </div>
                <h3 className="text-lg font-black text-slate-200 uppercase tracking-wider">
                  Feature Lease Terminated
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Pilot Mode is OFF, but chunk <span className="font-mono text-pink-300">[{selectedChunk.name}]</span> has expired and was unplugged by the Midnight Reconciler.
                </p>
                <div className="p-3 bg-black/50 rounded-xl border border-slate-800 text-[11px] font-mono text-slate-400">
                  Status: Dropped from active DOM · Zero contamination
                </div>
                <button
                  type="button"
                  onClick={() => setLeaseStatus("ACTIVE")}
                  className="px-5 py-2.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs uppercase tracking-wider transition cursor-pointer"
                >
                  Renew Lease (Plug Back In)
                </button>
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}

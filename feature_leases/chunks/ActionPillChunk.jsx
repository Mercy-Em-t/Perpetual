import React from 'react';

/**
 * [CHUNK NOUN: ActionPillChunk]
 * Ripped directly from creative-galore/tenant.config.ts line 41:
 * `{ id: "studio-story", label: "✨ Studio Story & Guide", path: "/story" }`
 */
export default function ActionPillChunk({
  label = "✨ Studio Story & Guide",
  className = "bg-purple-900/60 hover:bg-purple-800 text-purple-200 border border-purple-400/30",
  onClick = () => alert("Leased Action Pill triggered!")
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-xs font-bold transition-all shadow-md active:scale-95 cursor-pointer flex items-center gap-2 ${className}`}
    >
      <span>{label}</span>
    </button>
  );
}

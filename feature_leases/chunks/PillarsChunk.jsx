import React from 'react';

/**
 * [CHUNK NOUN: PillarsChunk]
 * Ripped directly from original ShopStory.jsx (Three Ways to Experience the Craft).
 * Configurable pillars that plug into the sentence as an Object/Noun.
 */
export default function PillarsChunk({
  spectrumTitle = "Three Ways to Experience the Craft",
  pillars = [
    {
      emoji: "🪡",
      title: "DIY Beginner & Project Kits",
      desc: "Everything you need to learn or start a project in one curated box: smooth milk cotton skeins, ergonomic color-coded hooks, stitch markers, and video walkthrough guides.",
      badge: "✓ Ready to unbox & stitch"
    },
    {
      emoji: "📄",
      title: "Digital Custom Patterns",
      desc: "For independent crafters worldwide. Download comprehensive PDFs complete with row-by-row stitch counts, color charts, and video links delivered directly to your WhatsApp.",
      badge: "✓ Instant delivery via WhatsApp & Email"
    },
    {
      emoji: "✨",
      title: "Artisan Ready-Made Pieces",
      desc: "Love the handmade aesthetic but short on time? Our finished tote bags and amigurumi plushies are 100% hand-crocheted by artisan makers in Nairobi with lined interiors and reinforced seams.",
      badge: "✓ Heirloom quality craftsmanship"
    }
  ]
}) {
  return (
    <section className="py-6 px-4 my-4">
      <div className="text-center mb-6">
        <span className="text-[10px] font-bold text-pink-400 uppercase tracking-widest">Our Spectrum</span>
        <h3 className="text-xl sm:text-2xl font-black text-white mt-1">{spectrumTitle}</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
        {pillars.map((p, idx) => (
          <div key={idx} className="bg-[#170E33] border border-purple-500/20 rounded-2xl p-5 shadow-xl flex flex-col justify-between">
            <div>
              <div className="text-2xl mb-3">{p.emoji}</div>
              <h4 className="text-base font-bold text-white mb-2">{p.title}</h4>
              <p className="text-xs text-purple-200/70 leading-relaxed">{p.desc}</p>
            </div>
            <div className="mt-4 pt-3 border-t border-purple-500/10 text-[10px] font-mono text-pink-300">
              {p.badge}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

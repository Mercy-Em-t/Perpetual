import React from 'react';

/**
 * [CHUNK NOUN: HeroStoryChunk]
 * Ripped directly from original ShopStory.jsx.
 * Can plug into any tenant canvas.
 */
export default function HeroStoryChunk({
  badge = "🌸 The Artisan Journey",
  headlinePrefix = "Handmade with Intent.",
  headlineGradient = "Crafted for the Modern Maker.",
  bio = "Created to celebrate the tactile joy of slow craft. From thoughtfully assembled beginner kits to bespoke digital patterns and natural tastings, we believe everyone has a maker inside them.",
  theme = { primary: "#EC4899", secondary: "#A855F7" }
}) {
  return (
    <section className="relative overflow-hidden py-12 px-6 rounded-3xl bg-[#120727]/90 border border-purple-500/20 text-center my-4 shadow-2xl">
      <div 
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full blur-3xl pointer-events-none opacity-25"
        style={{ backgroundColor: theme.primary }}
      />
      <span 
        className="inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest mb-3 border"
        style={{ 
          backgroundColor: `${theme.primary}20`, 
          color: theme.primary,
          borderColor: `${theme.primary}40` 
        }}
      >
        {badge}
      </span>
      <h2 className="text-2xl sm:text-4xl font-black text-white tracking-tight mb-4 leading-tight">
        {headlinePrefix}<br />
        <span 
          className="bg-clip-text text-transparent"
          style={{ backgroundImage: `linear-gradient(to right, ${theme.primary}, ${theme.secondary})` }}
        >
          {headlineGradient}
        </span>
      </h2>
      <p className="text-xs sm:text-sm text-purple-200/80 max-w-xl mx-auto leading-relaxed">
        {bio}
      </p>
    </section>
  );
}

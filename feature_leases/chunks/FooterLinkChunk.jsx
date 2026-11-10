import React from 'react';

/**
 * [CHUNK NOUN: FooterLinkChunk]
 * Ripped directly from ShopFooter.jsx line 42:
 * `<a href="/s/${shop.slug}/story" className="shop-footer__link text-pink-400 font-bold hover:underline">📖 Our Story & Yarn Guide</a>`
 */
export default function FooterLinkChunk({
  label = "📖 Our Story & Yarn Guide",
  color = "#F472B6",
  href = "#",
  onClick = (e) => { e.preventDefault(); alert("Footer story chunk clicked!"); }
}) {
  return (
    <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-700/50 inline-block my-2">
      <span className="text-[10px] text-slate-400 block font-mono mb-1">Ripped Footer Fragment:</span>
      <a 
        href={href} 
        onClick={onClick}
        className="text-xs font-bold hover:underline cursor-pointer transition-all"
        style={{ color: color }}
      >
        {label}
      </a>
    </div>
  );
}

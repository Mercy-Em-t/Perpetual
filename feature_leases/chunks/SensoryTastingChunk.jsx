import React from 'react';

/**
 * [CHUNK NOUN: SensoryTastingChunk]
 * Ripped directly from original ShopStory.jsx (The Yarn Tasting Protocol).
 * Demonstrates an interactive leased experience card.
 */
export default function SensoryTastingChunk({
  protocolTitle = "🧶 The Tasting Protocol",
  heading = "What is a \"Tasting\" Palette Card?",
  description = "Buying materials or food online can feel like a gamble. You can't feel the texture or taste the secret recipe before placing a large order. Our physical sample palette lets you sample, touch, and test before committing:",
  samples = [
    { name: 'Milk Cotton', desc: 'Anti-pilling, ultra-soft' },
    { name: 'Organic Bamboo', desc: 'Silky sheen & cool drape' },
    { name: 'Pure Merino', desc: 'Natural elastic warmth' },
    { name: 'Velvet Chenille', desc: 'Plush cloud texture' },
    { name: 'Linen-Cotton', desc: 'Durable heirloom structure' },
    { name: 'Brushed Alpaca', desc: 'Feathery luxury halo' }
  ],
  price = "KES 650",
  itemName = "Sensory Tasting Kit",
  onOrder = () => alert("Tasting Kit ordered through sandbox bridge!")
}) {
  return (
    <section className="py-6 px-4 max-w-5xl mx-auto my-4">
      <div className="bg-gradient-to-r from-[#1B0F38] via-[#2A1452] to-[#160A2C] border border-purple-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl relative">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          <div className="space-y-3 max-w-lg">
            <span className="inline-block px-3 py-1 rounded-full bg-pink-500/20 text-pink-300 border border-pink-400/30 text-xs font-bold uppercase tracking-wider">
              {protocolTitle}
            </span>
            <h3 className="text-xl sm:text-2xl font-black text-white">{heading}</h3>
            <p className="text-xs text-purple-200/80 leading-relaxed">{description}</p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pt-2">
              {samples.map((item, idx) => (
                <div key={idx} className="bg-black/30 border border-purple-500/20 p-2 rounded-xl">
                  <span className="block text-xs font-bold text-white">{item.name}</span>
                  <span className="text-[10px] text-purple-300/70">{item.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[#120727] p-5 rounded-2xl border border-purple-500/20 text-center w-full lg:w-64 shadow-xl flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-mono text-purple-300/70 uppercase">Specialty Experience</span>
              <h4 className="text-base font-black text-white mt-1">{itemName}</h4>
              <div className="text-2xl font-black text-pink-400 my-2">{price}</div>
              <p className="text-[10px] text-purple-200/60 mb-4">
                Includes 6 physical mini-swatches, hook gauge ruler & care guide.
              </p>
            </div>

            <button
              onClick={onOrder}
              className="w-full py-2.5 rounded-xl bg-pink-500 hover:bg-pink-600 text-white font-bold text-xs uppercase tracking-wider transition shadow-lg shadow-pink-900/40 cursor-pointer"
            >
              Order Sample Kit
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

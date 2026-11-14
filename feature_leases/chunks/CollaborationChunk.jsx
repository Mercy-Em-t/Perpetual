import React from 'react';

/**
 * [CHUNK NOUN: CollaborationChunk]
 * Ripped directly from original ShopStory.jsx (WhatsApp Custom Commission Block).
 */
export default function CollaborationChunk({
  promptTitle = "Have a Custom Project in Mind?",
  promptText = "Looking for a custom colorway, bridesmaid gift sets, or personalized patterns? We'd love to collaborate with you.",
  phone = "254700000000",
  shopName = "Our Studio"
}) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(`Hi ${shopName}! I would like to ask about custom orders.`)}`;

  return (
    <section className="py-8 px-6 max-w-4xl mx-auto text-center border-t border-purple-500/10 my-4">
      <h3 className="text-xl sm:text-2xl font-black text-white mb-2">{promptTitle}</h3>
      <p className="text-xs text-purple-200/70 max-w-md mx-auto mb-5 leading-relaxed">
        {promptText}
      </p>

      <a
        href={waUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#25D366] hover:bg-[#1EBE5D] text-slate-900 font-black text-xs uppercase tracking-wider transition shadow-lg cursor-pointer"
      >
        <span>💬 Chat on WhatsApp</span>
      </a>
    </section>
  );
}

/**
 * Comprehensive Passive Ambient Intelligence Engine
 * Implements All 4 Core "Read & Act" Superpowers:
 *  1. Automatic M-Pesa SMS Reconciler (Zero-Friction Cashiering with 💳 reaction & confirmation card)
 *  2. Passive Order Notes & Shelf Locations (Packaging tracking with 📦 reaction & zero spam)
 *  3. Automatic Rider / Courier Assignment (Logistics handoffs with 🚚 reaction & zero spam)
 *  4. Product Photo Ingestion (Auto-download, Supabase Storage upload, catalog listing & 📸 reaction)
 */
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { resolveGroupContext, resolveShopOrder } from "./tenant_resolver.mjs";
import { formatDisplayOrderId } from "./command_handler.mjs";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.mjs";

const dbHdrs = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

/**
 * Extracts order reference candidates from natural staff conversation.
 */
export function extractOrderReferences(text) {
  if (!text) return [];
  const candidates = new Set();

  // 1. Explicit hash hex: #832f, #832f1b75, #5B0CD3F1
  const hashMatches = text.match(/#([0-9a-fA-F]{4,8})\b/g);
  if (hashMatches) {
    hashMatches.forEach(m => candidates.add(m.replace(/^#/, "").toLowerCase()));
  }

  // 2. "Order <id>" or "Order #<id>" or "Order no <id>"
  const orderMatches = text.match(/\b(?:order|ord)\s*(?:#|no\.?|num(?:ber)?)?\s*([0-9a-fA-F]{4,8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|ORD-[A-Z0-9]+-[0-9]+-[A-Z0-9]+)\b/gi);
  if (orderMatches) {
    orderMatches.forEach(m => {
      const clean = m.replace(/^(?:order|ord)\s*(?:#|no\.?|num(?:ber)?)?\s*/i, "").trim().toLowerCase();
      candidates.add(clean);
    });
  }

  // 3. Enterprise order format: ORD-DNH-261027-9K4E
  const ordMatches = text.match(/\b(ORD-[A-Z0-9]+-[0-9]+-[A-Z0-9]+)\b/gi);
  if (ordMatches) {
    ordMatches.forEach(m => candidates.add(m.trim().toUpperCase()));
  }

  // 4. Standalone 8-hex string if accompanied by logistics keywords
  if (/\b(?:shelf|pack|packed|dispatch|rider|courier|pickup|ready|deliver|box|hold)\b/i.test(text)) {
    const standaloneHex = text.match(/\b([0-9a-fA-F]{8})\b/g);
    if (standaloneHex) {
      standaloneHex.forEach(m => candidates.add(m.toLowerCase()));
    }
  }

  return Array.from(candidates);
}

/**
 * Parses raw Safaricom M-Pesa SMS confirmation text.
 */
export function parseMpesaSms(text) {
  if (!text || !/confirmed/i.test(text)) return null;

  // Regex 1: "QK8192HK10 Confirmed. Ksh 2,600 received from..." or "QA26E2E99 Confirmed. Ksh650.00 received..."
  const standardMatch = text.match(/\b([A-Z0-9]{8,12})\s+Confirmed\.?\s*(?:Ksh\.?|KES\.?)?\s*([0-9,]+(?:\.[0-9]{2})?)\s+received/i);
  if (standardMatch) {
    return {
      code: standardMatch[1].toUpperCase(),
      amount: parseFloat(standardMatch[2].replace(/,/g, ""))
    };
  }

  // Regex 2: "You have received Ksh 1,200.00 from... Reference: QK8192HK10"
  const altMatch = text.match(/received\s+(?:Ksh\.?|KES\.?)?\s*([0-9,]+(?:\.[0-9]{2})?).*?(?:Ref(?:erence)?|Code)?[:\s]+([A-Z0-9]{8,12})\b/is);
  if (altMatch) {
    return {
      code: altMatch[2].toUpperCase(),
      amount: parseFloat(altMatch[1].replace(/,/g, ""))
    };
  }

  // Regex 3: General code + amount proximity
  const code = text.match(/\b([A-Z0-9]{8,12})\b/);
  const amount = text.match(/(?:ksh\.?|kes\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  if (code && amount) {
    return {
      code: code[1].toUpperCase(),
      amount: parseFloat(amount[1].replace(/,/g, ""))
    };
  }

  return null;
}

/**
 * Parses product metadata from an uploaded image caption.
 */
export function parseProductCaption(caption) {
  if (!caption) return null;
  const clean = caption.trim().replace(/^new\s+arrival\s*[:\-]?\s*/i, "");

  // Extract price
  const priceMatch = clean.match(/(?:(?:kes|ksh|sh|@)\.?\s*([0-9,]+(?:\.[0-9]{2})?)|(?:^|[\s\-,:])([0-9,]{3,}(?:\.[0-9]{2})?)\s*(?:kes|ksh|sh|bob)?(?=[\s\-,:]|$))/i);
  if (!priceMatch) {
    return { name: clean, price: null, category: "General" };
  }

  const rawNum = (priceMatch[1] || priceMatch[2]).replace(/,/g, "");
  const price = parseFloat(rawNum);

  // Extract name: text before the price or first delimiter
  let namePart = clean;
  if (priceMatch.index > 0) {
    namePart = clean.slice(0, priceMatch.index);
  } else {
    namePart = clean.replace(priceMatch[0], "");
  }
  namePart = namePart.replace(/^[\s\-:,|]+|[\s\-:,|]+$/g, "").trim();

  // Extract optional category if separated by comma or dash after price
  let category = "General";
  const remaining = clean.slice(priceMatch.index + priceMatch[0].length).replace(/^[\s\-:,|]+|[\s\-:,|]+$/g, "").trim();
  const currencyWords = ["bob", "kes", "ksh", "sh", "shillings"];
  if (remaining && remaining.length > 2 && !currencyWords.includes(remaining.toLowerCase())) {
    category = remaining;
  }

  return {
    name: namePart || "New Product",
    price: price,
    category: category
  };
}

/**
 * Uploads an image buffer to Supabase Storage in the public 'product-images' bucket.
 */
export async function uploadProductImageToStorage(shopId, filename, buffer, mimeType = "image/jpeg") {
  const objectPath = `${shopId}/${filename}`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/product-images/${objectPath}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": mimeType
    },
    body: buffer
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Storage upload failed (${res.status}): ${errText}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/product-images/${objectPath}`;
}

/**
 * Main Ambient Intelligence Message Processor
 */
export async function handlePassiveGroupMessage(rawText, remoteJid, senderId, msg, safeReactMessage, safeSendMessage, sock) {
  try {
    const context = await resolveGroupContext(remoteJid);
    const shop = context.shop || null;
    const callerName = senderId ? senderId.replace(/@.*$/, "") : "Staff";
    const now = new Date();
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const messageKey = msg.key;

    // =========================================================================
    // SUPERPOWER 1: Automatic M-Pesa SMS Reconciler (Zero-Friction Cashiering)
    // =========================================================================
    const mpesa = parseMpesaSms(rawText);
    if (mpesa && shop) {
      console.log(`[PASSIVE RECONCILER] Detected M-Pesa SMS in ${shop.name}: Ref ${mpesa.code}, Amount KES ${mpesa.amount}`);

      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?shop_id=eq.${shop.id}&status=eq.pending&total_price=eq.${mpesa.amount}&order=created_at.desc&limit=5`, { headers: dbHdrs });
      const candidates = await res.json();

      if (Array.isArray(candidates) && candidates.length > 0) {
        const orderToSettle = candidates[0];
        const displayId = formatDisplayOrderId(orderToSettle);
        const updatedNotes = orderToSettle.notes 
          ? `${orderToSettle.notes}\n• [${timeStr} @${callerName}]: Auto-settled via M-Pesa SMS (${mpesa.code})`
          : `• [${timeStr} @${callerName}]: Auto-settled via M-Pesa SMS (${mpesa.code})`;

        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderToSettle.id}`, {
          method: "PATCH",
          headers: { ...dbHdrs, "Prefer": "return=minimal" },
          body: JSON.stringify({
            status: "paid",
            internal_status: "PAID",
            mpesa_code: mpesa.code,
            notes: updatedNotes
          })
        });

        console.log(`[PASSIVE RECONCILER] Settled Order #${orderToSettle.id.slice(0, 8)} for ${shop.name} with M-Pesa ${mpesa.code}`);

        // 1. Emoji reaction on the SMS
        if (safeReactMessage && messageKey) {
          await safeReactMessage(remoteJid, messageKey, "💳");
        }

        // 2. High-confidence confirmation card for cashier peace of mind
        if (safeSendMessage) {
          await safeSendMessage(remoteJid, {
            text: `💳 *Payment Auto-Reconciled — ${shop.name}*\n` +
                  `• Order: *${displayId}* (${orderToSettle.client_name || "Guest Customer"})\n` +
                  `• Ref: \`${mpesa.code}\` | Amount: *KES ${Number(mpesa.amount).toLocaleString()}*\n` +
                  `• Status: *PAID & SETTLED* ✅\n` +
                  `• Next Station: \`!pack ${orderToSettle.id.slice(0, 8)}\``
          });
        }
        return;
      }
    }

    // =========================================================================
    // SUPERPOWER 4: Product Photo Ingestion (Passive Photo Processing)
    // =========================================================================
    const hasImage = Boolean(msg.message?.imageMessage);
    if (hasImage && shop) {
      console.log(`[PASSIVE PHOTO] Inbound product photo detected in ${shop.name} from @${callerName}`);

      const caption = rawText || "";
      const parsed = parseProductCaption(caption);

      if (!parsed || parsed.price === null) {
        // Photo received without price: tap question emoji and prompt
        if (safeReactMessage && messageKey) {
          await safeReactMessage(remoteJid, messageKey, "❓");
        }
        if (safeSendMessage) {
          const itemName = parsed?.name || "New Item";
          await safeSendMessage(remoteJid, {
            text: `📸 *Photo Received for "${itemName}"!*\n` +
                  `To auto-list this product on your storefront, please reply with the price:\n` +
                  `_Example: "KES 1,800"_`
          });
        }
        return;
      }

      // Download image binary from WhatsApp CDN
      try {
        let buffer = null;
        if (sock && typeof downloadMediaMessage === "function") {
          buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { reuploadRequest: sock.updateMediaMessage }
          );
        }

        if (buffer) {
          const timestamp = Date.now();
          const cleanName = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);
          const filename = `prod_${timestamp}_${cleanName}.jpg`;

          // Upload to Supabase Storage CDN
          const publicUrl = await uploadProductImageToStorage(shop.id, filename, buffer, "image/jpeg");

          // Insert into Supabase products table
          const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/products`, {
            method: "POST",
            headers: { ...dbHdrs, "Prefer": "return=representation" },
            body: JSON.stringify({
              business_id: shop.id,
              name: parsed.name,
              description: `Uploaded via WhatsApp by @${callerName}`,
              price: parsed.price,
              category: parsed.category,
              image_url: publicUrl
            })
          });

          const insertedRows = await insertRes.json();
          const p = insertedRows?.[0];

          // React with camera emoji
          if (safeReactMessage && messageKey) {
            await safeReactMessage(remoteJid, messageKey, "📸");
          }

          // Send confirmation preview card
          if (safeSendMessage && p) {
            await safeSendMessage(remoteJid, {
              text: `📸 *New Product Auto-Listed — ${shop.name}*\n` +
                    `╭────────────────────────────────────────╮\n` +
                    `  • Product: *${p.name}*\n` +
                    `  • Price: *KES ${Number(p.price).toLocaleString()}*\n` +
                    `  • Category: *${p.category || "General"}*\n` +
                    `  • Image: *Studio CDN Stored* ✅\n` +
                    `  • Storefront: *LIVE & Shoppable* 🌐\n` +
                    `╰────────────────────────────────────────╯\n` +
                    `_View on store or reply \`!product\` to review catalog._`
            });
          }
          console.log(`[PASSIVE PHOTO] Successfully created product "${parsed.name}" for ${shop.name} (KES ${parsed.price})`);
          return;
        }
      } catch (photoErr) {
        console.error(`[PASSIVE PHOTO ERROR]:`, photoErr.message);
      }
    }

    // =========================================================================
    // SUPERPOWERS 2 & 3: Order Notes, Shelf Locations & Rider Assignment
    // =========================================================================
    const orderRefs = extractOrderReferences(rawText);
    if (orderRefs.length === 0) return;

    for (const ref of orderRefs) {
      const order = await resolveShopOrder(shop ? shop.id : null, ref);
      if (!order) continue; // Not an active order in this store; ignore silently

      const existingNotes = order.notes || "";
      const cleanText = rawText.trim().replace(/\s+/g, " ");

      // Avoid duplicate appending
      if (existingNotes.includes(cleanText)) continue;

      const isLogistics = /\b(?:shelf|pack|packed|boxed|bagged|hold|station)\b/i.test(cleanText);
      const isDispatch = /\b(?:dispatch|dispatched|rider|courier|otieno|john|james|pickup|delivery|collected|sent|taking)\b/i.test(cleanText);
      const isPayment = /\b(?:paid|mpesa|cash|received|settled)\b/i.test(cleanText);

      // Select contextual reaction emoji & update payload
      let reactionEmoji = "📝";
      let patchPayload = {};

      if (isDispatch) {
        // SUPERPOWER 3: Automatic Rider / Courier Assignment
        reactionEmoji = "🚚";
        patchPayload.status = "dispatched";
      } else if (isLogistics) {
        // SUPERPOWER 2: Passive Order Notes & Shelf Locations
        reactionEmoji = "📦";
        if (order.internal_status === "CREATED" || order.internal_status === "PAID") {
          patchPayload.internal_status = "PROCESSING";
        }
      } else if (isPayment) {
        reactionEmoji = "💳";
        patchPayload.status = "paid";
        patchPayload.internal_status = "PAID";
      }

      // Format updated notes
      const noteEntry = `• [${timeStr} @${callerName}]: ${cleanText}`;
      const newNotes = existingNotes ? `${existingNotes}\n${noteEntry}` : noteEntry;
      patchPayload.notes = newNotes;

      // Update Supabase
      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
        method: "PATCH",
        headers: { ...dbHdrs, "Prefer": "return=minimal" },
        body: JSON.stringify(patchPayload)
      });

      if (updateRes.ok) {
        console.log(`[PASSIVE NOTE] Logged note for Order #${order.id.slice(0, 8)} (${reactionEmoji}): "${cleanText}"`);

        // Tap emoji reaction on the user's message!
        if (safeReactMessage && messageKey) {
          await safeReactMessage(remoteJid, messageKey, reactionEmoji);
        }
      }
    }
  } catch (err) {
    console.error("[PASSIVE LISTENER ERROR]:", err.message);
  }
}

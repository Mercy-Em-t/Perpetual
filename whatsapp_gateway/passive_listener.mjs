/**
 * Comprehensive Passive Ambient Intelligence Engine
 * Hardened with Enterprise-Grade Anti-Nonsense Guardrails:
 *  1. Intent & Negation Guard (Ignores questions & negated statements like "not taking")
 *  2. Terminal State Lock (Never tampers with delivered, cancelled, or archived orders)
 *  3. Unpaid Dispatch Protection (Blocks dispatching orders that are still pending payment)
 *  4. M-Pesa Single-Use & Anti-Collision (Deduplicates codes & halts on ambiguous amounts)
 *  5. Role-Based Group Authority (Community chats cannot advance warehouse stations)
 *  6. Anti-Junk Photo Ingestion (Sanity checks on price, item name, and management authority)
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

const TERMINAL_STATUSES = ["delivered", "cancelled", "archived", "refunded"];
const JUNK_WORDS = ["look", "this", "pic", "photo", "image", "haha", "receipt", "waybill", "screenshot", "meme", "damaged", "test", "broken"];

/**
 * Natural language intent checks
 */
export function isNegated(text) {
  return /\b(?:not|no|don't|dont|never|cancelling|cancelled|refused|delayed|fake|wrong|mistake|stop|hold\s+on)\b/i.test(text);
}

export function isQuestionOrInquiry(text) {
  return text.includes("?") || /^\s*(?:is|are|why|where|who|when|which|how)\b/i.test(text);
}

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
 * Main Ambient Intelligence Message Processor with Comprehensive Guardrails
 */
export async function handlePassiveGroupMessage(rawText, remoteJid, senderId, msg, safeReactMessage, safeSendMessage, sock) {
  try {
    const context = await resolveGroupContext(remoteJid);
    const shop = context.shop || null;
    const callerName = senderId ? senderId.replace(/@.*$/, "") : "Staff";
    const now = new Date();
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const messageKey = msg.key;
    const cleanText = (rawText || "").trim().replace(/\s+/g, " ");

    // Guardrail: Ignore single-character noise, pure whitespace, or tiny strings
    if (cleanText.length < 5 && !msg.message?.imageMessage) return;

    // =========================================================================
    // SUPERPOWER 1: Automatic M-Pesa SMS Reconciler (with Safety Guardrails)
    // =========================================================================
    const mpesa = parseMpesaSms(rawText);
    if (mpesa && shop) {
      console.log(`[PASSIVE RECONCILER] Detected M-Pesa SMS in ${shop.name}: Ref ${mpesa.code}, Amount KES ${mpesa.amount}`);

      // Guardrail 1A: Deduplication & Single-Use Invariant Check
      const dupRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?mpesa_code=eq.${mpesa.code}&status=eq.paid&select=id,client_name`, { headers: dbHdrs });
      const existingPaid = await dupRes.json();
      if (Array.isArray(existingPaid) && existingPaid.length > 0) {
        console.warn(`[GUARDRAIL REJECT] Duplicate M-Pesa Code: ${mpesa.code} already redeemed on Order #${existingPaid[0].id.slice(0, 8)}`);
        if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "⚠️");
        if (safeSendMessage) {
          await safeSendMessage(remoteJid, {
            text: `⚠️ *Duplicate M-Pesa Receipt!*\nCode \`${mpesa.code}\` was already redeemed on settled order *#${existingPaid[0].id.slice(0, 8).toUpperCase()}*.`
          });
        }
        return;
      }

      // Query active pending orders matching this exact amount
      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?shop_id=eq.${shop.id}&status=eq.pending&total_price=eq.${mpesa.amount}&order=created_at.desc&limit=5`, { headers: dbHdrs });
      const candidates = await res.json();

      if (!Array.isArray(candidates) || candidates.length === 0) {
        console.log(`[PASSIVE RECONCILER] No pending order found matching amount KES ${mpesa.amount} in ${shop.name}`);
        if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "❓");
        return;
      }

      // Guardrail 1B: Ambiguity Protection (Never guess if multiple orders match the same amount)
      if (candidates.length > 1) {
        console.warn(`[GUARDRAIL REJECT] Ambiguous M-Pesa Match: ${candidates.length} orders found with amount KES ${mpesa.amount}`);
        if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "❓");
        if (safeSendMessage) {
          const listStr = candidates.slice(0, 3).map(o => `• *#${o.id.slice(0, 8).toUpperCase()}* (${o.client_name || "Guest"})`).join("\n");
          await safeSendMessage(remoteJid, {
            text: `⚠️ *Ambiguous Payment Notice (KES ${Number(mpesa.amount).toLocaleString()} - Ref: \`${mpesa.code}\`)*\n` +
                  `Found ${candidates.length} pending orders for this exact amount:\n${listStr}\n\n` +
                  `👉 *Cashier confirmation required:* Reply with \`!paid <order_id> ${mpesa.code}\` to select the right order.`
          });
        }
        return;
      }

      // Exact 1:1 Match Found: Safe to auto-settle!
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

      if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "💳");

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

    // =========================================================================
    // SUPERPOWER 4: Product Photo Ingestion (with Anti-Meme / Anti-Junk Guardrails)
    // =========================================================================
    const hasImage = Boolean(msg.message?.imageMessage);
    if (hasImage && shop) {
      // Guardrail 4A: Role Authority (Only MANAGEMENT groups or store owners can catalog items)
      // Operations staff share waybills and damaged boxes; those must NOT become store products!
      const isManagement = context.role === "MANAGEMENT";
      const isOwner = shop.whatsapp_number && senderId.includes(shop.whatsapp_number);

      if (!isManagement && !isOwner) {
        console.log(`[GUARDRAIL REJECT] Photo ingestion skipped: sent in ${context.role} group (Management role required).`);
        return;
      }

      console.log(`[PASSIVE PHOTO] Inbound product photo detected in ${shop.name} from @${callerName}`);
      const caption = rawText || "";
      const parsed = parseProductCaption(caption);

      if (!parsed || parsed.price === null) {
        if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "❓");
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

      // Guardrail 4B: Price Sanity (KES 20 to KES 2,000,000)
      if (parsed.price < 20 || parsed.price > 2000000) {
        console.warn(`[GUARDRAIL REJECT] Unrealistic product price: KES ${parsed.price}`);
        if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "⚠️");
        if (safeSendMessage) {
          await safeSendMessage(remoteJid, { text: `⚠️ Price KES ${parsed.price} is outside allowed range (KES 20 - KES 2,000,000).` });
        }
        return;
      }

      // Guardrail 4C: Junk Word & Length Check
      if (parsed.name.length < 3 || JUNK_WORDS.includes(parsed.name.toLowerCase())) {
        console.warn(`[GUARDRAIL REJECT] Junk product name detected: "${parsed.name}"`);
        if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "❓");
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

          // Policy Check: Optimistic Auto-Publish vs Strict Review Mode
          const policy = shop.fulfillment_settings?.product_approval_policy || "optimistic";
          const isLive = policy === "optimistic";

          // Insert into Supabase menu_items table (storefront catalog)
          const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items`, {
            method: "POST",
            headers: { ...dbHdrs, "Prefer": "return=representation" },
            body: JSON.stringify({
              shop_id: shop.id,
              name: parsed.name,
              description: `Uploaded via WhatsApp by @${callerName}`,
              price: parsed.price,
              category: parsed.category,
              image_url: publicUrl,
              is_active: isLive
            })
          });

          const insertedRows = await insertRes.json();
          const p = insertedRows?.[0];

          if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, isLive ? "📸" : "⏳");

          if (safeSendMessage && p) {
            if (isLive) {
              await safeSendMessage(remoteJid, {
                text: `📸 *Product Auto-Listed (LIVE) — ${shop.name}*\n` +
                      `╭────────────────────────────────────────╮\n` +
                      `  • Product: *${p.name}*\n` +
                      `  • Price: *KES ${Number(p.price).toLocaleString()}*\n` +
                      `  • Category: *${p.category || "General"}*\n` +
                      `  • Image: *Studio CDN Stored* ✅\n` +
                      `  • Status: *LIVE on Storefront* 🟢\n` +
                      `╰────────────────────────────────────────╯\n` +
                      `_Item is live. To unpublish or hide, reply:_ \`!product hide ${p.id.slice(0, 8)}\``
              });
            } else {
              await safeSendMessage(remoteJid, {
                text: `📸 *Studio Preview Generated — ${shop.name}*\n` +
                      `╭────────────────────────────────────────╮\n` +
                      `  • Product: *${p.name}*\n` +
                      `  • Price: *KES ${Number(p.price).toLocaleString()}*\n` +
                      `  • Category: *${p.category || "General"}*\n` +
                      `  • Image: *Studio CDN Stored* ✅\n` +
                      `  • Status: 🟡 *Draft (Pending Approval)*\n` +
                      `╰────────────────────────────────────────╯\n` +
                      `👉 *Does this look display-grade?*\n` +
                      `• Reply with: \`!product approve ${p.id.slice(0, 8)}\`\n` +
                      `• Or view all drafts: \`!product drafts\``
              });
            }
          }
          console.log(`[PASSIVE PHOTO] Created product "${parsed.name}" for ${shop.name} (Live: ${isLive}, KES ${parsed.price})`);
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

    // Guardrail 2A: Intent Integrity — Reject questions & inquiries
    if (isQuestionOrInquiry(cleanText)) {
      console.log(`[GUARDRAIL IGNORE] Message is an inquiry, not an action: "${cleanText}"`);
      return;
    }

    // Guardrail 2B: Negation Filter — Block negated statements from moving status
    const hasNegation = isNegated(cleanText);

    for (const ref of orderRefs) {
      const order = await resolveShopOrder(shop ? shop.id : null, ref);
      if (!order) continue; // Not an active order in this store; ignore silently

      const existingNotes = order.notes || "";

      // Avoid duplicate appending
      if (existingNotes.includes(cleanText)) continue;

      // Guardrail 2C: Terminal State Lock
      // Orders that are already delivered, cancelled, or archived are IMMUTABLE.
      if (TERMINAL_STATUSES.includes((order.status || "").toLowerCase())) {
        console.warn(`[GUARDRAIL IGNORE] Order #${order.id.slice(0, 8)} is in terminal status '${order.status}'. Updates blocked.`);
        continue;
      }

      // Guardrail 2D: Role Authority Check
      // Community customer group can only record general customer notes; CANNOT advance pipeline!
      const canAdvanceStation = context.role === "OPERATIONS" || context.role === "MANAGEMENT" || context.tier === "SYSTEM";

      const isLogistics = /\b(?:shelf|pack|packed|boxed|bagged|hold|station)\b/i.test(cleanText);
      const isDispatch = /\b(?:dispatch|dispatched|rider|courier|otieno|john|james|pickup|delivery|collected|sent|taking)\b/i.test(cleanText);

      let reactionEmoji = "📝";
      let patchPayload = {};

      if (hasNegation) {
        // If negated (e.g. "James is NOT taking order #832f"), record audit note only; DO NOT change status!
        console.log(`[GUARDRAIL] Negated logistics statement recorded without status progression: "${cleanText}"`);
        reactionEmoji = "⚠️";
      } else if (isDispatch && canAdvanceStation) {
        // Guardrail 2E: Unpaid Dispatch Protection
        // Cannot dispatch an order that has not been paid!
        if (order.status === "pending") {
          console.warn(`[GUARDRAIL BLOCKED] Cannot dispatch unpaid order #${order.id.slice(0, 8)}.`);
          reactionEmoji = "⚠️";
          if (safeReactMessage && messageKey) await safeReactMessage(remoteJid, messageKey, "⚠️");
          if (safeSendMessage) {
            await safeSendMessage(remoteJid, {
              text: `⚠️ *Dispatch Blocked for Order #${order.id.slice(0, 8).toUpperCase()}*\n` +
                    `Order is currently *UNPAID* (KES ${Number(order.total_price).toLocaleString()}).\n` +
                    `Verify payment via \`!paid ${order.id.slice(0, 8)} <mpesa_code>\` before handing over to courier!`
            });
          }
          return;
        }

        // Paid/verified order: Safe to dispatch!
        reactionEmoji = "🚚";
        patchPayload.status = "dispatched";
      } else if (isLogistics && canAdvanceStation) {
        reactionEmoji = "📦";
        if (order.internal_status === "CREATED" || order.internal_status === "PAID") {
          patchPayload.internal_status = "PROCESSING";
        }
      }

      // Format updated notes with audit attribution
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
        if (safeReactMessage && messageKey) {
          await safeReactMessage(remoteJid, messageKey, reactionEmoji);
        }
      }
    }
  } catch (err) {
    console.error("[PASSIVE LISTENER ERROR]:", err.message);
  }
}

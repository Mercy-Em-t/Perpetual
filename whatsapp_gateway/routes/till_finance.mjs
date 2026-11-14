/**
 * Till Receipt Ingestion, Pool Reconciliation, Finance Reporting & Embedded Apps
 * Extracted from http_routes.mjs (see routes/INDEX.md)
 */
import { parseJsonBody } from "../http_helpers.mjs";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config.mjs";
import { getAllShops } from "../tenant_resolver.mjs";

export async function handleTillFinanceRoutes({
  req,
  res,
  parsedUrl,
  GROUPS,
  safeSendMessage,
}) {
    if ((req.method === "POST" || req.method === "GET") && (parsedUrl.pathname === "/api/till/receipt" || parsedUrl.pathname === "/api/sms-webhook")) {
      const traceSteps = [];
      const traceStart = Date.now();
      const addTrace = (step, detail) => {
        const elapsed = `${Date.now() - traceStart}ms`;
        const entry = `[+${elapsed}] ${step}: ${detail}`;
        traceSteps.push(entry);
        console.log(`[TILL TRACE] ${entry}`);
      };
      const flushTraceLog = async (finalPayload) => {
        try {
          const fsMod = await import("fs");
          const pathMod = await import("path");
          const tracePath = pathMod.resolve(process.cwd(), "till_server_trace.log");
          const block = [
            `====================================================================`,
            `TIMESTAMP: ${new Date().toISOString()} | CLIENT IP: ${req.socket?.remoteAddress || "unknown"}`,
            ...traceSteps,
            `FINAL SERVER JSON RESPONSE:\n${JSON.stringify(finalPayload, null, 2)}`,
            `====================================================================\n`
          ].join("\n");
          fsMod.appendFileSync(tracePath, block, "utf-8");
        } catch (_) {}
      };

      try {
        let rawSms = "";
        let simSlot = "TILL_SIM";
        let senderAddr = "MPESA";

        if (req.method === "GET") {
          rawSms = parsedUrl.searchParams.get("text") || parsedUrl.searchParams.get("msg") || parsedUrl.searchParams.get("sms") || "";
          simSlot = parsedUrl.searchParams.get("sim") || "TILL_SIM";
          senderAddr = parsedUrl.searchParams.get("from") || "MPESA";
        } else {
          const body = await parseJsonBody(req).catch(() => ({}));
          rawSms = body.text || body.msg || body.sms || body.message || body.body || body.content || (typeof body === "string" ? body : "");
          simSlot = body.sim || body.sim_slot || body.sub_id || "TILL_SIM";
          senderAddr = body.from || body.sender || "MPESA";
        }

        const cleanSms = String(rawSms || "").trim();
        addTrace("STEP 1 (HTTP INBOUND)", `Method=${req.method} | Sender=${senderAddr} | SIM=${simSlot} | Raw="${cleanSms}"`);

        if (!cleanSms) {
          const out = { success: false, error: "Empty SMS payload", trace: traceSteps };
          await flushTraceLog(out);
          res.writeHead(400);
          return res.end(JSON.stringify(out));
        }

        // Source-of-Truth Perimeter Guard:
        // If a request to /api/till/receipt is tagged as coming from a CLIENT (not our SIM forwarder),
        // NEVER allow it to update our Personal Finance ledger or our Till Receipt Pool!
        if (/client|customer|storefront/i.test(simSlot) || /client|customer/i.test(senderAddr)) {
          addTrace("STEP 1B (SOURCE OF TRUTH BLOCK)", `Blocked UNTRUSTED_CLIENT_CLAIM on hardware forwarder endpoint (SIM=${simSlot})`);
          const out = {
            success: false,
            source_of_truth: "UNTRUSTED_CLIENT_CLAIM",
            error: "Client-submitted messages cannot be sent to the Hardware Till SIM Forwarder endpoint. Use /api/order/verify-payment instead.",
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(403);
          return res.end(JSON.stringify(out));
        }

        // Check if this is a Personal Expense / Bank / Okoa SMS vs. a Business Till Receipt
        const { parseFinancialSms, savePersonalTransaction, computeFinancialReport } = await import("./finance_engine.mjs");
        const finParsed = parseFinancialSms(cleanSms, senderAddr, Date.now());
        if (finParsed && !finParsed.is_business_till) {
          const saveRes = savePersonalTransaction(finParsed);
          addTrace(
            "STEP 2 (PERSONAL FINANCE ROUTER)",
            `Classified as ${finParsed.tx_type} [${finParsed.category}] -> KES ${finParsed.amount} (${finParsed.counterparty}) | Saved=${saveRes.saved}`
          );
          const out = {
            success: true,
            source_of_truth: "HARDWARE_SIM_FORWARDER",
            routed_to: "PERSONAL_FINANCE_LEDGER",
            duplicate: Boolean(saveRes.duplicate),
            transaction: finParsed,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        // Parse M-Pesa Till Companion SMS (Inflow OR Outflow/Withdrawal)
        // NOTE: Strictly extract ONLY Merchant Till balances (Account/Utility/Working Account), NEVER a personal "M-PESA balance"!
        const codeMatch = cleanSms.match(/\b([A-Z0-9]{10})\b\s*Confirmed/i) || cleanSms.match(/\b([A-Z0-9]{10})\b/);
        const amountMatch = cleanSms.match(/(?:Withdraw\s+)?(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)\s+(?:received|paid|sent|withdrawn|from|transferred)/i) ||
                            cleanSms.match(/(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
        const partyMatch = cleanSms.match(/received\s+from\s+(?:(\+?\d{9,13})\s+)?([A-Z\s.'-]+?)(?:\.\s+New|\.\s+Account|$)/i);
        const outPartyMatch = cleanSms.match(/(?:sent\s+to|paid\s+to|from|transferred\s+to)\s+(.+?)(?:\s+on\s+\d|\.\s*on\s+|\.\s*New|\s+New\s+|$)/i);
        const balMatch = cleanSms.match(/New\s+(?:Account|Utility|Working(?:\s+Account)?)\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
        const feeMatch = cleanSms.match(/Transaction\s+cost,?\s*(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);

        if (!codeMatch || !amountMatch) {
          addTrace("STEP 2 (REGEX PARSE)", "Failed to extract M-Pesa 10-char code or KES amount -> Ignored non-receipt SMS");
          const out = {
            success: true,
            ignored: true,
            reason: "Not a valid M-Pesa confirmation receipt",
            raw_received: cleanSms,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        const mpesaCode = codeMatch[1].toUpperCase();
        const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
        const fee = feeMatch ? parseFloat(feeMatch[1].replace(/,/g, "")) : 0;
        const reportedBalance = balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : null;
        const isTillOutflow = finParsed?.direction === "TILL_OUTFLOW" ||
          (!(/received\s+from/i.test(cleanSms)) && /(?:sent\s+to|paid\s+to|withdrawn|Withdraw|transferred)/i.test(cleanSms));
        const direction = isTillOutflow ? "OUTFLOW" : "INFLOW";

        let payerPhone = partyMatch?.[1] ? partyMatch[1].trim() : (finParsed?.phone || null);
        let payerName = partyMatch?.[2]
          ? partyMatch[2].trim()
          : (finParsed?.counterparty || (outPartyMatch?.[1] ? outPartyMatch[1].trim() : "Customer"));

        addTrace(
          "STEP 2 (REGEX PARSE)",
          `Extracted Code=${mpesaCode} | Direction=${direction} | Amount=KES ${amount} | Fee=KES ${fee} | Balance=${reportedBalance !== null ? `KES ${reportedBalance}` : "N/A"} | Counterparty="${payerName}" (${payerPhone || "no-phone"})`
        );

        // Helper to load pool and compute running balance variance against prior Till entry
        const fsMod = await import("fs");
        const pathMod = await import("path");
        const poolPath = pathMod.resolve(process.cwd(), "till_receipt_pool.json");
        let pool = [];
        try {
          if (fsMod.existsSync(poolPath)) {
            pool = JSON.parse(fsMod.readFileSync(poolPath, "utf-8") || "[]");
          }
        } catch (_) {}

        // Find the most recent prior entry with a reported_balance (from the same SIM/Till context)
        const priorWithBal = pool.find(x => x.code !== mpesaCode && typeof x.reported_balance === "number");
        const previousBalance = priorWithBal ? priorWithBal.reported_balance : null;
        let expectedBalance = null;
        let balanceVariance = 0;
        if (previousBalance !== null && reportedBalance !== null) {
          expectedBalance = direction === "INFLOW"
            ? Math.round((previousBalance + amount - fee) * 100) / 100
            : Math.round((previousBalance - amount - fee) * 100) / 100;
          balanceVariance = Math.round((reportedBalance - expectedBalance) * 100) / 100;
          addTrace(
            "STEP 2B (VARIANCE AUDIT)",
            `PrevBal=KES ${previousBalance} | Expected=KES ${expectedBalance} | SafaricomReported=KES ${reportedBalance} | Variance=KES ${balanceVariance}`
          );
        }

        // Handle TILL OUTFLOW (When money is withdrawn/sent out of the Till)
        if (direction === "OUTFLOW") {
          const existingOut = pool.find(x => x.code === mpesaCode);
          if (!existingOut) {
            pool.unshift({
              code: mpesaCode,
              direction: "OUTFLOW",
              amount,
              fee,
              reported_balance: reportedBalance,
              previous_balance: previousBalance,
              expected_balance: expectedBalance,
              balance_variance: balanceVariance,
              payer_phone: payerPhone,
              payer_name: payerName,
              sim_slot: simSlot,
              raw_sms: cleanSms,
              status: "TILL_OUTFLOW",
              order_id: null,
              received_at: new Date().toISOString()
            });
            fsMod.writeFileSync(poolPath, JSON.stringify(pool.slice(0, 500), null, 2), "utf-8");
          }
          addTrace("STEP 3 (TILL OUTFLOW LOGGED)", `Recorded Till Outflow of KES ${amount} (+Fee KES ${fee}) to "${payerName}"`);

          if (safeSendMessage) {
            const mgmtJid = GROUPS?.adminOversight?.jid || GROUPS?.general?.jid;
            if (mgmtJid) {
              const outCard =
                `📤 *[TILL OUTFLOW / WITHDRAWAL LOGGED]*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `• *Ref:* \`${mpesaCode}\`\n` +
                `• *Sent / Withdrawn:* KES ${Number(amount).toLocaleString()}\n` +
                `• *Transaction Fee:* KES ${Number(fee).toLocaleString()}\n` +
                `• *Destination:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
                (reportedBalance !== null ? `• *New Till Balance:* KES ${Number(reportedBalance).toLocaleString()}\n` : "") +
                (balanceVariance !== 0 ? `⚠️ *Balance Variance:* KES ${balanceVariance > 0 ? `+${balanceVariance}` : balanceVariance}\n` : `✅ *Variance Check:* KES 0.00 (Exact)\n`) +
                `━━━━━━━━━━━━━━━━━━━━━━`;
              safeSendMessage(mgmtJid, { text: outCard });
            }
          }

          const out = {
            success: true,
            status: "TILL_OUTFLOW",
            direction: "OUTFLOW",
            mpesa_code: mpesaCode,
            amount,
            fee,
            reported_balance: reportedBalance,
            expected_balance: expectedBalance,
            balance_variance: balanceVariance,
            destination: payerName,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY;
        const hdrs = {
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json"
        };

        // 1. Single-Use Deduplication Check
        const dupRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?mpesa_code=eq.${mpesaCode}&status=eq.paid&select=id,client_name`, { headers: hdrs });
        const existingPaid = await dupRes.json();
        if (Array.isArray(existingPaid) && existingPaid.length > 0) {
          addTrace("STEP 3 (DEDUP CHECK)", `Code ${mpesaCode} was ALREADY used to settle Order ${existingPaid[0].id} (${existingPaid[0].client_name})`);
          const out = {
            success: true,
            duplicate: true,
            mpesa_code: mpesaCode,
            settled_order_id: existingPaid[0].id,
            client_name: existingPaid[0].client_name,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }
        addTrace("STEP 3 (DEDUP CHECK)", `Code ${mpesaCode} is fresh (unused in Supabase)`);

        // 2. Find Pending Orders Matching Exact Amount
        const pendRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?status=eq.pending&total_price=eq.${amount}&order=created_at.desc&limit=10`, { headers: hdrs });
        let candidates = await pendRes.json();
        if (!Array.isArray(candidates)) candidates = [];
        addTrace("STEP 4 (ORDER SEARCH)", `Found ${candidates.length} pending order(s) with total_price = KES ${amount}`);

        // Hardened 3-Tier Identity + Time-Window Matching (Prevents matching stale/abandoned orders from wrong customers)
        let matchedOrder = null;
        const windowMinutes = Number(process.env.TILL_MATCH_WINDOW_MINUTES) || 15;
        const windowMs = windowMinutes * 60 * 1000;
        const nowMs = Date.now();
        const payerSuffix = payerPhone ? payerPhone.replace(/\D/g, "").slice(-9) : "";
        const payerTokens = (payerName && payerName !== "Customer")
          ? payerName.toLowerCase().split(/\s+/).filter(t => t.length >= 3)
          : [];

        if (candidates.length > 0) {
          // Tier 1: Exact Amount + Phone Suffix Match (100% Identity Guarantee)
          if (payerSuffix.length === 9) {
            matchedOrder = candidates.find(o => (o.client_phone || "").replace(/\D/g, "").endsWith(payerSuffix)) || null;
            if (matchedOrder) {
              addTrace("STEP 4B (TIER 1: PHONE + AMOUNT MATCH)", `Matched Order #${matchedOrder.id.slice(0, 8).toUpperCase()} via phone suffix *${payerSuffix}`);
            }
          }
          // Tier 2: Exact Amount + Registered Name Token Match (Handles Airtel/secondary checkout phone + Safaricom M-Pesa payment)
          if (!matchedOrder && payerTokens.length > 0) {
            matchedOrder = candidates.find(o => {
              const cName = (o.client_name || "").toLowerCase();
              return payerTokens.some(tok => cName.includes(tok));
            }) || null;
            if (matchedOrder) {
              addTrace("STEP 4B (TIER 2: NAME + AMOUNT MATCH)", `Matched Order #${matchedOrder.id.slice(0, 8).toUpperCase()} via registered name "${payerName}"`);
            }
          }
          // Tier 3: Exact Amount + Single Fresh Checkout Candidate within 15-minute window (Handles spouse/friend paying at checkout)
          if (!matchedOrder && candidates.length === 1) {
            const candidateAgeMs = candidates[0].created_at ? (nowMs - new Date(candidates[0].created_at).getTime()) : 0;
            if (candidateAgeMs <= windowMs) {
              matchedOrder = candidates[0];
              addTrace("STEP 4B (TIER 3: FRESH WINDOW + AMOUNT MATCH)", `Single fresh pending order (<=${windowMinutes}m old) -> Order #${matchedOrder.id.slice(0, 8).toUpperCase()}`);
            } else {
              addTrace("STEP 4B (STALE ORDER GUARD)", `Blocked auto-match to stale Order #${candidates[0].id.slice(0, 8).toUpperCase()} (${Math.round(candidateAgeMs / 60000)}m old, phone/name mismatch) -> Pooled safely`);
            }
          } else if (!matchedOrder && candidates.length > 1) {
            addTrace("STEP 4B (AMBIGUOUS GUARD)", `Could not disambiguate between ${candidates.length} orders with same amount and no phone/name match`);
          }
        }

        // Save to local Till Receipt Pool (for audit, balance variance & unclaimed lookback)
        try {
          const poolStatus = matchedOrder ? "CLAIMED" : (candidates.length > 1 ? "AMBIGUOUS" : "UNCLAIMED_POOL");
          const existingIdx = pool.findIndex(x => x.code === mpesaCode);
          const entryObj = {
            code: mpesaCode,
            direction: "INFLOW",
            amount,
            fee,
            reported_balance: reportedBalance,
            previous_balance: previousBalance,
            expected_balance: expectedBalance,
            balance_variance: balanceVariance,
            payer_phone: payerPhone,
            payer_name: payerName,
            sim_slot: simSlot,
            raw_sms: cleanSms,
            status: poolStatus,
            order_id: matchedOrder ? matchedOrder.id : null,
            received_at: new Date().toISOString()
          };
          if (existingIdx >= 0) {
            pool[existingIdx] = entryObj;
          } else {
            pool.unshift(entryObj);
          }
          fsMod.writeFileSync(poolPath, JSON.stringify(pool.slice(0, 500), null, 2), "utf-8");
          addTrace("STEP 5 (POOL SAVE)", `Saved receipt to till_receipt_pool.json with status=${poolStatus} | TillBalance=${reportedBalance}`);
        } catch (poolErr) {
          console.warn("[TILL POOL WARN]", poolErr.message);
        }

        if (!matchedOrder) {
          // Notify Operations Group of Unclaimed / Ambiguous Till Payment in Pool
          if (safeSendMessage && GROUPS?.general?.jid) {
            const poolMsg = candidates.length > 1
              ? `⚠️ *[TILL SMS — AMBIGUOUS MATCH]*\n` +
                `• *Ref:* \`${mpesaCode}\` | *KES ${amount.toLocaleString()}*\n` +
                `• *Payer:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
                (reportedBalance !== null ? `• *Till Balance:* KES ${reportedBalance.toLocaleString()}\n` : "") +
                `• *Reason:* ${candidates.length} pending orders have KES ${amount.toLocaleString()}.\n` +
                `👉 _Claim with:_ \`!paid <order_id> ${mpesaCode}\``
              : `📥 *[TILL SMS IN POOL — AWAITING ORDER]*\n` +
                `• *Ref:* \`${mpesaCode}\` | *KES ${amount.toLocaleString()}*\n` +
                `• *Payer:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
                (reportedBalance !== null ? `• *Till Balance:* KES ${reportedBalance.toLocaleString()}\n` : "") +
                `👉 _Pair manually anytime with:_ \`!paid <order_id> ${mpesaCode}\``;
            safeSendMessage(GROUPS.general.jid, { text: poolMsg });
            addTrace("STEP 6 (WHATSAPP ALERT)", `Sent ${candidates.length > 1 ? "AMBIGUOUS" : "POOLED"} alert to Operations WhatsApp Group`);
          }
          const out = {
            success: true,
            status: candidates.length > 1 ? "AMBIGUOUS" : "POOLED",
            direction: "INFLOW",
            mpesa_code: mpesaCode,
            amount,
            fee,
            reported_balance: reportedBalance,
            expected_balance: expectedBalance,
            balance_variance: balanceVariance,
            payer_name: payerName,
            trace: traceSteps
          };
          await flushTraceLog(out);
          res.writeHead(200);
          return res.end(JSON.stringify(out));
        }

        // 3. Auto-Settle Matched Order in Supabase (<200ms)
        const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        const updatedNotes = matchedOrder.notes
          ? `${matchedOrder.notes}\n• [${timeStr} TILL-SIM]: Auto-settled (${mpesaCode} - ${payerName})`
          : `• [${timeStr} TILL-SIM]: Auto-settled (${mpesaCode} - ${payerName})`;

        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${matchedOrder.id}`, {
          method: "PATCH",
          headers: { ...hdrs, "Prefer": "return=minimal" },
          body: JSON.stringify({
            status: "paid",
            internal_status: "PAID",
            mpesa_code: mpesaCode,
            notes: updatedNotes
          })
        });
        addTrace("STEP 6 (SUPABASE SETTLE)", `Patched Order ${matchedOrder.id} -> status='paid', mpesa_code='${mpesaCode}'`);

        const allShops = await getAllShops();
        const activeShop = allShops.find(s => s.id === matchedOrder.shop_id) || null;
        const shortOrder = matchedOrder.id.slice(0, 8).toUpperCase();

        if (safeSendMessage) {
          const opsJid = activeShop?.fulfillment_settings?.whatsapp_routing?.operations_jid || GROUPS?.general?.jid;
          const mgmtJid = activeShop?.fulfillment_settings?.whatsapp_routing?.management_jid || GROUPS?.adminOversight?.jid;
          const card =
            `💳 *[TILL SIM AUTO-SETTLED — ${(activeShop?.name || "STORE").toUpperCase()}]*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `• *Order:* #${shortOrder} (${matchedOrder.client_name || payerName})\n` +
            `• *M-Pesa Ref:* \`${mpesaCode}\` ✅\n` +
            `• *Amount:* KES ${Number(amount).toLocaleString()}\n` +
            `• *Till Payer:* ${payerName}${payerPhone ? ` (${payerPhone})` : ""}\n` +
            (reportedBalance !== null ? `• *New Till Balance:* KES ${Number(reportedBalance).toLocaleString()}\n` : "") +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *Next Step:* Reply \`!pack ${shortOrder}\` to box order.`;

          const targets = new Set([opsJid, mgmtJid, GROUPS?.general?.jid].filter(Boolean));
          for (const t of targets) {
            safeSendMessage(t, { text: card });
          }
          addTrace("STEP 7 (WHATSAPP BROADCAST)", `Dispatched AUTO-SETTLED card for #${shortOrder} to ${targets.size} WhatsApp group(s)`);
          
          // Instant Customer Confirmation to Personal WhatsApp
          try {
            const { sendCustomerOrderConfirmation } = await import("./customer_notifier.mjs");
            sendCustomerOrderConfirmation(matchedOrder, safeSendMessage);
            addTrace("STEP 7B (CUSTOMER WHATSAPP CONFIRMATION)", `Triggered instant confirmation to customer ${matchedOrder.client_phone}`);
          } catch (custErr) {
            console.warn("[CUSTOMER CONFIRMATION ERROR]", custErr.message);
          }
        }

        const out = {
          success: true,
          status: "PAID",
          direction: "INFLOW",
          order_id: matchedOrder.id,
          mpesa_code: mpesaCode,
          amount,
          fee,
          reported_balance: reportedBalance,
          expected_balance: expectedBalance,
          balance_variance: balanceVariance,
          payer_name: payerName,
          trace: traceSteps
        };
        await flushTraceLog(out);
        res.writeHead(200);
        return res.end(JSON.stringify(out));
      } catch (err) {
        console.error("[TILL WEBHOOK ERROR]", err);
        addTrace("ERROR", err.message);
        const out = { success: false, error: err.message, trace: traceSteps };
        await flushTraceLog(out);
        res.writeHead(500);
        return res.end(JSON.stringify(out));
      }
    }

    // GET /acoustic-modem (Serve 16-Tone MFSK Web Audio Transceiver UI)
    if (req.method === "GET" && parsedUrl.pathname === "/acoustic-modem") {
      try {
        const fsMod = await import("fs");
        const htmlPath = "C:\\Users\\user\\Documents\\Acoustic_Modem\\acoustic_transceiver.html";
        const html = fsMod.readFileSync(htmlPath, "utf-8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200);
        return res.end(html);
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/till/pool or /api/till/ledger (Inspect live Till SMS Pool + Full Variance & Outflow Summary)
    if (req.method === "GET" && (parsedUrl.pathname === "/api/till/pool" || parsedUrl.pathname === "/api/till/ledger")) {
      try {
        const fsMod = await import("fs");
        const pathMod = await import("path");
        const poolPath = pathMod.resolve(process.cwd(), "till_receipt_pool.json");
        const rawPool = fsMod.existsSync(poolPath) ? JSON.parse(fsMod.readFileSync(poolPath, "utf-8") || "[]") : [];

        // Enrich any older pool entries with parsed balance, fee, and direction from raw_sms
        const enriched = rawPool.map((item) => {
          const sms = String(item.raw_sms || "");
          const balMatch = sms.match(/New\s+(?:Account|Utility|Working(?:\s+Account)?|M-PESA)\s+balance\s+is\s+(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
          const feeMatch = sms.match(/Transaction\s+cost,?\s*(?:Ksh\.?|KES\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i);
          const isOut = item.direction === "OUTFLOW" || item.status === "TILL_OUTFLOW" ||
            (!(/received\s+from/i.test(sms)) && /(?:sent\s+to|paid\s+to|withdrawn|Withdraw|transferred)/i.test(sms));
          return {
            ...item,
            direction: isOut ? "OUTFLOW" : "INFLOW",
            fee: typeof item.fee === "number" ? item.fee : (feeMatch ? parseFloat(feeMatch[1].replace(/,/g, "")) : 0),
            reported_balance: typeof item.reported_balance === "number"
              ? item.reported_balance
              : (balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : null)
          };
        });

        // Compute chronological expected balance & variance across real REDMI_TILL_SIM entries
        let runningBal = null;
        let cumulativeBalanceVariance = 0;
        const chronological = [...enriched].reverse();
        for (const tx of chronological) {
          if (tx.sim_slot === "REDMI_TILL_SIM" && typeof tx.reported_balance === "number") {
            if (runningBal !== null) {
              const expected = tx.direction === "INFLOW"
                ? Math.round((runningBal + (tx.amount || 0) - (tx.fee || 0)) * 100) / 100
                : Math.round((runningBal - (tx.amount || 0) - (tx.fee || 0)) * 100) / 100;
              tx.previous_balance = runningBal;
              tx.expected_balance = expected;
              tx.balance_variance = Math.round((tx.reported_balance - expected) * 100) / 100;
              cumulativeBalanceVariance = Math.round((cumulativeBalanceVariance + tx.balance_variance) * 100) / 100;
            } else {
              tx.previous_balance = Math.round(
                (tx.direction === "INFLOW"
                  ? tx.reported_balance - (tx.amount || 0) + (tx.fee || 0)
                  : tx.reported_balance + (tx.amount || 0) + (tx.fee || 0)) * 100
              ) / 100;
              tx.expected_balance = tx.reported_balance;
              tx.balance_variance = 0;
            }
            runningBal = tx.reported_balance;
          }
        }

        // Compute aggregate KPIs
        let inflowCount = 0;
        let outflowCount = 0;
        let totalInflow = 0;
        let totalOutflow = 0;
        let totalFees = 0;
        let claimedAmount = 0;
        let unclaimedAmount = 0;
        let latestTillBalance = null;

        for (const tx of enriched) {
          if (latestTillBalance === null && tx.sim_slot === "REDMI_TILL_SIM" && typeof tx.reported_balance === "number") {
            latestTillBalance = tx.reported_balance;
          }
          totalFees += tx.fee || 0;
          if (tx.direction === "OUTFLOW") {
            outflowCount++;
            totalOutflow += tx.amount || 0;
          } else {
            inflowCount++;
            totalInflow += tx.amount || 0;
            if (tx.status === "CLAIMED" || tx.status === "PAID") {
              claimedAmount += tx.amount || 0;
            } else {
              unclaimedAmount += tx.amount || 0;
            }
          }
        }
        if (latestTillBalance === null) {
          const anyWithBal = enriched.find(x => typeof x.reported_balance === "number");
          if (anyWithBal) latestTillBalance = anyWithBal.reported_balance;
        }

        const summary = {
          total_transactions: enriched.length,
          inflow_count: inflowCount,
          outflow_count: outflowCount,
          total_inflow_amount: Math.round(totalInflow * 100) / 100,
          total_outflow_amount: Math.round(totalOutflow * 100) / 100,
          total_fees_amount: Math.round(totalFees * 100) / 100,
          net_till_flow: Math.round((totalInflow - totalOutflow - totalFees) * 100) / 100,
          claimed_orders_amount: Math.round(claimedAmount * 100) / 100,
          unclaimed_pool_amount: Math.round(unclaimedAmount * 100) / 100,
          order_reconciliation_variance: Math.round((totalInflow - claimedAmount) * 100) / 100,
          latest_till_balance: latestTillBalance,
          cumulative_balance_variance: cumulativeBalanceVariance
        };

        res.writeHead(200);
        return res.end(JSON.stringify({ count: enriched.length, summary, receipts: enriched }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /till-app (Mobile PWA & Auto-Forwarder Setup Console for the New Phone)
    if (req.method === "GET" && parsedUrl.pathname === "/till-app") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Savannah Till SMS Relay</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    h1 { font-size: 20px; color: #38bdf8; margin: 0 0 6px 0; }
    p { font-size: 13px; color: #94a3b8; margin: 4px 0 12px 0; line-height: 1.4; }
    .url-box { background: #090d16; padding: 10px 12px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #4ade80; word-break: break-all; margin-bottom: 10px; border: 1px solid #1e293b; }
    button { width: 100%; background: #0284c7; color: #fff; border: none; padding: 13px; border-radius: 10px; font-weight: 700; font-size: 14px; cursor: pointer; margin-top: 8px; }
    button.secondary { background: #334155; }
    textarea { width: 100%; box-sizing: border-box; background: #090d16; color: #fff; border: 1px solid #334155; border-radius: 8px; padding: 10px; font-size: 13px; min-height: 80px; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; background: #065f46; color: #6ee7b7; }
    #log, #serverTrace { font-family: monospace; font-size: 12px; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">LIVE TILL 5758419 BRIDGE</span>
    <h1 style="margin-top:8px;">Savannah M-Pesa Till Relay</h1>
    <p>Forward incoming M-Pesa Till messages from your phone straight into the server in &lt;0.2s.</p>
    <div class="url-box" id="cloudUrl">https://wa.missperpetual.cloud/api/till/receipt</div>
    <div class="url-box" id="lanUrl">http://192.168.100.32:5174/api/till/receipt</div>
    <div class="url-box" id="tsUrl">http://100.73.175.118:5174/api/till/receipt</div>
    <button class="secondary" onclick="navigator.clipboard.writeText(window.location.origin + '/api/till/receipt'); alert('Copied Webhook URL!');">📋 Copy Active Webhook URL</button>
    <button style="background:#059669;" onclick="window.location.href='/finance-app'">📊 Open Personal Financial Reporter (/finance-app)</button>
  </div>

  <div class="card">
    <h1>⚡ Instant Test / Manual SMS Paste</h1>
    <p>Paste any M-Pesa confirmation SMS or tap below to test:</p>
    <textarea id="smsInput">UK6DC1DCIM Confirmed.on 6/11/26 at 4:35 PMKSH1.00 received from 254710720949 MERCY TRYPHEN EMURUGAT. New Account balance is KSH26.56. Transaction cost, KSH0.00.  Receiving payments of Ksh 500 &amp; below in your Lipa na M-PESA till is now FREE!</textarea>
    <button onclick="sendSms()">🚀 Send Receipt to Server Now</button>
    <button class="secondary" onclick="newRandomSms()">🎲 Generate Fresh Test M-Pesa SMS</button>
  </div>

  <div class="card">
    <h1>🔍 Full Server Response & Step-by-Step Trace</h1>
    <div id="serverTrace">Tap "Send Receipt to Server Now" above to record and view the full server response process here!</div>
  </div>

  <div class="card">
    <h1>📥 Live Till Receipt Pool</h1>
    <div id="log">Loading pool...</div>
  </div>

  <script>
    function newRandomSms() {
      const code = 'SK' + Math.floor(10000000 + Math.random() * 90000000);
      document.getElementById('smsInput').value = code + ' Confirmed. on 6/11/26 at 4:30 PM Ksh450.00 received from 254710720949 TEST CUSTOMER. New Utility balance is Ksh19,300.00';
    }
    async function loadPool() {
      try {
        const r = await fetch('/api/till/pool');
        const d = await r.json();
        document.getElementById('log').textContent = d.receipts && d.receipts.length
          ? d.receipts.slice(0, 8).map(x => \`[\${x.status}] \${x.code} - KES \${x.amount} (\${x.payer_name})\`).join('\\n')
          : 'No receipts in pool yet. Tap Send Receipt above to test!';
      } catch (e) {
        document.getElementById('log').textContent = 'Error loading pool: ' + e.message;
      }
    }
    async function sendSms() {
      const text = document.getElementById('smsInput').value;
      document.getElementById('serverTrace').textContent = '⏳ Sending to server and recording response trace...';
      const r = await fetch('/api/till/receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'MPESA', sim: 'NEW_PHONE', text })
      });
      const res = await r.json();
      const traceText = (res.trace || []).join('\\n');
      document.getElementById('serverTrace').textContent =
        '=== STEP-BY-STEP SERVER PROCESS ===\\n' + traceText +
        '\\n\\n=== FULL SERVER JSON RESPONSE ===\\n' + JSON.stringify(res, null, 2);
      loadPool();
    }
    loadPool();
  </script>
</body>
</html>`);
    }

    // GET /api/finance/report (Return full Personal Financial Reporter analytics)
    if (req.method === "GET" && parsedUrl.pathname === "/api/finance/report") {
      try {
        const { computeFinancialReport } = await import("./finance_engine.mjs");
        res.writeHead(200);
        return res.end(JSON.stringify(computeFinancialReport()));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/finance/ingest (Ingest single or batch SMS into Personal Financial Reporter)
    if (req.method === "POST" && parsedUrl.pathname === "/api/finance/ingest") {
      try {
        const { parseFinancialSms, savePersonalTransaction, computeFinancialReport } = await import("./finance_engine.mjs");
        const body = await parseJsonBody(req).catch(() => ({}));
        const items = Array.isArray(body.messages) ? body.messages : [body];
        let added = 0;
        const parsedResults = [];
        for (const item of items) {
          const text = item.text || item.body || item.sms || "";
          const sender = item.from || item.sender || item.address || "MPESA";
          const ts = item.timestamp || item.date || Date.now();
          const smsId = item.id || item.sms_id || null;
          const p = parseFinancialSms(text, sender, ts, smsId);
          if (p && !p.is_business_till) {
            const r = savePersonalTransaction(p);
            if (r.saved) added++;
            parsedResults.push({ ...p, saved: r.saved, duplicate: Boolean(r.duplicate) });
          }
        }
        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          added_count: added,
          parsed: parsedResults,
          report: computeFinancialReport()
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /finance-app (Personal Financial Reporter & Expense Analyzer Dashboard)
    if (req.method === "GET" && parsedUrl.pathname === "/finance-app") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Personal Financial Reporter — M-Pesa, DTB & Okoa Analytics</title>
  <style>
    body { background: #090d16; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 18px; max-width: 960px; margin-inline: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #065f46; color: #6ee7b7; }
    h1 { font-size: 22px; color: #38bdf8; margin: 4px 0; }
    h2 { font-size: 16px; color: #e2e8f0; margin: 0 0 12px 0; }
    p { font-size: 13px; color: #94a3b8; margin: 0; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .kpi { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 16px; }
    .kpi-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .kpi-val { font-size: 24px; font-weight: 800; margin-top: 6px; color: #f8fafc; }
    .kpi-sub { font-size: 11px; color: #64748b; margin-top: 4px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 18px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    .bar-row { margin-bottom: 12px; }
    .bar-label { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; color: #e2e8f0; }
    .bar-track { width: 100%; height: 8px; background: #0f172a; border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; background: linear-gradient(90deg, #0284c7, #38bdf8); border-radius: 999px; }
    .payee-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #334155; font-size: 13px; }
    .payee-row:last-child { border-bottom: none; }
    .tx-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 12px; background: #0f172a; border: 1px solid #1e293b; border-radius: 10px; margin-bottom: 8px; }
    .tx-title { font-weight: 700; font-size: 14px; color: #f8fafc; }
    .tx-meta { font-size: 12px; color: #94a3b8; margin-top: 3px; }
    .tx-amt { font-weight: 800; font-size: 15px; white-space: nowrap; }
    .outflow { color: #f87171; }
    .inflow { color: #4ade80; }
    .loan { color: #fbbf24; }
    textarea { width: 100%; box-sizing: border-box; background: #090d16; color: #fff; border: 1px solid #334155; border-radius: 8px; padding: 10px; font-size: 13px; min-height: 68px; margin-top: 8px; }
    button { background: #0284c7; color: #fff; border: none; padding: 11px 16px; border-radius: 10px; font-weight: 700; font-size: 13px; cursor: pointer; margin-top: 8px; }
    button.sec { background: #334155; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <span class="badge">PRIVATE PERSONAL FINANCIAL REPORTER</span>
      <h1>Mercy's M-Pesa, Bank & Okoa Analyzer</h1>
      <p>Automatically separates personal spending, DTB transfers, data bundles & Okoa fees from Till 5758419.</p>
    </div>
    <div>
      <button class="sec" onclick="window.location.href='/till-app'">🏪 Switch to Till 5758419 Relay</button>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Total Tracked Spending</div>
      <div class="kpi-val outflow" id="kpiSpent">KES 0</div>
      <div class="kpi-sub" id="kpiCount">0 transactions analyzed</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Latest M-Pesa Balance</div>
      <div class="kpi-val inflow" id="kpiBal">--</div>
      <div class="kpi-sub">From most recent M-Pesa SMS</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Unpaid Okoa Jahazi Debt</div>
      <div class="kpi-val loan" id="kpiOkoa">KES 0</div>
      <div class="kpi-sub">Live Safaricom Okoa balance</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Fees & Okoa Interest</div>
      <div class="kpi-val" style="color:#fb923c;" id="kpiFees">KES 0</div>
      <div class="kpi-sub">Transaction fees + Okoa charges</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>📊 How Your Money Was Spent (By Category)</h2>
      <div id="catList">Loading categories...</div>
    </div>
    <div class="card">
      <h2>🏆 Where Your Money Went (Top Payees)</h2>
      <div id="payeeList">Loading payees...</div>
    </div>
  </div>

  <div class="card">
    <h2>➕ Log or Test Any M-Pesa / Bank / Okoa SMS</h2>
    <p>Your Redmi Note 12 forwards personal SMS automatically. You can also paste any SMS below to analyze it:</p>
    <textarea id="manualSms" placeholder="Paste any M-Pesa, DTB, or Okoa Jahazi SMS here..."></textarea>
    <button onclick="ingestSms()">🔍 Analyze & Add to Financial Report</button>
  </div>

  <div class="card">
    <h2>📜 Categorized Personal Transaction Ledger</h2>
    <div id="txList">Loading ledger...</div>
  </div>

  <script>
    async function loadReport() {
      const r = await fetch('/api/finance/report');
      const d = await r.json();
      document.getElementById('kpiSpent').textContent = 'KES ' + (d.total_spent || 0).toLocaleString();
      document.getElementById('kpiCount').textContent = (d.total_transactions || 0) + ' messages analyzed';
      document.getElementById('kpiBal').textContent = d.latest_mpesa_balance !== null ? 'KES ' + d.latest_mpesa_balance.toLocaleString() : 'N/A';
      document.getElementById('kpiOkoa').textContent = d.latest_okoa_debt !== null ? 'KES ' + d.latest_okoa_debt.toLocaleString() : 'KES 0';
      document.getElementById('kpiFees').textContent = 'KES ' + (d.total_fees_and_okoa_interest || 0).toLocaleString();

      const cats = d.category_breakdown || [];
      document.getElementById('catList').innerHTML = cats.length
        ? cats.map(c => \`
          <div class="bar-row">
            <div class="bar-label"><span>\${c.category}</span><strong>KES \${c.amount.toLocaleString()} (\${c.share_pct}%)</strong></div>
            <div class="bar-track"><div class="bar-fill" style="width:\${Math.max(4, c.share_pct)}%"></div></div>
          </div>\`).join('')
        : '<p>No spending categories yet.</p>';

      const payees = d.top_payees || [];
      document.getElementById('payeeList').innerHTML = payees.length
        ? payees.map((p, i) => \`
          <div class="payee-row">
            <span><strong>#\${i+1}</strong> \${p.counterparty}</span>
            <strong>KES \${p.amount.toLocaleString()}</strong>
          </div>\`).join('')
        : '<p>No payees recorded yet.</p>';

      const txs = d.transactions || [];
      document.getElementById('txList').innerHTML = txs.length
        ? txs.map(t => {
            const cls = t.direction === 'INFLOW' ? 'inflow' : (t.direction === 'LOAN_ADVANCE' ? 'loan' : 'outflow');
            const sign = t.direction === 'INFLOW' ? '+' : (t.direction === 'LOAN_ADVANCE' ? 'ADVANCE ' : '-');
            const dt = new Date(t.timestamp).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
            return \`
              <div class="tx-row">
                <div>
                  <div class="tx-title">\${t.counterparty} <span style="font-weight:400;font-size:12px;color:#38bdf8;">[\${t.category}]</span></div>
                  <div class="tx-meta">Ref: <code>\${t.ref_code}</code> • \${dt}\${t.fee ? ' • Fee: KES ' + t.fee : ''}\${t.mpesa_balance !== null && t.mpesa_balance !== undefined ? ' • Bal: KES ' + t.mpesa_balance : ''}</div>
                </div>
                <div class="tx-amt \${cls}">\${sign}KES \${(t.amount || 0).toLocaleString()}</div>
              </div>\`;
          }).join('')
        : '<p>No transactions yet.</p>';
    }

    async function ingestSms() {
      const text = document.getElementById('manualSms').value.trim();
      if (!text) return;
      await fetch('/api/finance/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      document.getElementById('manualSms').value = '';
      loadReport();
    }

    loadReport();
  </script>
</body>
</html>`);
    }


    // =========================================================================
    // BLACKBOXED STOREFRONT & ORDER API (Stage 5 API Layer)
    // =========================================================================

    // 1. GET /api/v1/storefront/:slug/catalog
  return false;
}

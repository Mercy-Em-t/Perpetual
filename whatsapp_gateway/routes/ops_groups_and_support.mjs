/**
 * Operations, WhatsApp Groups, Support Tickets, Scaling Sentinel & Broadcast Routes
 * Extracted from http_routes.mjs (see routes/INDEX.md)
 */
import { parseJsonBody } from "../http_helpers.mjs";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config.mjs";
import { createSupportTicket, resolveSupportTicket, listSupportTickets, formatTicketCard } from "../support_tickets.mjs";
import { runScalingCheck, getLastScalingReport } from "../scaling_sentinel.mjs";
import { runOrderLifecycleProbe } from "../order_lifecycle_probe.mjs";

let lastLifecycleProbeReport = null;

export async function handleOpsGroupsAndSupportRoutes({
  req,
  res,
  parsedUrl,
  GROUPS,
  getConnectionState,
  getBotJid,
  safeSendMessage,
  getSock,
  sharedOrderGuard,
}) {
    if (req.method === "GET" && parsedUrl.pathname === "/api/all-participating") {
      try {
        const sock = getSock ? getSock() : null;
        if (!sock) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Socket not ready" }));
        }
        const allGroups = await sock.groupFetchAllParticipating();
        const list = Object.values(allGroups).map(g => ({
          id: g.id,
          subject: g.subject,
          owner: g.owner,
          creation: g.creation ? new Date(g.creation * 1000).toISOString() : null,
          participantsCount: g.participants ? g.participants.length : 0,
          isCommunity: Boolean(g.isCommunity),
          isCommunityAnnounce: Boolean(g.isCommunityAnnounce),
          linkedParent: g.linkedParent || null
        }));
        res.writeHead(200);
        return res.end(JSON.stringify({ count: list.length, groups: list }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/groups/create
    if (req.method === "POST" && parsedUrl.pathname === "/api/groups/create") {
      try {
        const sock = getSock ? getSock() : null;
        if (!sock) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Socket not ready" }));
        }
        const body = await parseJsonBody(req);
        const title = body.title || body.name;
        if (!title) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing title" }));
        }
        const participants = body.participants || [];
        const result = await sock.groupCreate(title, participants);
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, group: result }));
      } catch (err) {
        console.error("[GROUP CREATE ERROR]", err);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/groups/invites (Fetches or generates invite links for all departmental groups)
    if (req.method === "GET" && parsedUrl.pathname === "/api/groups/invites") {
      try {
        const sock = getSock ? getSock() : null;
        if (!sock) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Socket not ready" }));
        }
        const invites = {};
        for (const [key, grp] of Object.entries(GROUPS)) {
          if (!grp.jid) continue;
          try {
            const code = await sock.groupInviteCode(grp.jid);
            invites[key] = {
              name: grp.name,
              jid: grp.jid,
              invite_url: `https://chat.whatsapp.com/${code}`
            };
          } catch (e) {
            invites[key] = {
              name: grp.name,
              jid: grp.jid,
              error: e.message
            };
          }
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, invites }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/groups/add-participant (Directly adds a phone number to a group)
    if (req.method === "POST" && parsedUrl.pathname === "/api/groups/add-participant") {
      try {
        const sock = getSock ? getSock() : null;
        if (!sock) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Socket not ready" }));
        }
        const body = await parseJsonBody(req);
        const { groupJid, phone, role } = body;
        const targetJid = groupJid || (role && GROUPS[role]?.jid) || GROUPS.general.jid;
        
        if (!phone) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing 'phone' number" }));
        }
        const digits = phone.replace(/\D/g, "");
        const cleanDigits = digits.startsWith("0") ? `254${digits.slice(1)}` : (digits.startsWith("254") ? digits : `254${digits}`);
        const userJid = `${cleanDigits}@s.whatsapp.net`;

        const updateResult = await sock.groupParticipantsUpdate(targetJid, [userJid], "add");
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, userJid, targetJid, result: updateResult }));
      } catch (err) {
        console.error("[ADD PARTICIPANT ERROR]", err);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/shops/provision
    if (req.method === "POST" && parsedUrl.pathname === "/api/shops/provision") {
      try {
        const sock = getSock ? getSock() : null;
        const body = await parseJsonBody(req);
        const { name, slug, phone, owner_phone, currency = "KES", pipeline_type = "kitchen" } = body;

        if (!name || !slug) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing required fields: 'name' and 'slug'" }));
        }

        const contactPhone = owner_phone || phone || "";
        let participantJid = null;
        if (contactPhone) {
          const digits = contactPhone.replace(/\D/g, "");
          const cleanDigits = digits.startsWith("0") ? `254${digits.slice(1)}` : digits;
          if (cleanDigits.length >= 9) {
            participantJid = `${cleanDigits}@s.whatsapp.net`;
          }
        }
        const participants = participantJid ? [participantJid] : [];

        // 1. Check or Insert Shop in Supabase
        let shopRecord = null;
        const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?slug=eq.${slug}&select=*`, {
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          }
        });
        const existing = await existingRes.json();
        if (Array.isArray(existing) && existing.length > 0) {
          shopRecord = existing[0];
        } else {
          const createRes = await fetch(`${SUPABASE_URL}/rest/v1/shops`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=representation"
            },
            body: JSON.stringify({
              name,
              slug,
              phone: contactPhone,
              whatsapp_number: contactPhone,
              fulfillment_settings: {
                pipeline_type,
                currency
              }
            })
          });
          const created = await createRes.json();
          shopRecord = Array.isArray(created) ? created[0] : created;
        }

        // 2. Create WhatsApp Groups via Baileys if socket is active
        let operationsGroup = null;
        let managementGroup = null;
        let operationsInvite = null;
        let managementInvite = null;

        if (sock) {
          try {
            // Floor Operations Group
            operationsGroup = await sock.groupCreate(`${name} - Operations`, participants);
            try {
              const code = await sock.groupInviteCode(operationsGroup.id);
              operationsInvite = `https://chat.whatsapp.com/${code}`;
            } catch (e) {
              console.warn("[PROVISION] Could not get operations invite code:", e.message);
            }

            // Management Group
            managementGroup = await sock.groupCreate(`${name} - Management`, participants);
            try {
              const code = await sock.groupInviteCode(managementGroup.id);
              managementInvite = `https://chat.whatsapp.com/${code}`;
            } catch (e) {
              console.warn("[PROVISION] Could not get management invite code:", e.message);
            }

            // Send welcoming card to Operations group
            await safeSendMessage(operationsGroup.id, {
              text: `🏬 *Welcome to ${name} — Operations Hub!*\n\n` +
                    `This channel coordinates real-time order fulfillments and kitchen stations.\n\n` +
                    `*Staff Commands:*\n` +
                    `• *!orders* — View active order pipeline\n` +
                    `• *!paid <order_id> <ref>* — Confirm payment\n` +
                    `• *!cook <order_id>* — Mark cooking finished\n` +
                    `• *!pack <order_id>* — Box goods & food\n` +
                    `• *!dispatch <order_id> <rider>* — Hand off to courier\n\n` +
                    `_Live connected to TMS Whitelabel platform._`
            });

            // Send welcoming card to Management group
            await safeSendMessage(managementGroup.id, {
              text: `💼 *Welcome to ${name} — Management Oversight!*\n\n` +
                    `This channel receives daily sales pulses, executive summaries, and P&L rollups.\n\n` +
                    `*Manager Commands:*\n` +
                    `• *!summary* — Gross revenue & order counts\n` +
                    `• *!status* — Open orders & till status\n` +
                    `• *!product add* — Add new catalog product\n\n` +
                    `_All updates publish live to your TMS Storefront._`
            });
          } catch (grpErr) {
            console.error("[PROVISION] Error creating WhatsApp groups:", grpErr.message);
          }
        }

        // 3. Update Supabase Shop with Complete Self-Contained Configuration & WhatsApp Routing
        const currentSettings = shopRecord.fulfillment_settings || {};
        const isFoodPipeline = pipeline_type === "kitchen" || body.industry_type === "food" || body.industry_type === "restaurant";
        const defaultStations = isFoodPipeline
          ? [
              { id: "pending_payment", label: "Awaiting Payment", icon: "⏳", notify_customer: false, notify_ops: true, command_triggers: [] },
              { id: "confirmed", label: "Order Confirmed", icon: "✅", notify_customer: true, notify_ops: true, command_triggers: ["!paid", "!confirm"] },
              { id: "cooking", label: "In Kitchen", icon: "🍳", notify_customer: true, notify_ops: false, command_triggers: ["!cook", "!prep", "!kitchen"] },
              { id: "packed", label: "Packed & Boxed", icon: "🥡", notify_customer: true, notify_ops: true, command_triggers: ["!pack", "!ready"] },
              { id: "out_for_delivery", label: "Out for Delivery", icon: "🛵", notify_customer: true, notify_ops: true, command_triggers: ["!dispatch", "!deliver"] },
              { id: "completed", label: "Delivered", icon: "🎉", notify_customer: true, notify_ops: false, command_triggers: ["!done", "!complete"] }
            ]
          : [
              { id: "pending_payment", label: "Awaiting Payment", icon: "⏳", notify_customer: false, notify_ops: true, command_triggers: [] },
              { id: "confirmed", label: "Order Confirmed", icon: "✅", notify_customer: true, notify_ops: true, command_triggers: ["!paid", "!confirm"] },
              { id: "picking", label: "Picking Items", icon: "🪡", notify_customer: true, notify_ops: false, command_triggers: ["!pick", "!prepare"] },
              { id: "packed", label: "Packed & Boxed", icon: "📦", notify_customer: true, notify_ops: true, command_triggers: ["!pack", "!ready"] },
              { id: "dispatched", label: "Out for Delivery", icon: "🛵", notify_customer: true, notify_ops: true, command_triggers: ["!dispatch", "!deliver"] },
              { id: "completed", label: "Delivered", icon: "🎉", notify_customer: true, notify_ops: false, command_triggers: ["!done", "!complete"] }
            ];

        const orderPrefix = body.order_prefix || currentSettings.whatsapp_routing?.order_prefix || slug.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || "TMS";
        const isPreorder = Boolean(body.is_preorder ?? currentSettings.is_preorder ?? false);
        const pickupPoints = Array.isArray(body.pickup_points)
          ? body.pickup_points
          : (Array.isArray(currentSettings.pickup_points) ? currentSettings.pickup_points : []);

        const updatedSettings = {
          ...currentSettings,
          currency,
          pipeline_type,
          is_preorder: isPreorder,
          preorder_mode: isPreorder,
          cutoff_time: body.cutoff_time || currentSettings.cutoff_time || (isPreorder ? "17:00" : null),
          accepts_pickup: body.accepts_pickup ?? currentSettings.accepts_pickup ?? true,
          accepts_delivery: body.accepts_delivery ?? currentSettings.accepts_delivery ?? true,
          accepts_dine_in: body.accepts_dine_in ?? currentSettings.accepts_dine_in ?? isFoodPipeline,
          accepts_pickup_point: body.accepts_pickup_point ?? currentSettings.accepts_pickup_point ?? (pickupPoints.length > 0),
          pickup_points: pickupPoints,
          pipeline_stations: (Array.isArray(currentSettings.pipeline_stations) && currentSettings.pipeline_stations.length > 0)
            ? currentSettings.pipeline_stations
            : defaultStations,
          whatsapp_routing: {
            ...(currentSettings.whatsapp_routing || {}),
            order_prefix: orderPrefix,
            operations_jid: operationsGroup ? operationsGroup.id : (body.operations_jid || currentSettings.whatsapp_routing?.operations_jid || null),
            operations_invite: operationsInvite || (currentSettings.whatsapp_routing?.operations_invite || null),
            management_jid: managementGroup ? managementGroup.id : (body.management_jid || currentSettings.whatsapp_routing?.management_jid || null),
            management_invite: managementInvite || (currentSettings.whatsapp_routing?.management_invite || null),
            community_jid: body.community_jid || currentSettings.whatsapp_routing?.community_jid || null
          }
        };

        if (shopRecord.id) {
          await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${shopRecord.id}`, {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              fulfillment_settings: updatedSettings,
              mpesa_till_number: body.mpesa_till_number || shopRecord.mpesa_till_number || "5758419"
            })
          });
        }

        // 4. Write local config/shops/<slug>.json so room_server (:5050) has immediate pipeline parity
        try {
          const fsMod = await import("fs");
          const pathMod = await import("path");
          const configDir = pathMod.resolve(process.cwd(), "..", "config", "shops");
          if (fsMod.existsSync(configDir)) {
            const localShopJson = {
              shop_id: shopRecord.id,
              shop_slug: slug,
              shop_name: name,
              order_prefix: orderPrefix,
              brand: {
                tagline: shopRecord.tagline || `${name} Storefront`,
                currency,
                support_phone: contactPhone,
                mpesa_till: body.mpesa_till_number || shopRecord.mpesa_till_number || "5758419"
              },
              whatsapp_groups: {
                operations_jid: updatedSettings.whatsapp_routing.operations_jid,
                admin_oversight_jid: updatedSettings.whatsapp_routing.management_jid,
                community_jid: updatedSettings.whatsapp_routing.community_jid
              },
              fulfillment: {
                accepts_pickup: updatedSettings.accepts_pickup,
                accepts_delivery: updatedSettings.accepts_delivery,
                accepts_dine_in: updatedSettings.accepts_dine_in,
                accepts_pickup_point: updatedSettings.accepts_pickup_point,
                pickup_points: updatedSettings.pickup_points,
                preorder_cutoff_hour: updatedSettings.is_preorder ? 17 : null
              },
              pipeline: {
                stations: updatedSettings.pipeline_stations
              }
            };
            fsMod.writeFileSync(pathMod.join(configDir, `${slug}.json`), JSON.stringify(localShopJson, null, 2), "utf-8");
          }
        } catch (cfgErr) {
          console.warn("[PROVISION] Local config sync warning:", cfgErr.message);
        }

        // Invalidate cache
        await getAllShops(true);

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          shop: {
            id: shopRecord.id,
            name: shopRecord.name || name,
            slug: shopRecord.slug || slug
          },
          whatsapp: {
            operations: {
              jid: operationsGroup ? operationsGroup.id : null,
              invite_url: operationsInvite
            },
            management: {
              jid: managementGroup ? managementGroup.id : null,
              invite_url: managementInvite
            }
          }
        }));
      } catch (err) {
        console.error("[SHOP PROVISION ERROR]", err);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /health
    if (req.method === "GET" && parsedUrl.pathname === "/health") {
      res.writeHead(200);
      return res.end(JSON.stringify({
        status: "ok",
        connection: getConnectionState(),
        bot_jid: getBotJid(),
        groups: {
          general: { name: GROUPS.general.name, jid: GROUPS.general.jid },
          itHelpdesk: { name: GROUPS.itHelpdesk.name, jid: GROUPS.itHelpdesk.jid },
          adminOversight: { name: GROUPS.adminOversight.name, jid: GROUPS.adminOversight.jid }
        }
      }));
    }

    // POST /api/support/ticket (Open tracked incident in Perpetua - IT Helpdesk)
    if (req.method === "POST" && parsedUrl.pathname === "/api/support/ticket") {
      try {
        const body = await parseJsonBody(req);
        const descriptionText = String(body.description || body.message || body.summary || "").trim();
        if (!descriptionText) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "A non-empty ticket description is required." }));
        }

        const remoteAddr = req.socket?.remoteAddress || "";
        const isLocal = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
        const hasInternalKey = Boolean(
          process.env.INTERNAL_API_KEY && req.headers["x-internal-key"] === process.env.INTERNAL_API_KEY
        );
        const isTrustedProbe = isLocal || hasInternalKey;
        const isDryRun = (parsedUrl.searchParams.get("dryRun") === "true" || body.dryRun === true) && isTrustedProbe;

        if (isDryRun) {
          const simulatedTicket = {
            id: "INC-DRYRUN",
            title: String(body.title || descriptionText.slice(0, 80)),
            description: descriptionText,
            source: body.source || "API",
            severity: body.severity || "MEDIUM",
            status: "DRY_RUN",
            dryRun: true,
          };
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, dryRun: true, ticket: simulatedTicket }));
        }

        const ticket = createSupportTicket({
          title: body.title || descriptionText.slice(0, 80),
          description: descriptionText,
          source: body.source || "API",
          severity: body.severity || "MEDIUM",
          shopSlug: body.shopSlug || body.shop_slug || null,
          orderRef: body.orderRef || body.order_ref || null,
          reportedBy: body.reportedBy || body.reported_by || "Storefront / Ops"
        });
        const card = formatTicketCard(ticket);
        const isSilentProbe = isTrustedProbe && Boolean(body.silent || body.isProbe);
        if (!isSilentProbe && GROUPS.itHelpdesk?.jid) {
          await safeSendMessage(GROUPS.itHelpdesk.jid, { text: card });
        }
        res.writeHead(201);
        return res.end(JSON.stringify({ success: true, ticket }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/support/tickets
    if (req.method === "GET" && parsedUrl.pathname === "/api/support/tickets") {
      const status = parsedUrl.searchParams.get("status") || "ACTIVE";
      const tickets = listSupportTickets({ status });
      res.writeHead(200);
      return res.end(JSON.stringify({ count: tickets.length, tickets }));
    }

    // POST /api/support/ticket/resolve
    if (req.method === "POST" && parsedUrl.pathname === "/api/support/ticket/resolve") {
      try {
        const body = await parseJsonBody(req);
        const ticketId = body.ticketId || body.ticket_id;
        if (!ticketId) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing 'ticketId'" }));
        }
        const ticket = resolveSupportTicket(
          ticketId,
          body.notes || "Resolved by operator",
          body.actor || "Ops / API"
        );
        if (!ticket) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: `Ticket ${ticketId} not found` }));
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, ticket }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/bridge/executive-feed (Unified Ops <-> Perpetual DIKW Bridge Feed)
    if (req.method === "GET" && parsedUrl.pathname === "/api/bridge/executive-feed") {
      const allTickets = listSupportTickets({ status: "ALL" });
      const activeTickets = allTickets.filter((t) => t.status !== "RESOLVED" && t.status !== "CLOSED");
      const resolvedTickets = allTickets.filter((t) => t.status === "RESOLVED" || t.status === "CLOSED");
      const sentinel = getLastScalingReport();
      const guardState = sharedOrderGuard?.state || {};

      res.writeHead(200);
      return res.end(JSON.stringify({
        bridge: {
          status: "UP",
          service: "perpetual-whatsapp-gateway",
          timestamp: new Date().toISOString(),
          uptimeSec: Math.round(process.uptime()),
          whatsappConnection: getConnectionState(),
          botJid: getBotJid(),
          groupsCount: Object.keys(GROUPS || {}).length,
        },
        sentinel,
        tickets: {
          total: allTickets.length,
          activeCount: activeTickets.length,
          resolvedCount: resolvedTickets.length,
          active: activeTickets.slice(0, 20),
          recentResolved: resolvedTickets.slice(0, 10),
        },
        orderGuard: {
          policiesCount: Object.keys(guardState.policies || {}).length,
          activeHoldsCount: Object.values(guardState.holds || {}).filter((h) => h.status === "HELD").length,
          dailyPoolsCount: Object.keys(guardState.daily_pools || {}).length,
        },
        groups: GROUPS,
      }));
    }

    // GET /api/order-guard/live-telemetry (Real-time Order Guard holds/pools/TTLs + latest 7x1000 probe)
    if (req.method === "GET" && parsedUrl.pathname === "/api/order-guard/live-telemetry") {
      try {
        if (sharedOrderGuard) {
          await sharedOrderGuard.sweepExpiredHolds();
        }
        const nowMs = Date.now();
        const guardState = sharedOrderGuard?.state || {};
        if (!lastLifecycleProbeReport) {
          lastLifecycleProbeReport = await runOrderLifecycleProbe({ sampleId: "ALL", requestsPerSample: 1000 });
        }

        const allHolds = Object.values(guardState.holds || {});
        const statusCounts = {
          HELD: 0,
          NEEDS_APPROVAL: 0,
          COMMITTED: 0,
          EXPIRED: 0,
          RELEASED: 0,
          CANCELLED: 0,
          REFUND_REQUIRED: 0,
        };
        for (const h of allHolds) {
          const st = String(h.status || "").toUpperCase();
          statusCounts[st] = (statusCounts[st] || 0) + 1;
        }

        const holdsList = allHolds
          .slice()
          .sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0))
          .slice(0, 50)
          .map((h) => ({
            order_id: h.order_id,
            shop_id: h.shop_id,
            sale_date: h.sale_date,
            status: h.status,
            total_value: h.total_value,
            items: h.items,
            created_at: h.created_at,
            updated_at: h.updated_at,
            expires_at: h.expires_at,
            grace_until: h.grace_until,
            remaining_hold_ms: Math.max(0, Number(h.expires_at || 0) - nowMs),
            remaining_grace_ms: Math.max(0, Number(h.grace_until || h.expires_at || 0) - nowMs),
            customer_hash_prefix: String(h.customer_hash || "").slice(0, 8),
          }));

        const poolsList = Object.values(guardState.daily_pools || {}).map((p) => {
          const cap = p.daily_cap === null || p.daily_cap === undefined ? null : Number(p.daily_cap);
          const held = Number(p.held || 0);
          const sold = Number(p.sold || 0);
          return {
            ...p,
            available: cap === null ? null : Math.max(0, cap - held - sold),
          };
        });
        const policiesList = Object.values(guardState.policies || {});

        res.writeHead(200);
        return res.end(JSON.stringify({
          ok: true,
          timestamp: new Date(nowMs).toISOString(),
          bridge: {
            whatsappConnection: getConnectionState(),
            uptimeSec: Math.round(process.uptime()),
          },
          config: {
            holdTtlMs: sharedOrderGuard?.defaultHoldTtlMs ?? 600000,
            graceTtlMs: sharedOrderGuard?.defaultGraceTtlMs ?? 180000,
            approvalHoldTtlMs: sharedOrderGuard?.approvalHoldTtlMs ?? 1800000,
            maxOrderValue: sharedOrderGuard?.defaultMaxOrderValue ?? 20000,
            tillLookbackMs: 600000,
            radarMaxPollSec: 60,
            menuCacheTtlHours: 1,
            duplicateGuardWindowSec: 30,
            backoff: {
              maxRetries: 2,
              baseDelayMs: 60,
              maxDelayMs: 800,
              retryableStatuses: [502, 503, 504],
            },
          },
          summary: {
            policiesCount: policiesList.length,
            poolsCount: poolsList.length,
            totalHoldsTracked: allHolds.length,
            statusCounts,
          },
          pools: poolsList,
          policies: policiesList,
          activeHolds: holdsList,
          lastProbeReport: lastLifecycleProbeReport,
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // POST /api/order-guard/run-probe (On-demand 7x1000 resilience stress & chaos probe)
    if (req.method === "POST" && parsedUrl.pathname === "/api/order-guard/run-probe") {
      try {
        const body = await parseJsonBody(req).catch(() => ({}));
        const requestedSample = body?.sample || "ALL";
        const report = await runOrderLifecycleProbe({
          sampleId: requestedSample,
          requestsPerSample: 1000,
        });
        if (!requestedSample || String(requestedSample).toUpperCase() === "ALL") {
          lastLifecycleProbeReport = report;
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, report }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // GET /api/sentinel/scaling-status
    if (req.method === "GET" && parsedUrl.pathname === "/api/sentinel/scaling-status") {
      const report = getLastScalingReport() || await runScalingCheck({ safeSendMessage });
      res.writeHead(200);
      return res.end(JSON.stringify(report));
    }

    // POST /api/sentinel/check-now
    if (req.method === "POST" && parsedUrl.pathname === "/api/sentinel/check-now") {
      try {
        const body = await parseJsonBody(req).catch(() => ({}));
        const report = await runScalingCheck({
          safeSendMessage,
          forceAlert: Boolean(body?.forceAlert)
        });
        res.writeHead(200);
        return res.end(JSON.stringify(report));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /groups
    if (req.method === "GET" && parsedUrl.pathname === "/groups") {
      res.writeHead(200);
      return res.end(JSON.stringify({ groups: GROUPS }));
    }

    // POST /api/notify-group (Direct card message to specific group key or direct JID)
    if (req.method === "POST" && parsedUrl.pathname === "/api/notify-group") {
      try {
        const body = await parseJsonBody(req);
        const directJid = body.jid || (typeof body.group === "string" && body.group.includes("@") ? body.group : null);
        const groupKey = body.group || "general";
        const targetGroup = GROUPS[groupKey] || GROUPS.general;
        const resolvedJid = directJid || targetGroup?.jid;

        if (!resolvedJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: `Group '${groupKey}' JID not resolved` }));
        }

        const msgText = body.message || body.text;
        if (!msgText) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing message text" }));
        }

        await safeSendMessage(resolvedJid, { text: msgText });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", group: groupKey, jid: resolvedJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/eod-report (Trigger Live End-of-Day Multi-Tenant Register Reconciliation)
    if ((req.method === "POST" || req.method === "GET") && parsedUrl.pathname === "/api/eod-report") {
      try {
        let body = {};
        if (req.method === "POST") {
          try { body = await parseJsonBody(req); } catch (ignored) {}
        }
        const mode = body.mode || parsedUrl.searchParams.get("mode") || (body.shop || parsedUrl.searchParams.get("shop") ? "shop" : "dual");
        const shopSlug = body.shop || parsedUrl.searchParams.get("shop") || "test-shop";
        const sendToWhatsApp = body.dispatch !== false && parsedUrl.searchParams.get("dispatch") !== "false";

        const {
          generateShopEODReport,
          generatePlatformEODReport,
          runFullDualEODReconciliation
        } = await import("./eod_reconciler.mjs");

        if (mode === "platform") {
          const report = await generatePlatformEODReport();
          let dispatched = false;
          if (sendToWhatsApp) {
            const platformJid = GROUPS.adminOversight?.jid || "120363415291701803@g.us";
            await safeSendMessage(platformJid, { text: report.formattedWhatsAppMessage });
            dispatched = true;
          }
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, mode: "platform", report, dispatched }, null, 2));
        }

        if (mode === "shop") {
          const report = await generateShopEODReport(shopSlug);
          let dispatched = false;
          if (sendToWhatsApp) {
            const targetJid = report.targetJid || GROUPS.adminOversight?.jid;
            if (targetJid) {
              await safeSendMessage(targetJid, { text: report.formattedWhatsAppMessage });
              dispatched = true;
            }
          }
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, mode: "shop", shop: shopSlug, report, dispatched }, null, 2));
        }

        // Default: Full Dual Reconciliation (Each active shop receives their report + platform rollup to community)
        const result = await runFullDualEODReconciliation({
          dispatch: sendToWhatsApp,
          sendFn: safeSendMessage
        });

        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          mode: "dual",
          platformReport: result.platformReport,
          activeShopsCount: result.shopReports.length,
          shopReports: result.shopReports,
          dispatchResults: result.dispatchResults
        }, null, 2));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    }

    // POST /api/notify-customer-order (Instant WhatsApp Confirmation to Customer Phone)
    if (req.method === "POST" && parsedUrl.pathname === "/api/notify-customer-order") {
      try {
        const body = await parseJsonBody(req);
        const orderId = body.order_id || body.orderId || body.id;
        if (!orderId) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Missing order_id" }));
        }
        const { sendCustomerOrderConfirmation } = await import("./customer_notifier.mjs");
        const result = await sendCustomerOrderConfirmation(orderId, safeSendMessage);
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    }

    // POST /api/broadcast-task (General / Operations)
    if (req.method === "POST" && parsedUrl.pathname === "/api/broadcast-task") {
      try {
        const body = await parseJsonBody(req);
        const targetJid = GROUPS.general.jid;
        if (!targetJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "General group not bound" }));
        }

        const icon = body.status === "DONE" ? "✅" : body.status === "IN_PROGRESS" ? "🟣" : body.status === "CLAIMED" ? "🔵" : "🟡";
        const msg =
          `${icon} *[TASK UPDATE]* \`${body.task_id || "TASK"}\`\n` +
          `• *Title:* ${body.title || "Untitled"}\n` +
          `• *State:* ${body.status}\n` +
          `• *Scope:* Perpetua Shared Room`;

        await safeSendMessage(targetJid, { text: msg });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", jid: targetJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/broadcast-error (IT Helpdesk)
    if (req.method === "POST" && parsedUrl.pathname === "/api/broadcast-error") {
      try {
        const body = await parseJsonBody(req);
        const targetJid = GROUPS.itHelpdesk.jid;
        if (!targetJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "IT Helpdesk group not bound" }));
        }

        const msg =
          `🚨 *[IT INCIDENT ALERT]*\n` +
          `• *Error:* ${body.error_type || "RUNTIME_ERROR"}\n` +
          `• *Title:* ${body.title || "Unspecified"}\n` +
          (body.task_id ? `• *Task:* \`${body.task_id}\`\n` : "") +
          `• *Trace:* \`${body.error_details || "No trace"}\`\n` +
          `_Desk: Use !ticket or !resolve to track._`;

        await safeSendMessage(targetJid, { text: msg });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", jid: targetJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/broadcast-admin (Admin Oversight)
    if (req.method === "POST" && parsedUrl.pathname === "/api/broadcast-admin") {
      try {
        const body = await parseJsonBody(req);
        const targetJid = GROUPS.adminOversight.jid;
        if (!targetJid) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Admin group not bound" }));
        }

        const msg =
          `📊 *[ADMIN AUDIT]*\n` +
          `• *Action:* ${body.action}\n` +
          `• *Actor:* ${body.actor || "SYSTEM"}\n` +
          (body.task_id ? `• *Task:* \`${body.task_id}\`\n` : "") +
          `• *Time:* ${new Date().toISOString()}`;

        await safeSendMessage(targetJid, { text: msg });
        res.writeHead(200);
        return res.end(JSON.stringify({ status: "dispatched", jid: targetJid }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /order (TMS Whitelabel Core Order Ingress Bridge + Instant Pre-Paid Till Pool Lookback)
  return false;
}

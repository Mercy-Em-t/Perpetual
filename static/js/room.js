// Shared Agent Room DOM Controller & Poller
const API = {
  STATE: "/room/state",
  TASKS: "/api/tasks",
  MESSAGES: "/api/messages",
  AGENTS: "/api/agents",
  HEARTBEAT: "/api/agents/heartbeat",
  INGEST: "/api/drive/ingest",
  TICKETS: "/api/tickets"
};

let currentAgentId = "BrowserAgent_" + Math.random().toString(36).substring(2, 6);
let pollInterval = null;
let dropletTextureURL = null;

// ============================================================================
// Procedural Canvas Droplet Texture (Derived from droplet chat.html)
// ============================================================================
function createDropletTexture() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 380;
    const ctx = canvas.getContext('2d');

    // Base Lavender-Cyan Wash
    const bgGrad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    bgGrad.addColorStop(0, '#c8d8f0');
    bgGrad.addColorStop(0.5, '#bce3e8');
    bgGrad.addColorStop(1, '#d3c4f2');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Vertical Rain/Condensation Streaks
    ctx.strokeStyle = 'rgba(138, 110, 214, 0.22)';
    ctx.lineWidth = 2;
    for (let x = 8; x < canvas.width; x += 14) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 6, canvas.height);
      ctx.stroke();
    }

    // Organic Yellow-Lime Stems
    const stems = [
      [190, 40, 165, 110],
      [240, 140, 210, 200],
      [150, 250, 130, 310],
      [370, 160, 340, 220]
    ];
    stems.forEach(([x1, y1, x2, y2]) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(x1 - 15, (y1 + y2) / 2, x2, y2);
      ctx.strokeStyle = '#e5f255';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.stroke();
    });

    // Translucent Teal & Violet Droplets
    const drops = [
      { x: 55, y: 80, rx: 22, ry: 30 },
      { x: 115, y: 72, rx: 28, ry: 38 },
      { x: 180, y: 140, rx: 26, ry: 36 },
      { x: 85, y: 175, rx: 20, ry: 26 },
      { x: 145, y: 245, rx: 32, ry: 40 },
      { x: 255, y: 95, rx: 27, ry: 36 },
      { x: 245, y: 215, rx: 30, ry: 38 },
      { x: 315, y: 235, rx: 22, ry: 28 },
      { x: 350, y: 120, rx: 28, ry: 38 },
      { x: 430, y: 90, rx: 26, ry: 35 },
      { x: 415, y: 225, rx: 32, ry: 42 },
      { x: 470, y: 185, rx: 22, ry: 30 },
      { x: 310, y: 315, rx: 26, ry: 32 }
    ];

    drops.forEach((d) => {
      ctx.save();
      ctx.translate(d.x, d.y);

      // Charcoal Contact Shadow
      ctx.beginPath();
      ctx.ellipse(3, 5, d.rx, d.ry, 0.15, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20, 42, 46, 0.45)';
      ctx.fill();

      // Main Teal Body
      const grad = ctx.createRadialGradient(-d.rx * 0.25, -d.ry * 0.25, 4, 0, 0, d.ry);
      grad.addColorStop(0, '#1ad1d4');
      grad.addColorStop(0.65, '#077b85');
      grad.addColorStop(1, '#054e57');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, d.rx, d.ry, 0.1, 0, Math.PI * 2);
      ctx.fill();

      // Internal Violet Refraction Arc
      ctx.beginPath();
      ctx.arc(-d.rx * 0.25, 0, d.rx * 0.55, 0.6, 2.5);
      ctx.strokeStyle = 'rgba(158, 66, 245, 0.78)';
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Crisp White Specular Rim
      ctx.beginPath();
      ctx.arc(d.rx * 0.15, -d.ry * 0.1, d.rx * 0.78, -1.1, 1.3);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Specular Catchlight Dot
      ctx.beginPath();
      ctx.arc(-d.rx * 0.3, -d.ry * 0.35, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.restore();
    });

    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn("Could not generate droplet texture canvas", e);
    return "";
  }
}

function ensureDropletTexture() {
  if (!dropletTextureURL) {
    dropletTextureURL = createDropletTexture();
    if (dropletTextureURL) {
      document.documentElement.style.setProperty('--droplet-texture', `url('${dropletTextureURL}')`);
    }
  }
}

// ============================================================================
// Theme Toggle Architecture: Studio Dark <-> Droplet Glass
// ============================================================================
function initTheme() {
  ensureDropletTexture();
  const saved = localStorage.getItem("room_theme");
  const isDroplet = saved === "droplet";
  applyTheme(isDroplet);
}

function toggleTheme() {
  const isDroplet = !document.body.classList.contains("theme-droplet");
  localStorage.setItem("room_theme", isDroplet ? "droplet" : "dark");
  applyTheme(isDroplet);
}

function applyTheme(isDroplet) {
  if (isDroplet) {
    document.body.classList.add("theme-droplet");
    ensureDropletTexture();
  } else {
    document.body.classList.remove("theme-droplet");
  }

  const lblDark = document.getElementById("lbl-dark");
  const lblDroplet = document.getElementById("lbl-droplet");
  if (lblDark && lblDroplet) {
    if (isDroplet) {
      lblDark.classList.remove("active");
      lblDroplet.classList.add("active");
    } else {
      lblDark.classList.add("active");
      lblDroplet.classList.remove("active");
    }
  }
}

function formatTimeCursive(ts, fallback) {
  if (ts) {
    const d = new Date(ts * 1000);
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    return `${h12}:${minutes} ${ampm}`;
  }
  return fallback || '11:09 AM';
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  const agentDisplay = document.getElementById("current-agent-id");
  if (agentDisplay) agentDisplay.textContent = currentAgentId;

  // Initialize theme
  initTheme();

  // Send initial agent heartbeat
  sendHeartbeat();
  setInterval(sendHeartbeat, 30000);

  // Initial fetch and start polling loop (2000ms)
  fetchRoomState();
  pollInterval = setInterval(fetchRoomState, 2000);

  // Setup form submit handlers
  setupEventHandlers();
});

function sendHeartbeat() {
  fetch(API.HEARTBEAT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: currentAgentId,
      name: `Agent (${currentAgentId})`,
      status: "IDLE",
      metadata: { user_agent: navigator.userAgent }
    })
  }).catch(e => console.warn("Heartbeat error", e));
}

async function fetchRoomState() {
  try {
    const res = await fetch(API.STATE);
    if (!res.ok) throw new Error("State response not ok");
    const data = await res.json();

    renderAgents(data.agents || []);
    renderKanban(data.task_pipeline || {});
    renderMessages(data.messages || []);
    renderAssets(data.assets || []);
    renderTickets(data.tickets || []);

    const updatedEl = document.getElementById("last-updated-time");
    if (updatedEl) {
      updatedEl.textContent = new Date().toLocaleTimeString();
    }
    const ticketsEl = document.getElementById("open-tickets-count");
    if (ticketsEl) {
      ticketsEl.textContent = data.tickets_open !== undefined ? data.tickets_open : 0;
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
}

// Render Agents
function renderAgents(agents) {
  const container = document.getElementById("agents-container");
  if (!container) return;

  if (agents.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:1rem;">No registered agents yet.</div>`;
    return;
  }

  container.innerHTML = agents.map(a => {
    let statusClass = "status-offline";
    if (a.is_online) {
      statusClass = a.status === "BUSY" ? "status-busy" : "status-online";
    }
    const isMe = a.agent_id === currentAgentId;

    return `
      <div class="agent-card">
        <div class="agent-header">
          <span class="agent-name">${escapeHtml(a.name || a.agent_id)} ${isMe ? '<span style="color:var(--accent-cyan);font-size:0.75rem;">(You)</span>' : ''}</span>
          <span class="agent-status-pill ${statusClass}">${a.is_online ? a.status : 'OFFLINE'}</span>
        </div>
        <div class="agent-details">
          <div>Last seen: ${a.formatted_last_seen || 'recently'} (${a.seconds_since_heartbeat}s ago)</div>
          ${a.current_task_id ? `<div style="color:var(--accent-amber);font-family:var(--font-mono);margin-top:2px;">Task: ${escapeHtml(a.current_task_id)}</div>` : ''}
        </div>
      </div>
    `;
  }).join("");
}

// Render 5-Stage Kanban Board
function renderKanban(pipeline) {
  const stages = ["PENDING", "CLAIMED", "IN_PROGRESS", "VERIFIED", "DONE"];
  
  stages.forEach(stage => {
    const colKey = stage.toLowerCase().replace("_", "-");
    const container = document.getElementById(`kanban-${colKey}`);
    const badge = document.getElementById(`count-${colKey}`);
    const tasks = pipeline[stage] || [];

    if (badge) badge.textContent = tasks.length;
    if (!container) return;

    if (tasks.length === 0) {
      container.innerHTML = `<div style="color:rgba(255,255,255,0.2);font-size:0.75rem;text-align:center;padding:1.5rem 0.5rem;font-style:italic;">Empty</div>`;
      return;
    }

    container.innerHTML = tasks.map((t, idx) => {
      let priorityClass = "p-norm";
      let pLabel = "NORMAL";
      if (t.priority >= 3) { priorityClass = "p-high"; pLabel = "HIGH"; }
      else if (t.priority <= 1) { priorityClass = "p-low"; pLabel = "LOW"; }

      let leaseHtml = "";
      if (t.lease_remaining_seconds !== null && (t.state === "CLAIMED" || t.state === "IN_PROGRESS")) {
        const leaseSec = t.lease_remaining_seconds;
        const leaseStyle = leaseSec < 15 ? 'style="color:#f43f5e;border-color:#f43f5e;"' : '';
        leaseHtml = `
          <div class="lease-badge" ${leaseStyle}>
            ⏱ Lease: ${leaseSec}s
          </div>
        `;
      }

      let actionsHtml = "";
      if (t.state === "PENDING") {
        actionsHtml = `
          <button class="btn-mini" onclick="taskAction('${t.task_id}', 'claim')">Claim</button>
        `;
      } else if (t.state === "CLAIMED") {
        actionsHtml = `
          <button class="btn-mini" onclick="taskAction('${t.task_id}', 'start')">Start</button>
          <button class="btn-mini" onclick="taskAction('${t.task_id}', 'release')">Release</button>
        `;
      } else if (t.state === "IN_PROGRESS") {
        actionsHtml = `
          <button class="btn-mini" onclick="taskAction('${t.task_id}', 'heartbeat')">Heartbeat</button>
          <button class="btn-mini" onclick="taskAction('${t.task_id}', 'verify')">Verify</button>
          <button class="btn-mini" onclick="taskAction('${t.task_id}', 'release')">Release</button>
        `;
      } else if (t.state === "VERIFIED") {
        actionsHtml = `
          <button class="btn-mini" style="background:#059669;border-color:#10b981;color:#fff;" onclick="taskAction('${t.task_id}', 'complete')">Accept (Done)</button>
          <button class="btn-mini" onclick="taskAction('${t.task_id}', 'reject')">Reject</button>
        `;
      } else if (t.state === "DONE") {
        actionsHtml = `<span style="font-size:0.75rem;font-weight:700;color:var(--accent-emerald);">✓ Completed</span>`;
      }

      // Check for ambient payload metadata (timestamp, audio, anchor)
      const p = t.payload || {};
      let ambientMetaHtml = "";
      if (p.timestamp || p.audio || p.spatial_anchor) {
        ambientMetaHtml = `
          <div style="font-size:0.7rem;margin:0.35rem 0;opacity:0.85;line-height:1.4;">
            ${p.timestamp ? `<div style="font-family:'Caveat',cursive;font-size:1.15rem;font-weight:700;">🕒 ${escapeHtml(p.timestamp)}</div>` : ''}
            ${p.audio ? `<div>🎵 ${escapeHtml(p.audio)}</div>` : ''}
            ${p.spatial_anchor ? `<div>📍 Anchor: <code>${escapeHtml(p.spatial_anchor)}</code></div>` : ''}
          </div>
        `;
      }

      return `
        <div class="task-card" data-index="${idx}">
          <div class="task-top">
            <span class="task-id">${t.task_id}</span>
            <span class="task-priority ${priorityClass}">${pLabel}</span>
          </div>
          <div class="task-title">${escapeHtml(t.title)}</div>
          ${ambientMetaHtml}
          ${leaseHtml}
          ${t.claimed_by ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:0.3rem;">Agent: <span style="color:var(--accent-cyan);font-family:var(--font-mono);">${escapeHtml(t.claimed_by)}</span></div>` : ''}
          <div class="task-actions">
            ${actionsHtml}
          </div>
        </div>
      `;
    }).join("");
  });
}

// Render Messages
function renderMessages(messages) {
  const container = document.getElementById("messages-container");
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:0.75rem;text-align:center;padding:1rem;">No room messages yet.</div>`;
    return;
  }

  container.innerHTML = messages.map(m => {
    let payloadText = "";
    if (typeof m.payload === "object" && m.payload !== null) {
      if (m.payload.message) payloadText = m.payload.message;
      else if (m.payload.title) payloadText = m.payload.title;
      else payloadText = JSON.stringify(m.payload);
    } else {
      payloadText = String(m.payload || "");
    }
    const timeFormatted = formatTimeCursive(m.timestamp, m.formatted_time);

    return `
      <div class="message-bubble">
        <div class="msg-header">
          <span class="msg-sender">${escapeHtml(m.sender)} &rarr; ${escapeHtml(m.target || 'ALL')}</span>
          <span class="msg-topic">${escapeHtml(m.topic)}</span>
        </div>
        <div class="msg-payload">${escapeHtml(payloadText)}</div>
        <div class="msg-timestamp">${timeFormatted}</div>
      </div>
    `;
  }).join("");

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// Render Drive Assets
function renderAssets(assets) {
  const container = document.getElementById("assets-container");
  if (!container) return;

  if (assets.length === 0) {
    container.innerHTML = `<div style="grid-column:span 2;color:var(--text-muted);font-size:0.75rem;text-align:center;padding:1rem;">No Google Drive assets ingested yet.</div>`;
    return;
  }

  container.innerHTML = assets.map(a => {
    const kb = (a.file_size / 1024).toFixed(1);
    return `
      <div class="asset-item" onclick="openAssetPreview('${a.url}', '${escapeHtml(a.file_name)}')">
        <div class="asset-thumb-wrap">
          <img src="${a.url}" alt="${escapeHtml(a.file_name)}" onerror="this.onerror=null;this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'40\\' height=\\'40\\' viewBox=\\'0 0 24 24\\'><text x=\\'5\\' y=\\'15\\' fill=\\'%23666\\'>IMG</text></svg>'">
        </div>
        <div class="asset-meta">
          <span class="name" title="${escapeHtml(a.file_name)}">${escapeHtml(a.file_name)}</span>
          <div style="color:var(--text-muted);display:flex;justify-content:space-between;margin-top:2px;">
            <span>${kb} KB</span>
            <span style="color:var(--accent-cyan);font-family:var(--font-mono);">${a.associated_task_id || ''}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// Task Action Executor
async function taskAction(taskId, action) {
  try {
    const res = await fetch(`${API.TASKS}/${taskId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: currentAgentId,
        result: action === "verify" ? { verified_by: currentAgentId, status: "OK" } : undefined
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Action error: ${data.error || 'Failed'}`);
    } else {
      fetchRoomState();
    }
  } catch (err) {
    console.error("Action failed:", err);
  }
}

// Form & Event Listeners
function setupEventHandlers() {
  // Post Message Form
  const msgForm = document.getElementById("send-message-form");
  if (msgForm) {
    msgForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const topicInput = document.getElementById("msg-topic");
      const bodyInput = document.getElementById("msg-text");

      const topic = topicInput.value.trim() || "CHAT";
      const text = bodyInput.value.trim();
      if (!text) return;

      try {
        await fetch(API.MESSAGES, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: currentAgentId,
            target: "ALL",
            topic: topic,
            payload: { message: text }
          })
        });
        bodyInput.value = "";
        fetchRoomState();
      } catch (err) {
        console.error("Send message error:", err);
      }
    });
  }

  // Create Task Form
  const taskForm = document.getElementById("create-task-form");
  if (taskForm) {
    taskForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("task-title").value.trim();
      const type = document.getElementById("task-type").value.trim() || "MANUAL";
      const priority = parseInt(document.getElementById("task-priority").value, 10) || 2;
      const details = document.getElementById("task-details").value.trim();

      if (!title) return;

      try {
        await fetch(API.TASKS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title,
            task_type: type,
            priority: priority,
            payload: { details: details, creator: currentAgentId }
          })
        });
        closeModal('create-task-modal');
        document.getElementById("task-title").value = "";
        document.getElementById("task-details").value = "";
        fetchRoomState();
      } catch (err) {
        console.error("Task creation error:", err);
      }
    });
  }

  // Create Ticket Form Handler
  const ticketForm = document.getElementById("create-ticket-form");
  if (ticketForm) {
    ticketForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("ticket-title-input").value.trim();
      const severity = document.getElementById("ticket-sev-input").value;
      const associatedTaskId = document.getElementById("ticket-task-input").value.trim();
      const description = document.getElementById("ticket-desc-input").value.trim();

      if (!title) return;

      try {
        await fetch(API.TICKETS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title,
            severity: severity,
            associated_task_id: associatedTaskId || undefined,
            description: description,
            reported_by: currentAgentId
          })
        });
        closeModal('create-ticket-modal');
        document.getElementById("ticket-title-input").value = "";
        document.getElementById("ticket-task-input").value = "";
        document.getElementById("ticket-desc-input").value = "";
        fetchRoomState();
      } catch (err) {
        console.error("Ticket creation error:", err);
      }
    });
  }
}

// Modal Helpers
function openCreateTaskModal() {
  const m = document.getElementById("create-task-modal");
  if (m) m.style.display = "flex";
}

function openCreateTicketModal() {
  const m = document.getElementById("create-ticket-modal");
  if (m) m.style.display = "flex";
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = "none";
}

function openAssetPreview(url, title) {
  window.open(url, "_blank");
}

// Test Ingest Simulation
async function triggerTestIngest() {
  const testCanvas = document.createElement("canvas");
  testCanvas.width = 300;
  testCanvas.height = 200;
  const ctx = testCanvas.getContext("2d");

  // Draw cyber demo gradient
  const gradient = ctx.createLinearGradient(0, 0, 300, 200);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(0.5, "#1e3a8a");
  gradient.addColorStop(1, "#0284c7");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 300, 200);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("Shared Agent Room Ingest", 20, 60);

  ctx.fillStyle = "#38bdf8";
  ctx.font = "12px monospace";
  ctx.fillText(new Date().toISOString(), 20, 100);
  ctx.fillText("Simulated Drive Reference", 20, 130);

  const base64Data = testCanvas.toDataURL("image/png");
  const filename = `test_ingest_${Date.now()}.png`;

  try {
    const res = await fetch(API.INGEST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: `gdrive_mock_${Date.now()}`,
        file_name: filename,
        mime_type: "image/png",
        image_base64: base64Data,
        metadata: { source: "DOM_Dashboard_Test_Trigger" }
      })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Success! Ingested: ${data.file_name} -> Created Task: ${data.task_id}`);
      fetchRoomState();
    } else {
      alert(`Ingest error: ${data.error}`);
    }
  } catch (err) {
    alert(`Ingest exception: ${err}`);
  }
}

// Render IT Helpdesk Incident Tickets
function renderTickets(tickets) {
  const container = document.getElementById("tickets-container");
  const countBadge = document.getElementById("open-tickets-count");
  if (!container) return;

  const openCount = tickets.filter(t => t.status !== "RESOLVED" && t.status !== "CLOSED").length;
  if (countBadge) {
    countBadge.textContent = `${openCount} Open`;
    if (openCount === 0) {
      countBadge.style.background = "rgba(16, 185, 129, 0.2)";
      countBadge.style.color = "#34d399";
      countBadge.style.borderColor = "rgba(16, 185, 129, 0.4)";
    } else {
      countBadge.style.background = "";
      countBadge.style.color = "";
      countBadge.style.borderColor = "";
    }
  }

  if (tickets.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:0.75rem;text-align:center;padding:1.5rem 0.5rem;">No WhatsApp incident tickets.</div>`;
    return;
  }

  container.innerHTML = tickets.map(t => {
    const isResolved = t.status === "RESOLVED" || t.status === "CLOSED";
    let sevClass = "sev-med";
    if (t.severity === "CRITICAL") sevClass = "sev-crit";
    else if (t.severity === "HIGH") sevClass = "sev-high";
    else if (t.severity === "LOW") sevClass = "sev-low";

    const statusBadgeClass = isResolved ? "status-resolved" : "status-open";
    const cursiveTime = formatTimeCursive(t.created_at, t.created_at_fmt ? t.created_at_fmt.split(' ')[1] : '');

    let actionsHtml = "";
    if (!isResolved) {
      actionsHtml = `
        <button class="btn-ticket-resolve" onclick="resolveTicket('${t.ticket_id}')">
          ✓ Resolve
        </button>
      `;
    } else {
      actionsHtml = `
        <span class="ticket-resolved-by">✓ Resolved ${t.resolved_by ? `by ${escapeHtml(t.resolved_by)}` : ''}</span>
      `;
    }

    return `
      <div class="ticket-card ${sevClass} ${isResolved ? 'is-resolved' : ''}">
        <div class="ticket-header">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <span class="ticket-id">${escapeHtml(t.ticket_id)}</span>
            <span class="ticket-sev ${sevClass}">${escapeHtml(t.severity)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span class="ticket-status ${statusBadgeClass}">${escapeHtml(t.status)}</span>
            <span class="ticket-time">${cursiveTime}</span>
          </div>
        </div>
        <div class="ticket-title">${escapeHtml(t.title)}</div>
        ${t.description ? `<div class="ticket-desc">${escapeHtml(t.description)}</div>` : ''}
        ${t.resolution_notes ? `<div class="ticket-notes"><strong>Fix:</strong> ${escapeHtml(t.resolution_notes)}</div>` : ''}
        <div class="ticket-footer">
          <div style="color:var(--text-muted);font-size:0.68rem;display:flex;gap:0.5rem;align-items:center;">
            <span>By: <strong>${escapeHtml(t.reported_by || 'SYSTEM')}</strong></span>
            ${t.associated_task_id ? `<span>Task: <code class="ticket-task-id">${escapeHtml(t.associated_task_id)}</code></span>` : ''}
          </div>
          <div class="ticket-actions">
            ${actionsHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// Resolve Ticket Action
async function resolveTicket(ticketId) {
  const notes = prompt(`Enter resolution notes for ${ticketId}:`, "Diagnosed and resolved via WhatsApp Helpdesk bridge.");
  if (notes === null) return;

  try {
    const res = await fetch(`${API.TICKETS}/${ticketId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resolved_by: currentAgentId,
        notes: notes || "Resolved via IT Desk"
      })
    });
    if (res.ok) {
      fetchRoomState();
    } else {
      const data = await res.json();
      alert(`Error resolving ticket: ${data.error || 'Failed'}`);
    }
  } catch (err) {
    console.error("Resolve error:", err);
  }
}

// Utility
function escapeHtml(str) {
  if (typeof str !== "string") return str;
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

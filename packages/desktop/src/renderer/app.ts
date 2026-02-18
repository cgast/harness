/**
 * Harness Desktop - Renderer Application
 *
 * Orchestrates all UI panels and wires them to the harness API
 * exposed via the preload script at window.harness.
 */

// The harness API type is declared in harness.d.ts

// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════

const state = {
  isRunning: false,
  tokenHistory: [] as { input: number; output: number }[],
  eventLog: [] as { time: string; event: string; data: string }[],
  toolLog: [] as { time: string; name: string; success: boolean; duration: number; output: string }[],
};

// ═══════════════════════════════════════════════════════════
// DOM References
// ═══════════════════════════════════════════════════════════

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => document.querySelectorAll(sel);

// Top bar
const statusBadge = $("#status-badge");
const modelLabel = $("#model-label");
const tokenLabel = $("#token-label");

// Chat
const chatMessages = $("#chat-messages");
const chatForm = $("#chat-form") as HTMLFormElement;
const chatInput = $("#chat-input") as HTMLTextAreaElement;
const runBtn = $("#run-btn") as HTMLButtonElement;
const providerSelect = $("#provider-select") as HTMLSelectElement;
const modelInput = $("#model-input") as HTMLInputElement;
const feedbackBar = $("#feedback-bar");
const feedbackContent = $("#feedback-content");

// Tools
const toolsList = $("#tools-list");
const toolsLog = $("#tools-log");

// Skills
const skillsList = $("#skills-list");

// Plugins
const pluginsList = $("#plugins-list");

// Telemetry
const telemetryStats = $("#telemetry-stats");
const telemetryChart = $("#telemetry-chart");

// Events
const eventsStream = $("#events-stream");
const eventsAutoScroll = $("#events-auto-scroll") as HTMLInputElement;

// Sessions
const sessionsList = $("#sessions-list");
const sessionDetail = $("#session-detail");

// ═══════════════════════════════════════════════════════════
// Tab Navigation
// ═══════════════════════════════════════════════════════════

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const panelId = (tab as HTMLElement).dataset.panel;
    if (!panelId) return;

    // Update tabs
    $$(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    // Update panels
    $$(".panel").forEach((p) => p.classList.remove("active"));
    $(`#panel-${panelId}`)?.classList.add("active");

    // Refresh panel data on switch
    refreshPanel(panelId);
  });
});

function refreshPanel(panelId: string): void {
  switch (panelId) {
    case "tools": refreshTools(); break;
    case "skills": refreshSkills(); break;
    case "plugins": refreshPlugins(); break;
    case "telemetry": refreshTelemetry(); break;
    case "sessions": refreshSessions(); break;
  }
}

// ═══════════════════════════════════════════════════════════
// Chat Panel
// ═══════════════════════════════════════════════════════════

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const task = chatInput.value.trim();
  if (!task || state.isRunning) return;

  // Add user message to chat
  appendChatMessage("user", task);
  chatInput.value = "";

  // Collect options
  const options: any = { task };
  const provider = providerSelect.value;
  if (provider) options.provider = provider;
  const model = modelInput.value.trim();
  if (model) options.model = model;

  // Run the task
  state.isRunning = true;
  updateRunningState();

  const result = await window.harness.runTask(options);

  state.isRunning = false;
  updateRunningState();

  if (result.ok && result.data) {
    if (result.data.response) {
      appendChatMessage("assistant", result.data.response);
    }
  } else {
    appendChatMessage("system", `Error: ${result.error || "Task failed"}`);
  }
});

// Ctrl+Enter to submit
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

function appendChatMessage(role: string, content: string, name?: string): void {
  const div = document.createElement("div");
  div.className = `chat-msg chat-msg-${role}`;

  const label = document.createElement("span");
  label.className = "chat-msg-label";
  label.textContent = name ? `${role} (${name})` : role;

  const body = document.createElement("span");
  body.textContent = content;

  div.appendChild(label);
  div.appendChild(body);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateRunningState(): void {
  runBtn.disabled = state.isRunning;
  runBtn.textContent = state.isRunning ? "Running..." : "Run";

  statusBadge.textContent = state.isRunning ? "running" : "idle";
  statusBadge.className = `badge badge-${state.isRunning ? "running" : "idle"}`;
}

// ═══════════════════════════════════════════════════════════
// Tools Panel
// ═══════════════════════════════════════════════════════════

async function refreshTools(): Promise<void> {
  const result = await window.harness.getTools();
  if (!result.ok || !result.data) return;

  toolsList.innerHTML = "";
  const tools: any[] = result.data;

  if (tools.length === 0) {
    toolsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">T</div>No tools registered</div>';
    return;
  }

  for (const tool of tools) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-title">${esc(tool.name)}</div>
      <div class="card-desc">${esc(tool.description)}</div>
      <div class="card-meta">
        ${tool.timeout ? `timeout: ${tool.timeout}ms` : ""}
        ${tool.requiresConfirmation ? '<span class="card-tag">confirmation required</span>' : ""}
      </div>
      <div class="json-viewer">${esc(JSON.stringify(tool.parameters, null, 2))}</div>
      <div class="card-actions">
        <button class="btn btn-small btn-danger" data-tool-remove="${esc(tool.name)}">Remove</button>
      </div>
    `;
    toolsList.appendChild(card);
  }

  // Bind remove buttons
  toolsList.querySelectorAll("[data-tool-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = (btn as HTMLElement).dataset.toolRemove!;
      await window.harness.unregisterTool(name);
      refreshTools();
    });
  });
}

$("#tools-refresh")?.addEventListener("click", refreshTools);

// ═══════════════════════════════════════════════════════════
// Skills Panel
// ═══════════════════════════════════════════════════════════

async function refreshSkills(): Promise<void> {
  const result = await window.harness.getSkills();
  if (!result.ok || !result.data) return;

  skillsList.innerHTML = "";
  const skills: any[] = result.data;

  if (skills.length === 0) {
    skillsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">S</div>No skills loaded</div>';
    return;
  }

  for (const skill of skills) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-title">
        ${esc(skill.name)}
        ${skill.active ? '<span class="card-tag card-tag-active">active</span>' : '<span class="card-tag">inactive</span>'}
        ${skill.auto ? '<span class="card-tag card-tag-auto">auto</span>' : ""}
      </div>
      <div class="card-desc">${esc(skill.description)}</div>
      <div class="card-meta">
        v${skill.version} | id: ${esc(skill.id)}
        ${skill.keywords.length > 0 ? ` | keywords: ${skill.keywords.map(esc).join(", ")}` : ""}
      </div>
      ${skill.promptInjection ? `<div class="json-viewer">${esc(skill.promptInjection)}</div>` : ""}
      <div class="card-actions">
        ${skill.active
          ? `<button class="btn btn-small btn-danger" data-skill-deactivate="${esc(skill.id)}">Deactivate</button>`
          : `<button class="btn btn-small" data-skill-activate="${esc(skill.id)}">Activate</button>`
        }
      </div>
    `;
    skillsList.appendChild(card);
  }

  // Bind buttons
  skillsList.querySelectorAll("[data-skill-activate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await window.harness.activateSkill((btn as HTMLElement).dataset.skillActivate!);
      refreshSkills();
    });
  });
  skillsList.querySelectorAll("[data-skill-deactivate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await window.harness.deactivateSkill((btn as HTMLElement).dataset.skillDeactivate!);
      refreshSkills();
    });
  });
}

$("#skills-refresh")?.addEventListener("click", refreshSkills);

// ═══════════════════════════════════════════════════════════
// Plugins Panel
// ═══════════════════════════════════════════════════════════

async function refreshPlugins(): Promise<void> {
  const result = await window.harness.getPlugins();
  if (!result.ok || !result.data) return;

  pluginsList.innerHTML = "";
  const plugins: any[] = result.data;

  if (plugins.length === 0) {
    pluginsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">P</div>No plugins loaded</div>';
    return;
  }

  for (const plugin of plugins) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-title">${esc(plugin.name)}</div>
      <div class="card-meta">id: ${esc(plugin.id)} | v${esc(plugin.version)}</div>
    `;
    pluginsList.appendChild(card);
  }
}

$("#plugins-refresh")?.addEventListener("click", refreshPlugins);

// ═══════════════════════════════════════════════════════════
// Telemetry Panel
// ═══════════════════════════════════════════════════════════

async function refreshTelemetry(): Promise<void> {
  const result = await window.harness.getTelemetry();
  if (!result.ok || !result.data) return;

  const t = result.data;

  telemetryStats.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${t.tokenUsage.input + t.tokenUsage.output}</div>
      <div class="stat-label">Total Tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${t.tokenUsage.input}</div>
      <div class="stat-label">Input Tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${t.tokenUsage.output}</div>
      <div class="stat-label">Output Tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${t.iterations}</div>
      <div class="stat-label">Iterations</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${esc(t.status)}</div>
      <div class="stat-label">Status</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${esc(t.model)}</div>
      <div class="stat-label">Model</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${esc(t.provider)}</div>
      <div class="stat-label">Provider</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${t.activeSkills.length}</div>
      <div class="stat-label">Active Skills</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${t.availableTools.length}</div>
      <div class="stat-label">Available Tools</div>
    </div>
  `;

  // Update top bar
  modelLabel.textContent = `${t.provider}/${t.model}`;
  tokenLabel.textContent = `${t.tokenUsage.input + t.tokenUsage.output} tokens`;

  // Render token history chart
  renderTokenChart();
}

function renderTokenChart(): void {
  telemetryChart.innerHTML = "";

  if (state.tokenHistory.length === 0) {
    telemetryChart.innerHTML = '<div class="empty-state text-muted">Token data will appear as the agent runs</div>';
    return;
  }

  const maxVal = Math.max(...state.tokenHistory.map((h) => h.input + h.output), 1);

  for (const entry of state.tokenHistory) {
    const total = entry.input + entry.output;
    const heightPct = Math.max((total / maxVal) * 100, 2);
    const inputPct = total > 0 ? (entry.input / total) * 100 : 50;

    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.height = `${heightPct}%`;
    bar.title = `in: ${entry.input} | out: ${entry.output}`;

    // Split bar: input (bottom) + output (top)
    bar.style.background = `linear-gradient(to top, var(--accent) ${inputPct}%, rgba(91,110,234,0.4) ${inputPct}%)`;

    telemetryChart.appendChild(bar);
  }
}

$("#telemetry-refresh")?.addEventListener("click", refreshTelemetry);

// ═══════════════════════════════════════════════════════════
// Events Panel
// ═══════════════════════════════════════════════════════════

function appendEventLog(event: string, data: unknown): void {
  const time = new Date().toLocaleTimeString();
  const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 0);
  const truncated = dataStr && dataStr.length > 300 ? dataStr.slice(0, 300) + "..." : dataStr;

  // Determine event color class
  let colorClass = "";
  if (event.startsWith("tool:")) colorClass = "log-event-tool";
  else if (event.startsWith("llm:")) colorClass = "log-event-llm";
  else if (event.startsWith("agent:")) colorClass = "log-event-agent";
  else if (event.includes("error")) colorClass = "log-event-error";
  else if (event.startsWith("state:")) colorClass = "log-event-state";
  else if (event.startsWith("feedback:")) colorClass = "log-event-feedback";

  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `<span class="log-time">${esc(time)}</span><span class="log-event ${colorClass}">${esc(event)}</span><span class="log-data">${esc(truncated || "")}</span>`;
  eventsStream.appendChild(entry);

  if (eventsAutoScroll.checked) {
    eventsStream.scrollTop = eventsStream.scrollHeight;
  }

  // Keep max 500 entries
  while (eventsStream.children.length > 500) {
    eventsStream.removeChild(eventsStream.firstChild!);
  }
}

$("#events-clear")?.addEventListener("click", () => {
  eventsStream.innerHTML = "";
});

// ═══════════════════════════════════════════════════════════
// Sessions Panel
// ═══════════════════════════════════════════════════════════

async function refreshSessions(): Promise<void> {
  const result = await window.harness.getSessions(50);
  if (!result.ok || !result.data) return;

  sessionsList.innerHTML = "";
  const sessions: any[] = result.data;

  if (sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">H</div>No sessions yet</div>';
    return;
  }

  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    row.innerHTML = `
      <span class="session-task">${esc(s.task)}</span>
      <span class="session-meta">${esc(s.id.slice(0, 8))} | ${esc(s.createdAt || "")}</span>
    `;
    row.addEventListener("click", () => showSessionDetail(s.id));
    sessionsList.appendChild(row);
  }
}

async function showSessionDetail(id: string): Promise<void> {
  const result = await window.harness.getSession(id);
  if (!result.ok || !result.data) return;

  const s = result.data;
  sessionDetail.classList.remove("hidden");

  let messagesHtml = "";
  try {
    const messages = JSON.parse(s.messages || "[]");
    messagesHtml = messages
      .map((m: any) => `<div class="chat-msg chat-msg-${esc(m.role)}" style="max-width:100%"><span class="chat-msg-label">${esc(m.role)}${m.name ? ` (${esc(m.name)})` : ""}</span>${esc(m.content)}</div>`)
      .join("");
  } catch {
    messagesHtml = "<div class='text-muted'>Unable to parse messages</div>";
  }

  let tokenHtml = "";
  try {
    const usage = JSON.parse(s.tokenUsage || "{}");
    tokenHtml = `Input: ${usage.input || 0} | Output: ${usage.output || 0}`;
  } catch {
    tokenHtml = "--";
  }

  sessionDetail.innerHTML = `
    <h3 style="margin-bottom: 8px;">Session: ${esc(id.slice(0, 12))}...</h3>
    <div class="card-meta" style="margin-bottom: 12px;">
      Task: ${esc(s.task)} | Soul: ${esc(s.soulId || "none")} | Tokens: ${tokenHtml} | Created: ${esc(s.createdAt)} | Ended: ${esc(s.endedAt || "ongoing")}
    </div>
    <div>${messagesHtml}</div>
  `;
}

$("#sessions-refresh")?.addEventListener("click", refreshSessions);

// ═══════════════════════════════════════════════════════════
// Feedback (HITL) UI
// ═══════════════════════════════════════════════════════════

function showFeedbackRequest(request: any): void {
  feedbackBar.classList.remove("hidden");

  let html = `<div class="feedback-prompt">${esc(request.prompt || request.message || "Agent requests your input")}</div>`;
  html += '<div class="feedback-actions">';

  switch (request.type) {
    case "confirm":
      html += `<button class="btn btn-primary" data-fb-confirm="true">Approve</button>`;
      html += `<button class="btn btn-danger" data-fb-confirm="false">Deny</button>`;
      break;
    case "choice":
      for (const opt of request.options || []) {
        html += `<button class="btn" data-fb-choice="${esc(opt.value || opt)}">${esc(opt.label || opt)}</button>`;
      }
      break;
    case "text":
      html += `<input type="text" id="fb-text-input" class="chat-input" style="flex:1" placeholder="Your response..." />`;
      html += `<button class="btn btn-primary" data-fb-text="submit">Send</button>`;
      break;
    default:
      html += `<button class="btn btn-primary" data-fb-confirm="true">OK</button>`;
      html += `<button class="btn" data-fb-confirm="false">Cancel</button>`;
  }

  html += "</div>";
  feedbackContent.innerHTML = html;

  // Bind feedback buttons
  feedbackContent.querySelectorAll("[data-fb-confirm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const approved = (btn as HTMLElement).dataset.fbConfirm === "true";
      window.harness.feedbackRespond(request.id, {
        status: "completed",
        type: "confirm",
        approved,
      });
      feedbackBar.classList.add("hidden");
    });
  });

  feedbackContent.querySelectorAll("[data-fb-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.harness.feedbackRespond(request.id, {
        status: "completed",
        type: "choice",
        selected: (btn as HTMLElement).dataset.fbChoice,
      });
      feedbackBar.classList.add("hidden");
    });
  });

  feedbackContent.querySelectorAll("[data-fb-text]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById("fb-text-input") as HTMLInputElement;
      window.harness.feedbackRespond(request.id, {
        status: "completed",
        type: "text",
        text: input?.value || "",
      });
      feedbackBar.classList.add("hidden");
    });
  });
}

// ═══════════════════════════════════════════════════════════
// Event Stream (from main process)
// ═══════════════════════════════════════════════════════════

window.harness.onEvent(({ event, data }) => {
  // Always log to events panel
  appendEventLog(event, data);

  const d = data as any;

  switch (event) {
    // ─── Agent lifecycle ─────────────────────────────────
    case "agent:start":
      statusBadge.textContent = "running";
      statusBadge.className = "badge badge-running";
      break;

    case "agent:end":
      statusBadge.textContent = "done";
      statusBadge.className = "badge badge-done";
      if (d?.tokenUsage) {
        tokenLabel.textContent = `${d.tokenUsage.input + d.tokenUsage.output} tokens`;
      }
      break;

    case "agent:error":
      statusBadge.textContent = "error";
      statusBadge.className = "badge badge-error";
      break;

    // ─── LLM events ─────────────────────────────────────
    case "llm:response":
      if (d?.usage) {
        state.tokenHistory.push({
          input: d.usage.inputTokens || 0,
          output: d.usage.outputTokens || 0,
        });
        const totalIn = state.tokenHistory.reduce((s, h) => s + h.input, 0);
        const totalOut = state.tokenHistory.reduce((s, h) => s + h.output, 0);
        tokenLabel.textContent = `${totalIn + totalOut} tokens`;
      }
      break;

    case "llm:chunk":
      // Could be used for streaming text display
      break;

    case "llm:error":
      appendChatMessage("system", `LLM Error: ${d?.error?.message || "Unknown error"}`);
      break;

    // ─── Tool events ─────────────────────────────────────
    case "tool:start":
      appendToolLog(d?.name, true, 0, `Executing with args: ${JSON.stringify(d?.args || {})}`);
      break;

    case "tool:result":
      appendToolLog(
        d?.name,
        d?.result?.success ?? true,
        d?.duration ?? 0,
        d?.result?.output || ""
      );
      // Also show in chat
      appendChatMessage("tool", d?.result?.output || "(no output)", d?.name);
      break;

    case "tool:error":
      appendToolLog(d?.name, false, 0, d?.error?.message || "Error");
      break;

    // ─── State changes ───────────────────────────────────
    case "state:change":
      if (d?.path === "config") {
        const cfg = d.newValue as any;
        if (cfg?.model && cfg?.provider) {
          modelLabel.textContent = `${cfg.provider}/${cfg.model}`;
        }
      }
      if (d?.path === "status") {
        const status = d.newValue as string;
        statusBadge.textContent = status;
        statusBadge.className = `badge badge-${status}`;
      }
      break;

    // ─── Feedback ────────────────────────────────────────
    case "feedback:ui-request":
      showFeedbackRequest(d);
      break;

    case "feedback:response":
      feedbackBar.classList.add("hidden");
      break;

    case "feedback:timeout":
      feedbackBar.classList.add("hidden");
      appendChatMessage("system", "Feedback request timed out");
      break;
  }
});

function appendToolLog(name: string, success: boolean, duration: number, output: string): void {
  const time = new Date().toLocaleTimeString();
  const truncated = output.length > 200 ? output.slice(0, 200) + "..." : output;

  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `
    <span class="log-time">${esc(time)}</span>
    <span class="log-event log-event-tool">${esc(name)}</span>
    <span class="${success ? "text-success" : "text-error"}">${success ? "OK" : "FAIL"}</span>
    ${duration > 0 ? `<span class="text-muted"> ${duration}ms</span>` : ""}
    <span class="log-data"> ${esc(truncated)}</span>
  `;
  toolsLog.appendChild(entry);
  toolsLog.scrollTop = toolsLog.scrollHeight;
}

// ═══════════════════════════════════════════════════════════
// Menu Actions
// ═══════════════════════════════════════════════════════════

window.harness.onMenuAction("new-session", () => {
  chatMessages.innerHTML = "";
  state.tokenHistory = [];
  state.eventLog = [];
  state.toolLog = [];
  chatInput.focus();
});

window.harness.onMenuAction("clear-history", () => {
  chatMessages.innerHTML = "";
});

window.harness.onMenuAction("interrupt", async () => {
  appendChatMessage("system", "Interrupt signal sent");
});

// ═══════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════

function esc(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════

async function init(): Promise<void> {
  // Load initial state
  const stateResult = await window.harness.getState();
  if (stateResult.ok && stateResult.data) {
    const cfg = stateResult.data.config;
    modelLabel.textContent = `${cfg.provider}/${cfg.model}`;
    providerSelect.value = cfg.provider;
    statusBadge.textContent = stateResult.data.status;
    statusBadge.className = `badge badge-${stateResult.data.status}`;
  }

  // Load tools, skills, plugins for their panels
  refreshTools();
  refreshSkills();
  refreshPlugins();

  chatInput.focus();
}

init();

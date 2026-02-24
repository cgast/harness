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
  selectedSessionId: null as string | null,
  selectedSoulFile: null as string | null,
  selectedToolName: null as string | null,
  selectedSkillId: null as string | null,
  selectedPluginId: null as string | null,
  theme: (localStorage.getItem("harness-theme") || "dark") as "dark" | "light",
  toolsData: [] as any[],
  skillsData: [] as any[],
  pluginsData: [] as any[],
};

// ═══════════════════════════════════════════════════════════
// DOM References
// ═══════════════════════════════════════════════════════════

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => document.querySelectorAll(sel);

// Status bar
const statusBadge = $("#status-badge");
const modelLabel = $("#model-label");
const tokenLabel = $("#token-label");

// Chat (merged with sessions)
const chatMessages = $("#chat-messages");
const chatForm = $("#chat-form") as HTMLFormElement;
const chatInput = $("#chat-input") as HTMLTextAreaElement;
const runBtn = $("#run-btn") as HTMLButtonElement;
const providerSelect = $("#provider-select") as HTMLSelectElement;
const modelInput = $("#model-input") as HTMLInputElement;
const feedbackBar = $("#feedback-bar");
const feedbackContent = $("#feedback-content");
const sessionsList = $("#sessions-list");

// Tools
const toolsList = $("#tools-list");
const toolsLog = $("#tools-log");
const toolDefinition = $("#tool-definition");

// Skills
const skillsList = $("#skills-list");
const skillDetail = $("#skill-detail");

// Plugins
const pluginsList = $("#plugins-list");
const pluginDetail = $("#plugin-detail");

// Deliverables
const deliverablesList = $("#deliverables-list");

// Telemetry
const telemetryStats = $("#telemetry-stats");
const telemetryChart = $("#telemetry-chart");

// Events
const eventsStream = $("#events-stream");
const eventsAutoScroll = $("#events-auto-scroll") as HTMLInputElement;

// Soul
const soulList = $("#soul-list");
const soulEditor = $("#soul-editor");

// ═══════════════════════════════════════════════════════════
// Activity Bar Navigation
// ═══════════════════════════════════════════════════════════

$$(".activity-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panelId = (btn as HTMLElement).dataset.panel;
    if (!panelId) return;

    switchToPanel(panelId);
  });
});

function switchToPanel(panelId: string): void {
  // Update activity bar
  $$(".activity-btn").forEach((b) => b.classList.remove("active"));
  const activeBtn = document.querySelector(`.activity-btn[data-panel="${panelId}"]`);
  if (activeBtn) activeBtn.classList.add("active");

  // Update panels
  $$(".panel").forEach((p) => p.classList.remove("active"));
  $(`#panel-${panelId}`)?.classList.add("active");

  // Refresh panel data on switch
  refreshPanel(panelId);
}

function refreshPanel(panelId: string): void {
  switch (panelId) {
    case "chat": refreshSessions(); break;
    case "tools": refreshTools(); break;
    case "skills": refreshSkills(); break;
    case "plugins": refreshPlugins(); break;
    case "telemetry": refreshTelemetry(); break;
    case "settings": refreshSettings(); break;
    case "soul": refreshSoulFiles(); break;
    case "deliverables": refreshDeliverables(); break;
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
// Tools Panel (sidebar list + Definition / Execution Log)
// ═══════════════════════════════════════════════════════════

async function refreshTools(): Promise<void> {
  const result = await window.harness.getTools();
  if (!result.ok || !result.data) return;

  toolsList.innerHTML = "";
  const tools: any[] = result.data;
  state.toolsData = tools;

  if (tools.length === 0) {
    toolsList.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px;">No tools registered</div>';
    return;
  }

  for (const tool of tools) {
    const item = document.createElement("div");
    item.className = `sidebar-item${state.selectedToolName === tool.name ? " active" : ""}`;
    item.innerHTML = `
      <span class="sidebar-item-title">${esc(tool.name)}</span>
      ${tool.requiresConfirmation ? '<span class="sidebar-item-meta">confirm</span>' : ""}
    `;
    item.addEventListener("click", () => {
      toolsList.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      state.selectedToolName = tool.name;
      showToolDefinition(tool);
    });
    toolsList.appendChild(item);
  }

  // If a tool was previously selected, re-show it
  if (state.selectedToolName) {
    const found = tools.find((t) => t.name === state.selectedToolName);
    if (found) showToolDefinition(found);
  }
}

function showToolDefinition(tool: any): void {
  toolDefinition.innerHTML = `
    <div style="margin-bottom:12px;">
      <div class="card-title" style="font-size:16px;margin-bottom:8px;">${esc(tool.name)}</div>
      <div class="card-desc">${esc(tool.description)}</div>
      <div class="card-meta" style="margin-top:6px;">
        ${tool.timeout ? `timeout: ${tool.timeout}ms` : ""}
        ${tool.requiresConfirmation ? '<span class="card-tag">confirmation required</span>' : ""}
      </div>
    </div>
    <div style="margin-bottom:8px;">
      <label style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Parameters</label>
      <div class="json-viewer">${esc(JSON.stringify(tool.parameters, null, 2))}</div>
    </div>
    <div class="card-actions">
      <button class="btn btn-small btn-danger" id="tool-remove-btn">Remove</button>
    </div>
  `;

  $("#tool-remove-btn")?.addEventListener("click", async () => {
    await window.harness.unregisterTool(tool.name);
    state.selectedToolName = null;
    toolDefinition.innerHTML = '<div class="empty-state"><div class="empty-state-icon">T</div>Select a tool to view its definition</div>';
    refreshTools();
  });
}

$("#tools-refresh")?.addEventListener("click", refreshTools);

// ═══════════════════════════════════════════════════════════
// Skills Panel (sidebar list + detail)
// ═══════════════════════════════════════════════════════════

async function refreshSkills(): Promise<void> {
  const result = await window.harness.getSkills();
  if (!result.ok || !result.data) return;

  skillsList.innerHTML = "";
  const skills: any[] = result.data;
  state.skillsData = skills;

  if (skills.length === 0) {
    skillsList.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px;">No skills loaded</div>';
    return;
  }

  for (const skill of skills) {
    const item = document.createElement("div");
    item.className = `sidebar-item${state.selectedSkillId === skill.id ? " active" : ""}`;
    item.innerHTML = `
      <span class="sidebar-item-title">${esc(skill.name)}</span>
      ${skill.active
        ? '<span class="sidebar-item-meta" style="color:var(--success);">on</span>'
        : '<span class="sidebar-item-meta">off</span>'}
    `;
    item.addEventListener("click", () => {
      skillsList.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      state.selectedSkillId = skill.id;
      showSkillDetail(skill);
    });
    skillsList.appendChild(item);
  }

  // If a skill was previously selected, re-show it
  if (state.selectedSkillId) {
    const found = skills.find((s) => s.id === state.selectedSkillId);
    if (found) showSkillDetail(found);
  }
}

function showSkillDetail(skill: any): void {
  skillDetail.innerHTML = `
    <div style="margin-bottom:12px;">
      <div class="card-title" style="font-size:16px;margin-bottom:8px;">
        ${esc(skill.name)}
        ${skill.active ? '<span class="card-tag card-tag-active">active</span>' : '<span class="card-tag">inactive</span>'}
        ${skill.auto ? '<span class="card-tag card-tag-auto">auto</span>' : ""}
      </div>
      <div class="card-desc">${esc(skill.description)}</div>
      <div class="card-meta" style="margin-top:6px;">
        v${skill.version} | id: ${esc(skill.id)}
        ${skill.keywords && skill.keywords.length > 0 ? ` | keywords: ${skill.keywords.map(esc).join(", ")}` : ""}
      </div>
    </div>
    ${skill.promptInjection ? `
      <div style="margin-bottom:12px;">
        <label style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Prompt Injection</label>
        <div class="json-viewer">${esc(skill.promptInjection)}</div>
      </div>
    ` : ""}
    <div class="card-actions">
      ${skill.active
        ? '<button class="btn btn-small btn-danger" id="skill-toggle-btn">Deactivate</button>'
        : '<button class="btn btn-small" id="skill-toggle-btn">Activate</button>'
      }
    </div>
  `;

  $("#skill-toggle-btn")?.addEventListener("click", async () => {
    if (skill.active) {
      await window.harness.deactivateSkill(skill.id);
    } else {
      await window.harness.activateSkill(skill.id);
    }
    refreshSkills();
  });
}

$("#skills-refresh")?.addEventListener("click", refreshSkills);

// ═══════════════════════════════════════════════════════════
// Plugins Panel (sidebar list + detail)
// ═══════════════════════════════════════════════════════════

async function refreshPlugins(): Promise<void> {
  const result = await window.harness.getPlugins();
  if (!result.ok || !result.data) return;

  pluginsList.innerHTML = "";
  const plugins: any[] = result.data;
  state.pluginsData = plugins;

  if (plugins.length === 0) {
    pluginsList.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px;">No plugins loaded</div>';
    return;
  }

  for (const plugin of plugins) {
    const item = document.createElement("div");
    item.className = `sidebar-item${state.selectedPluginId === plugin.id ? " active" : ""}`;
    item.innerHTML = `
      <span class="sidebar-item-title">${esc(plugin.name)}</span>
      <span class="sidebar-item-meta">v${esc(plugin.version)}</span>
    `;
    item.addEventListener("click", () => {
      pluginsList.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      state.selectedPluginId = plugin.id;
      showPluginDetail(plugin);
    });
    pluginsList.appendChild(item);
  }

  // If a plugin was previously selected, re-show it
  if (state.selectedPluginId) {
    const found = plugins.find((p) => p.id === state.selectedPluginId);
    if (found) showPluginDetail(found);
  }
}

function showPluginDetail(plugin: any): void {
  pluginDetail.innerHTML = `
    <div style="margin-bottom:12px;">
      <div class="card-title" style="font-size:16px;margin-bottom:8px;">${esc(plugin.name)}</div>
      <div class="card-meta" style="margin-top:6px;">id: ${esc(plugin.id)} | v${esc(plugin.version)}</div>
    </div>
    ${plugin.description ? `<div class="card-desc" style="margin-bottom:12px;">${esc(plugin.description)}</div>` : ""}
    ${plugin.tools && plugin.tools.length > 0 ? `
      <div style="margin-bottom:12px;">
        <label style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Provided Tools</label>
        <div class="json-viewer">${plugin.tools.map((t: any) => esc(typeof t === "string" ? t : t.name)).join(", ")}</div>
      </div>
    ` : ""}
    ${plugin.hooks ? `
      <div>
        <label style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Hooks</label>
        <div class="json-viewer">${esc(JSON.stringify(plugin.hooks, null, 2))}</div>
      </div>
    ` : ""}
  `;
}

$("#plugins-refresh")?.addEventListener("click", refreshPlugins);

// ═══════════════════════════════════════════════════════════
// Deliverables Panel (.harness-out/)
// ═══════════════════════════════════════════════════════════

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeIcon(type: string): string {
  switch (type) {
    case "pdf": return "PDF";
    case "png": case "jpg": case "jpeg": case "gif": case "svg": return "IMG";
    case "pptx": case "ppt": return "PPT";
    case "xlsx": case "xls": case "csv": return "XLS";
    case "docx": case "doc": return "DOC";
    case "py": return "PY";
    case "js": case "ts": return "JS";
    case "json": return "{ }";
    case "txt": case "md": return "TXT";
    default: return "FILE";
  }
}

async function refreshDeliverables(): Promise<void> {
  const result = await window.harness.getDeliverables();
  if (!result.ok || !result.data) return;

  const files: Array<{ name: string; size: number; type: string; path: string }> = result.data;

  if (files.length === 0) {
    deliverablesList.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">D</div>No deliverables yet. Run a task with the sandbox plugin to generate output files.</div>';
    return;
  }

  deliverablesList.innerHTML = "";

  for (const file of files) {
    const card = document.createElement("div");
    card.className = "deliverable-card";
    card.innerHTML = `
      <div class="deliverable-icon">${fileTypeIcon(file.type)}</div>
      <div class="deliverable-info">
        <div class="deliverable-name">${esc(file.name)}</div>
        <div class="deliverable-meta">${esc(file.type.toUpperCase())} &middot; ${formatFileSize(file.size)}</div>
      </div>
    `;
    card.title = file.path;
    deliverablesList.appendChild(card);
  }
}

$("#deliverables-refresh")?.addEventListener("click", refreshDeliverables);

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

  // Update status bar
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
// Events Panel (with filter sidebar)
// ═══════════════════════════════════════════════════════════

function getEventCategory(event: string): string {
  if (event.startsWith("tool:")) return "tool";
  if (event.startsWith("llm:")) return "llm";
  if (event.startsWith("agent:")) return "agent";
  if (event.includes("error")) return "error";
  if (event.startsWith("state:")) return "state";
  if (event.startsWith("feedback:")) return "feedback";
  return "other";
}

function isEventFilterEnabled(category: string): boolean {
  const checkbox = document.querySelector(`[data-event-filter="${category}"]`) as HTMLInputElement | null;
  return checkbox ? checkbox.checked : true;
}

function appendEventLog(event: string, data: unknown): void {
  const time = new Date().toLocaleTimeString();
  const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 0);
  const truncated = dataStr && dataStr.length > 300 ? dataStr.slice(0, 300) + "..." : dataStr;

  const category = getEventCategory(event);

  // Determine event color class
  let colorClass = "";
  if (category === "tool") colorClass = "log-event-tool";
  else if (category === "llm") colorClass = "log-event-llm";
  else if (category === "agent") colorClass = "log-event-agent";
  else if (category === "error") colorClass = "log-event-error";
  else if (category === "state") colorClass = "log-event-state";
  else if (category === "feedback") colorClass = "log-event-feedback";

  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.dataset.eventCategory = category;
  entry.innerHTML = `<span class="log-time">${esc(time)}</span><span class="log-event ${colorClass}">${esc(event)}</span><span class="log-data">${esc(truncated || "")}</span>`;

  // Apply current filter visibility
  if (!isEventFilterEnabled(category)) {
    entry.style.display = "none";
  }

  eventsStream.appendChild(entry);

  if (eventsAutoScroll.checked) {
    eventsStream.scrollTop = eventsStream.scrollHeight;
  }

  // Keep max 500 entries
  while (eventsStream.children.length > 500) {
    eventsStream.removeChild(eventsStream.firstChild!);
  }
}

// Bind filter checkboxes
document.querySelectorAll("[data-event-filter]").forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    const category = (checkbox as HTMLElement).dataset.eventFilter!;
    const checked = (checkbox as HTMLInputElement).checked;
    eventsStream.querySelectorAll(`[data-event-category="${category}"]`).forEach((entry) => {
      (entry as HTMLElement).style.display = checked ? "" : "none";
    });
  });
});

$("#events-clear")?.addEventListener("click", () => {
  eventsStream.innerHTML = "";
});

// ═══════════════════════════════════════════════════════════
// Unified Chat + Sessions Panel
// ═══════════════════════════════════════════════════════════

async function refreshSessions(): Promise<void> {
  const result = await window.harness.getSessions(50);
  if (!result.ok || !result.data) return;

  sessionsList.innerHTML = "";
  const sessions: any[] = result.data;

  if (sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px;">No sessions yet</div>';
    return;
  }

  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = `sidebar-item${state.selectedSessionId === s.id ? " active" : ""}`;
    item.innerHTML = `
      <span class="sidebar-item-title">${esc(s.task)}</span>
      <span class="sidebar-item-meta">${esc(s.id.slice(0, 6))}</span>
    `;
    item.addEventListener("click", () => {
      sessionsList.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      state.selectedSessionId = s.id;
      loadSessionMessages(s.id);
    });
    sessionsList.appendChild(item);
  }
}

async function loadSessionMessages(id: string): Promise<void> {
  const result = await window.harness.getSession(id);
  if (!result.ok || !result.data) return;

  const s = result.data;

  chatMessages.innerHTML = "";

  // Show session header
  let tokenHtml = "";
  try {
    const usage = JSON.parse(s.tokenUsage || "{}");
    tokenHtml = `Input: ${usage.input || 0} | Output: ${usage.output || 0}`;
  } catch {
    tokenHtml = "--";
  }

  const header = document.createElement("div");
  header.className = "session-detail-header";
  header.style.padding = "12px 0";
  header.innerHTML = `
    <h3 style="font-size:13px;font-weight:600;margin-bottom:4px;">Session: ${esc(id.slice(0, 12))}...</h3>
    <div class="card-meta">
      Task: ${esc(s.task)} | Soul: ${esc(s.soulId || "none")} | Tokens: ${tokenHtml} | Created: ${esc(s.createdAt)} | Ended: ${esc(s.endedAt || "ongoing")}
    </div>
  `;
  chatMessages.appendChild(header);

  // Render messages
  try {
    const messages = JSON.parse(s.messages || "[]");
    for (const m of messages) {
      appendChatMessage(m.role, m.content, m.name);
    }
  } catch {
    const err = document.createElement("div");
    err.className = "text-muted";
    err.textContent = "Unable to parse session messages";
    chatMessages.appendChild(err);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// New session button
$("#new-session-btn")?.addEventListener("click", () => {
  // Deselect current session
  sessionsList.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
  state.selectedSessionId = null;
  chatMessages.innerHTML = "";
  state.tokenHistory = [];
  state.eventLog = [];
  state.toolLog = [];
  chatInput.focus();
});

$("#sessions-refresh")?.addEventListener("click", refreshSessions);

// ═══════════════════════════════════════════════════════════
// System Prompt / Soul Files Panel
// ═══════════════════════════════════════════════════════════

async function refreshSoulFiles(): Promise<void> {
  const result = await window.harness.getSoulFiles();
  if (!result.ok || !result.data) return;

  soulList.innerHTML = "";
  const files: any[] = result.data;

  if (files.length === 0) {
    soulList.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px;">No soul files found</div>';
    return;
  }

  for (const f of files) {
    const item = document.createElement("div");
    item.className = `sidebar-item${state.selectedSoulFile === f.name ? " active" : ""}`;
    item.innerHTML = `
      <span class="sidebar-item-title">${esc(f.name)}</span>
      ${f.active ? '<span class="card-tag card-tag-active" style="font-size:9px;">active</span>' : ""}
    `;
    item.addEventListener("click", () => {
      soulList.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      state.selectedSoulFile = f.name;
      showSoulEditor(f.name);
    });
    soulList.appendChild(item);
  }
}

async function showSoulEditor(name: string): Promise<void> {
  const result = await window.harness.getSoulFile(name);
  if (!result.ok || !result.data) {
    soulEditor.innerHTML = `<div class="empty-state text-error">Failed to load soul file</div>`;
    return;
  }

  const soul = result.data;

  soulEditor.innerHTML = `
    <div class="soul-editor-header">
      <h3>${esc(soul.name || name)}</h3>
      <div style="display:flex;gap:6px;">
        <button id="soul-save-btn" class="btn btn-primary btn-small">Save</button>
        <button id="soul-activate-btn" class="btn btn-small">${soul.active ? "Deactivate" : "Set Active"}</button>
        <button id="soul-delete-btn" class="btn btn-small btn-danger">Delete</button>
      </div>
    </div>
    <div class="soul-meta-grid">
      <div class="soul-meta-field">
        <label>Name</label>
        <input id="soul-edit-name" type="text" value="${esc(soul.name || "")}" />
      </div>
      <div class="soul-meta-field">
        <label>Description</label>
        <input id="soul-edit-desc" type="text" value="${esc(soul.description || "")}" />
      </div>
      <div class="soul-meta-field">
        <label>Model Hint</label>
        <input id="soul-edit-model" type="text" value="${esc(soul.modelHint || "")}" placeholder="optional" />
      </div>
    </div>
    <div class="soul-prompt-area">
      <label>System Prompt</label>
      <textarea id="soul-edit-prompt">${esc(soul.systemPrompt || "")}</textarea>
    </div>
  `;

  // Bind save
  $("#soul-save-btn")?.addEventListener("click", async () => {
    const updated = {
      name: ($("#soul-edit-name") as HTMLInputElement).value.trim(),
      description: ($("#soul-edit-desc") as HTMLInputElement).value.trim(),
      modelHint: ($("#soul-edit-model") as HTMLInputElement).value.trim(),
      systemPrompt: ($("#soul-edit-prompt") as HTMLTextAreaElement).value,
    };
    const saveResult = await window.harness.saveSoulFile(name, updated);
    if (saveResult.ok) {
      state.selectedSoulFile = updated.name || name;
      refreshSoulFiles();
    }
  });

  // Bind activate/deactivate
  $("#soul-activate-btn")?.addEventListener("click", async () => {
    if (soul.active) {
      await window.harness.setActiveSoul("");
    } else {
      await window.harness.setActiveSoul(name);
    }
    refreshSoulFiles();
    showSoulEditor(name);
  });

  // Bind delete
  $("#soul-delete-btn")?.addEventListener("click", async () => {
    const delResult = await window.harness.deleteSoulFile(name);
    if (delResult.ok) {
      state.selectedSoulFile = null;
      soulEditor.innerHTML = '<div class="empty-state"><div class="empty-state-icon">S</div>Select or create a soul file</div>';
      refreshSoulFiles();
    }
  });
}

// New soul file button
$("#soul-new")?.addEventListener("click", async () => {
  const result = await window.harness.saveSoulFile("new-soul", {
    name: "New Soul",
    description: "",
    modelHint: "",
    systemPrompt: "You are a helpful assistant.",
  });
  if (result.ok) {
    state.selectedSoulFile = "new-soul";
    refreshSoulFiles();
    showSoulEditor("new-soul");
  }
});

$("#soul-refresh")?.addEventListener("click", refreshSoulFiles);

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
      // Auto-refresh deliverables after tool execution (may have produced output)
      refreshDeliverables();
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
// Settings Panel
// ═══════════════════════════════════════════════════════════

const settingsStatus = $("#settings-status");
const settingsSaveBtn = $("#settings-save") as HTMLButtonElement;

const settingsOpenaiKey = $("#settings-openai-key") as HTMLInputElement;
const settingsOpenaiBaseUrl = $("#settings-openai-base-url") as HTMLInputElement;
const settingsAnthropicKey = $("#settings-anthropic-key") as HTMLInputElement;
const settingsOllamaUrl = $("#settings-ollama-url") as HTMLInputElement;

const settingsDefaultProvider = $("#settings-default-provider") as HTMLSelectElement;
const settingsDefaultModel = $("#settings-default-model") as HTMLInputElement;
const settingsTemperature = $("#settings-temperature") as HTMLInputElement;
const settingsMaxIterations = $("#settings-max-iterations") as HTMLInputElement;
const settingsMaxTokens = $("#settings-max-tokens") as HTMLInputElement;

// Workspace permissions
const settingsAllowedPaths = $("#settings-allowed-paths") as HTMLTextAreaElement;
const settingsDeniedPaths = $("#settings-denied-paths") as HTMLTextAreaElement;
const settingsAllowOutsideWorkdir = $("#settings-allow-outside-workdir") as HTMLInputElement;
const settingsShellRestrictWorkdir = $("#settings-shell-restrict-workdir") as HTMLInputElement;

async function refreshSettings(): Promise<void> {
  const result = await window.harness.getSettings();
  if (!result.ok || !result.data) return;

  const cfg = result.data as any;

  // API Keys — populate only if they have values (don't overwrite user's in-progress edits on first load)
  settingsOpenaiKey.value = cfg.providers?.openai?.apiKey || "";
  settingsOpenaiBaseUrl.value = cfg.providers?.openai?.baseUrl || "";
  settingsAnthropicKey.value = cfg.providers?.anthropic?.apiKey || "";
  settingsOllamaUrl.value = cfg.providers?.ollama?.baseUrl || "";

  // Defaults
  settingsDefaultProvider.value = cfg.defaults?.provider || "openai";
  settingsDefaultModel.value = cfg.defaults?.soul ? "" : (
    cfg.providers?.[cfg.defaults?.provider || "openai"]?.defaultModel || ""
  );
  settingsTemperature.value = cfg.defaults?.temperature?.toString() || "";
  settingsMaxIterations.value = cfg.defaults?.maxIterations?.toString() || "";
  settingsMaxTokens.value = cfg.defaults?.maxTokens?.toString() || "";

  // Workspace permissions
  settingsAllowedPaths.value = (cfg.workspace?.allowedPaths || []).join("\n");
  settingsDeniedPaths.value = (cfg.workspace?.deniedPaths || []).join("\n");
  settingsAllowOutsideWorkdir.checked = cfg.workspace?.allowOutsideWorkdir ?? false;
  settingsShellRestrictWorkdir.checked = cfg.workspace?.shellRestrictToWorkdir ?? true;
}

settingsSaveBtn.addEventListener("click", async () => {
  settingsSaveBtn.disabled = true;
  settingsStatus.textContent = "";

  const settings: any = {
    providers: {
      openai: {
        apiKey: settingsOpenaiKey.value.trim(),
        baseUrl: settingsOpenaiBaseUrl.value.trim(),
        defaultModel: settingsDefaultProvider.value === "openai" ? settingsDefaultModel.value.trim() : undefined,
      },
      anthropic: {
        apiKey: settingsAnthropicKey.value.trim(),
        defaultModel: settingsDefaultProvider.value === "anthropic" ? settingsDefaultModel.value.trim() : undefined,
      },
      ollama: {
        baseUrl: settingsOllamaUrl.value.trim(),
        defaultModel: settingsDefaultProvider.value === "ollama" ? settingsDefaultModel.value.trim() : undefined,
      },
    },
    defaults: {
      provider: settingsDefaultProvider.value,
      temperature: settingsTemperature.value ? parseFloat(settingsTemperature.value) : undefined,
      maxIterations: settingsMaxIterations.value ? parseInt(settingsMaxIterations.value, 10) : undefined,
      maxTokens: settingsMaxTokens.value ? parseInt(settingsMaxTokens.value, 10) : undefined,
    },
    workspace: {
      allowedPaths: settingsAllowedPaths.value.split("\n").map((s: string) => s.trim()).filter(Boolean),
      deniedPaths: settingsDeniedPaths.value.split("\n").map((s: string) => s.trim()).filter(Boolean),
      allowOutsideWorkdir: settingsAllowOutsideWorkdir.checked,
      shellRestrictToWorkdir: settingsShellRestrictWorkdir.checked,
    },
  };

  const result = await window.harness.saveSettings(settings);

  settingsSaveBtn.disabled = false;

  if (result.ok) {
    settingsStatus.textContent = "Settings saved";
    settingsStatus.className = "settings-status settings-status-ok";
  } else {
    settingsStatus.textContent = `Error: ${result.error}`;
    settingsStatus.className = "settings-status settings-status-err";
  }

  // Clear status after a few seconds
  setTimeout(() => {
    settingsStatus.textContent = "";
  }, 3000);
});

// ═══════════════════════════════════════════════════════════
// Theme Switcher
// ═══════════════════════════════════════════════════════════

function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.setAttribute("data-theme", theme);
  state.theme = theme;
  localStorage.setItem("harness-theme", theme);

  // Update button active states
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    const btnTheme = (btn as HTMLElement).dataset.theme;
    if (btnTheme === theme) {
      btn.classList.add("theme-btn-active");
    } else {
      btn.classList.remove("theme-btn-active");
    }
  });
}

// Apply saved theme on load
applyTheme(state.theme);

// Bind theme buttons
document.querySelectorAll(".theme-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = (btn as HTMLElement).dataset.theme as "dark" | "light";
    applyTheme(theme);
  });
});

// Show/hide toggle for API key inputs
$$(".settings-toggle-vis").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = (btn as HTMLElement).dataset.target;
    if (!targetId) return;
    const input = document.getElementById(targetId) as HTMLInputElement;
    if (!input) return;

    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Menu Actions
// ═══════════════════════════════════════════════════════════

window.harness.onMenuAction("new-session", () => {
  switchToPanel("chat");
  sessionsList.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
  state.selectedSessionId = null;
  chatMessages.innerHTML = "";
  state.tokenHistory = [];
  state.eventLog = [];
  state.toolLog = [];
  chatInput.focus();
});

window.harness.onMenuAction("clear-history", () => {
  chatMessages.innerHTML = "";
});

window.harness.onMenuAction("settings", () => {
  switchToPanel("settings");
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
  refreshSessions();

  chatInput.focus();
}

init();

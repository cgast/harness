/**
 * Preload script - Exposes a safe IPC bridge to the renderer via contextBridge.
 *
 * The renderer accesses all harness functionality through `window.harness`.
 * This keeps contextIsolation enabled while giving the UI full control
 * over inputs, outputs, tools, skills, plugins, telemetry, files, and sessions.
 */

const { contextBridge, ipcRenderer } = require("electron");

export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * The API surface exposed to window.harness in the renderer.
 */
const harnessApi = {
  // ─── Task Execution ──────────────────────────────────────

  /** Run a task through the agent loop. */
  runTask: (options: {
    task: string;
    provider?: string;
    model?: string;
    temperature?: number;
    maxIterations?: number;
  }): Promise<IpcResult> => ipcRenderer.invoke("harness:run-task", options),

  /** Send text input to the running agent (HITL). */
  sendInput: (text: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:send-input", text),

  /** Check if a task is currently running. */
  isRunning: (): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke("harness:is-running"),

  // ─── Feedback / HITL ─────────────────────────────────────

  /** Respond to a feedback request from the agent. */
  feedbackRespond: (requestId: string, response: unknown): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:feedback-respond", requestId, response),

  /** Get all pending feedback requests. */
  feedbackPending: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:feedback-pending"),

  // ─── Telemetry ───────────────────────────────────────────

  /** Get current telemetry snapshot. */
  getTelemetry: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:telemetry"),

  // ─── Tools ───────────────────────────────────────────────

  /** List all registered tools. */
  getTools: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:tools-list"),

  /** Unregister a tool by name. */
  unregisterTool: (name: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:tools-unregister", name),

  // ─── Skills ──────────────────────────────────────────────

  /** List all skills with activation status. */
  getSkills: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:skills-list"),

  /** Activate a skill by ID. */
  activateSkill: (skillId: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:skills-activate", skillId),

  /** Deactivate a skill by ID. */
  deactivateSkill: (skillId: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:skills-deactivate", skillId),

  // ─── Plugins ─────────────────────────────────────────────

  /** List all loaded plugins. */
  getPlugins: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:plugins-list"),

  // ─── Deliverables ───────────────────────────────────────

  /** List files in the .harness-out/ deliverables directory. */
  getDeliverables: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:deliverables-list"),

  // ─── Sessions ────────────────────────────────────────────

  /** List historical sessions. */
  getSessions: (limit?: number): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:sessions-list", limit),

  /** Get a specific session by ID. */
  getSession: (id: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:sessions-get", id),

  /** Get event log for a session. */
  getSessionEvents: (sessionId: string, limit?: number): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:events-list", sessionId, limit),

  // ─── State / Config ──────────────────────────────────────

  /** Get current agent state snapshot. */
  getState: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:state"),

  /** Get harness configuration. */
  getConfig: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:config-get"),

  /** Update agent runtime config (model, provider, etc.). */
  updateConfig: (partial: Record<string, unknown>): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:config-update", partial),

  /** Get full settings (including provider API keys). */
  getSettings: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:settings-get"),

  /** Save settings to config file and hot-apply changes. */
  saveSettings: (settings: Record<string, unknown>): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:settings-save", settings),

  // ─── Messages ────────────────────────────────────────────

  /** Get conversation message history. */
  getMessages: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:messages"),

  // ─── Soul Files (system prompts) ─────────────────────────

  /** List all soul files in the souls directory. */
  getSoulFiles: (): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:soul-list"),

  /** Read a specific soul file by name. */
  getSoulFile: (name: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:soul-get", name),

  /** Save (create or update) a soul file. */
  saveSoulFile: (name: string, data: Record<string, unknown>): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:soul-save", name, data),

  /** Delete a soul file. */
  deleteSoulFile: (name: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:soul-delete", name),

  /** Set the active soul for the agent. */
  setActiveSoul: (name: string): Promise<IpcResult> =>
    ipcRenderer.invoke("harness:soul-set-active", name),

  // ─── Events (push from main → renderer) ──────────────────

  /** Subscribe to all harness events pushed from the main process. */
  onEvent: (callback: (payload: { event: string; data: unknown }) => void): void => {
    ipcRenderer.on("harness:event", (_event: any, payload: any) => callback(payload));
  },

  /** Subscribe to menu actions. */
  onMenuAction: (action: string, callback: () => void): void => {
    ipcRenderer.on(`menu:${action}`, () => callback());
  },
};

contextBridge.exposeInMainWorld("harness", harnessApi);

// Type declaration for the renderer
export type HarnessDesktopApi = typeof harnessApi;

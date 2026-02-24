/**
 * Type declarations for the Harness Desktop API
 * exposed to the renderer via contextBridge.
 */

interface IpcResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface RunTaskOptions {
  task: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

interface SoulFileData {
  name: string;
  description?: string;
  modelHint?: string;
  systemPrompt: string;
  active?: boolean;
}

interface HarnessDesktopApi {
  // Task execution
  runTask(options: RunTaskOptions): Promise<IpcResult>;
  sendInput(text: string): Promise<IpcResult>;
  isRunning(): Promise<IpcResult<boolean>>;

  // Feedback / HITL
  feedbackRespond(requestId: string, response: unknown): Promise<IpcResult>;
  feedbackPending(): Promise<IpcResult<unknown[]>>;

  // Telemetry
  getTelemetry(): Promise<IpcResult>;

  // Tools
  getTools(): Promise<IpcResult<unknown[]>>;
  unregisterTool(name: string): Promise<IpcResult>;

  // Skills
  getSkills(): Promise<IpcResult<unknown[]>>;
  activateSkill(skillId: string): Promise<IpcResult>;
  deactivateSkill(skillId: string): Promise<IpcResult>;

  // Plugins
  getPlugins(): Promise<IpcResult<unknown[]>>;

  // Deliverables
  getDeliverables(): Promise<IpcResult<Array<{ name: string; size: number; type: string; path: string }>>>;

  // Sessions
  getSessions(limit?: number): Promise<IpcResult<unknown[]>>;
  getSession(id: string): Promise<IpcResult>;
  getSessionEvents(sessionId: string, limit?: number): Promise<IpcResult<unknown[]>>;

  // State / Config
  getState(): Promise<IpcResult>;
  getConfig(): Promise<IpcResult>;
  updateConfig(partial: Record<string, unknown>): Promise<IpcResult>;

  // Settings (persistent config)
  getSettings(): Promise<IpcResult>;
  saveSettings(settings: Record<string, unknown>): Promise<IpcResult>;

  // Messages
  getMessages(): Promise<IpcResult<unknown[]>>;

  // Soul files (system prompts)
  getSoulFiles(): Promise<IpcResult<Array<{ name: string; active: boolean }>>>;
  getSoulFile(name: string): Promise<IpcResult<SoulFileData>>;
  saveSoulFile(name: string, data: Partial<SoulFileData>): Promise<IpcResult>;
  deleteSoulFile(name: string): Promise<IpcResult>;
  setActiveSoul(name: string): Promise<IpcResult>;

  // Events
  onEvent(callback: (payload: { event: string; data: unknown }) => void): void;
  onMenuAction(action: string, callback: () => void): void;
}

interface Window {
  harness: HarnessDesktopApi;
}

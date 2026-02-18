/**
 * AgentManager - Bridges @harness/core with the Electron desktop client.
 *
 * Owns the HarnessAgent lifecycle and exposes methods for the renderer
 * to control inputs, outputs, tools, skills, plugins, telemetry, and files.
 */

import * as path from "node:path";
import {
  createAgent,
  loadConfig,
  EventBus,
  ToolRegistry,
  PluginLoader,
  loadSkillsFromDir,
  resolveActiveSkills,
  CallbackFeedbackAdapter,
  type HarnessAgent,
  type HarnessConfig,
  type EventName,
  type AgentStateData,
  type ToolDefinition,
  type SkillDocument,
  type SessionRecord,
  type EventLogRecord,
  type PersistenceStore,
  type FeedbackRequest,
  type FeedbackResponse,
} from "@harness/core";

export interface TelemetrySnapshot {
  tokenUsage: { input: number; output: number; cost?: number };
  iterations: number;
  status: AgentStateData["status"];
  sessionId: string;
  model: string;
  provider: string;
  startedAt: string;
  activeSoul: string;
  activeSkills: string[];
  availableTools: string[];
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeout?: number;
  requiresConfirmation?: boolean;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  version: number;
  active: boolean;
  auto: boolean;
  keywords: string[];
  promptInjection?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
}

export interface RunTaskOptions {
  task: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

type EventCallback = (event: string, data: unknown) => void;

export class AgentManager {
  private agent: HarnessAgent | null = null;
  private config: HarnessConfig = {};
  private allSkills: SkillDocument[] = [];
  private pluginLoader: PluginLoader | null = null;
  private eventCallbacks: EventCallback[] = [];
  private isRunning = false;
  private pendingFeedback: Map<string, {
    request: FeedbackRequest;
    resolve: (response: FeedbackResponse) => void;
  }> = new Map();

  /**
   * Initialize the agent from config and set up the event bridge.
   */
  async initialize(configPath?: string): Promise<void> {
    this.config = loadConfig(configPath);
    this.agent = await createAgent(this.config);

    // Set up feedback adapter for desktop UI
    const desktopAdapter = new CallbackFeedbackAdapter(
      async (request: FeedbackRequest): Promise<FeedbackResponse> => {
        return new Promise((resolve) => {
          this.pendingFeedback.set(request.id, { request, resolve });
          this.emitToRenderer("feedback:ui-request", request);
        });
      },
      { id: "desktop-ui" }
    );
    this.agent.feedback.registerAdapter(desktopAdapter);

    // Wire global event listener to forward all events to renderer
    this.agent.bus.onAll((event: EventName, data: unknown) => {
      this.emitToRenderer(event, this.safeSerialize(data));
    });
  }

  /**
   * Subscribe to events forwarded to the renderer.
   */
  onEvent(callback: EventCallback): void {
    this.eventCallbacks.push(callback);
  }

  private emitToRenderer(event: string, data: unknown): void {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event, data);
      } catch {
        // Ignore renderer callback errors
      }
    }
  }

  // ─── Task Execution ────────────────────────────────────────

  async runTask(options: RunTaskOptions): Promise<{
    success: boolean;
    response: string;
    iterations: number;
    tokenUsage: { input: number; output: number };
    aborted: boolean;
  }> {
    if (!this.agent) throw new Error("Agent not initialized");
    if (this.isRunning) throw new Error("A task is already running");

    this.isRunning = true;

    try {
      // Apply overrides
      if (options.provider) {
        this.agent.state.set("config", {
          ...this.agent.state.get("config"),
          provider: options.provider,
        });
      }
      if (options.model) {
        this.agent.state.set("config", {
          ...this.agent.state.get("config"),
          model: options.model,
        });
      }
      if (options.temperature !== undefined) {
        this.agent.state.set("config", {
          ...this.agent.state.get("config"),
          temperature: options.temperature,
        });
      }
      if (options.maxIterations !== undefined) {
        this.agent.state.set("config", {
          ...this.agent.state.get("config"),
          maxIterations: options.maxIterations,
        });
      }

      const result = await this.agent.run(options.task);
      return result;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Send user input to the agent (for feedback/HITL responses).
   */
  async sendUserInput(text: string): Promise<void> {
    if (!this.agent) throw new Error("Agent not initialized");
    await this.agent.bus.emit("user:input", { text });
  }

  /**
   * Respond to a pending feedback request from the UI.
   */
  respondToFeedback(requestId: string, response: FeedbackResponse): void {
    const pending = this.pendingFeedback.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingFeedback.delete(requestId);
    }
  }

  /**
   * Get all pending feedback requests.
   */
  getPendingFeedback(): FeedbackRequest[] {
    return Array.from(this.pendingFeedback.values()).map((p) => p.request);
  }

  // ─── Telemetry ─────────────────────────────────────────────

  getTelemetry(): TelemetrySnapshot {
    if (!this.agent) throw new Error("Agent not initialized");
    const state = this.agent.state;
    const cfg = state.get("config");
    return {
      tokenUsage: state.get("tokenUsage"),
      iterations: state.get("iteration"),
      status: state.get("status"),
      sessionId: state.get("sessionId"),
      model: cfg.model,
      provider: cfg.provider,
      startedAt: state.get("startedAt").toISOString(),
      activeSoul: state.get("activeSoul"),
      activeSkills: state.get("activeSkills"),
      availableTools: state.get("availableTools"),
    };
  }

  // ─── Tools ─────────────────────────────────────────────────

  getTools(): ToolInfo[] {
    if (!this.agent) return [];
    return this.agent.tools.all().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      timeout: t.timeout,
      requiresConfirmation: t.requiresConfirmation,
    }));
  }

  registerTool(tool: ToolDefinition): void {
    if (!this.agent) throw new Error("Agent not initialized");
    this.agent.tools.register(tool);
  }

  unregisterTool(name: string): boolean {
    if (!this.agent) throw new Error("Agent not initialized");
    return this.agent.tools.unregister(name);
  }

  // ─── Skills ────────────────────────────────────────────────

  getSkills(): SkillInfo[] {
    if (!this.agent) return [];
    const activeIds = new Set(this.agent.state.get("activeSkills"));
    return this.allSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      active: activeIds.has(s.id),
      auto: s.activation?.auto ?? false,
      keywords: s.activation?.keywords ?? [],
      promptInjection: s.prompt_injection,
    }));
  }

  activateSkill(skillId: string): void {
    if (!this.agent) throw new Error("Agent not initialized");
    const current = this.agent.state.get("activeSkills");
    if (!current.includes(skillId)) {
      this.agent.state.set("activeSkills", [...current, skillId]);
      this.agent.bus.emit("skill:activate", { skillId });
    }
  }

  deactivateSkill(skillId: string): void {
    if (!this.agent) throw new Error("Agent not initialized");
    const current = this.agent.state.get("activeSkills");
    this.agent.state.set("activeSkills", current.filter((id) => id !== skillId));
    this.agent.bus.emit("skill:deactivate", { skillId });
  }

  // ─── Plugins ───────────────────────────────────────────────

  getPlugins(): PluginInfo[] {
    if (!this.pluginLoader) return [];
    return this.pluginLoader.list().map((id) => {
      const p = this.pluginLoader!.get(id);
      return {
        id: p?.id || id,
        name: p?.name || id,
        version: p?.version || "unknown",
      };
    });
  }

  // ─── Sessions / Persistence ────────────────────────────────

  getSessions(limit = 50): SessionRecord[] {
    if (!this.agent) return [];
    return this.agent.store.listSessions(limit);
  }

  getSession(id: string): SessionRecord | null {
    if (!this.agent) return null;
    return this.agent.store.getSession(id);
  }

  getEvents(sessionId: string, limit = 200): EventLogRecord[] {
    if (!this.agent) return [];
    return this.agent.store.getEvents(sessionId, limit);
  }

  // ─── State ─────────────────────────────────────────────────

  getState(): AgentStateData | null {
    if (!this.agent) return null;
    return this.agent.state.snapshot();
  }

  getConfig(): HarnessConfig {
    return this.config;
  }

  updateConfig(partial: Partial<AgentStateData["config"]>): void {
    if (!this.agent) throw new Error("Agent not initialized");
    this.agent.state.set("config", {
      ...this.agent.state.get("config"),
      ...partial,
    });
  }

  getRunning(): boolean {
    return this.isRunning;
  }

  // ─── Files ─────────────────────────────────────────────────

  getMessages(): Array<{ role: string; content: string; name?: string }> {
    if (!this.agent) return [];
    return this.agent.state.get("messages").map((m) => ({
      role: m.role,
      content: m.content,
      name: (m as any).name,
    }));
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.agent) {
      this.agent.store.close();
    }
    if (this.pluginLoader) {
      await this.pluginLoader.unloadAll();
    }
  }

  // ─── Utilities ─────────────────────────────────────────────

  private safeSerialize(data: unknown): unknown {
    try {
      return JSON.parse(
        JSON.stringify(data, (_, v) => {
          if (v instanceof Error) return { message: v.message, stack: v.stack };
          if (typeof v === "bigint") return v.toString();
          return v;
        })
      );
    } catch {
      return { _serialization_error: true };
    }
  }
}

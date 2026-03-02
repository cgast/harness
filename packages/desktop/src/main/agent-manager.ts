/**
 * AgentManager - Bridges @harness/core with the Electron desktop client.
 *
 * Owns the HarnessAgent lifecycle and exposes methods for the renderer
 * to control inputs, outputs, tools, skills, plugins, telemetry, and files.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import YAML from "yaml";
import {
  createAgent,
  loadConfig,
  loadSoul,
  findSoul,
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
  type SoulDocument,
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

  // ─── Settings (persistent config) ──────────────────────────

  getSettings(): HarnessConfig {
    return this.config;
  }

  saveSettings(settings: {
    providers?: {
      openai?: { apiKey?: string; defaultModel?: string; baseUrl?: string };
      anthropic?: { apiKey?: string; defaultModel?: string };
      ollama?: { baseUrl?: string; defaultModel?: string };
    };
    defaults?: {
      provider?: string;
      soul?: string;
      temperature?: number;
      maxIterations?: number;
      maxTokens?: number;
    };
  }): void {
    const home = this.config.harnessHome ||
      process.env.HARNESS_HOME ||
      path.join(process.env.HOME || "~", ".harness");
    const filePath = path.join(home, "config.yaml");

    // Ensure directory exists
    if (!fs.existsSync(home)) {
      fs.mkdirSync(home, { recursive: true });
    }

    // Read existing config file (if any) to preserve non-settings fields
    let fileConfig: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      fileConfig = YAML.parse(raw) || {};
    }

    // Merge providers
    if (settings.providers) {
      const existing = (fileConfig.providers || {}) as Record<string, unknown>;
      if (settings.providers.openai) {
        existing.openai = { ...(existing.openai as object || {}), ...settings.providers.openai };
        // Remove empty keys
        const oa = existing.openai as Record<string, unknown>;
        if (!oa.apiKey) delete oa.apiKey;
        if (!oa.baseUrl) delete oa.baseUrl;
        if (Object.keys(oa).length === 0) delete existing.openai;
      }
      if (settings.providers.anthropic) {
        existing.anthropic = { ...(existing.anthropic as object || {}), ...settings.providers.anthropic };
        const an = existing.anthropic as Record<string, unknown>;
        if (!an.apiKey) delete an.apiKey;
        if (Object.keys(an).length === 0) delete existing.anthropic;
      }
      if (settings.providers.ollama) {
        existing.ollama = { ...(existing.ollama as object || {}), ...settings.providers.ollama };
        const ol = existing.ollama as Record<string, unknown>;
        if (!ol.baseUrl) delete ol.baseUrl;
        if (Object.keys(ol).length === 0) delete existing.ollama;
      }
      if (Object.keys(existing).length > 0) {
        fileConfig.providers = existing;
      } else {
        delete fileConfig.providers;
      }
    }

    // Merge defaults
    if (settings.defaults) {
      const existing = (fileConfig.defaults || {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(settings.defaults)) {
        if (value !== undefined && value !== null && value !== "") {
          existing[key] = value;
        } else {
          delete existing[key];
        }
      }
      if (Object.keys(existing).length > 0) {
        fileConfig.defaults = existing;
      } else {
        delete fileConfig.defaults;
      }
    }

    // Write config back
    fs.writeFileSync(filePath, YAML.stringify(fileConfig), "utf-8");

    // Reload in-memory config
    this.config = loadConfig(filePath);

    // Hot-apply runtime config changes
    if (this.agent && settings.defaults) {
      const current = this.agent.state.get("config");
      const merged: Record<string, unknown> = { ...current };
      if (settings.defaults.provider) merged.provider = settings.defaults.provider;
      if (settings.defaults.temperature !== undefined) merged.temperature = settings.defaults.temperature;
      if (settings.defaults.maxIterations !== undefined) merged.maxIterations = settings.defaults.maxIterations;
      if (settings.defaults.maxTokens !== undefined) merged.maxTokens = settings.defaults.maxTokens;
      this.agent.state.set("config", merged as AgentStateData["config"]);
    }
  }

  // ─── Soul Files (system prompts) ────────────────────────────

  private getSoulsDir(): string {
    const home = this.config.harnessHome ||
      process.env.HARNESS_HOME ||
      path.join(process.env.HOME || "~", ".harness");
    return path.join(home, "souls");
  }

  getSoulFiles(): Array<{ name: string; active: boolean }> {
    const soulsDir = this.getSoulsDir();
    if (!fs.existsSync(soulsDir)) return [];

    const activeSoul = this.agent?.state.get("activeSoul") || "";
    const entries = fs.readdirSync(soulsDir);
    const results: Array<{ name: string; active: boolean }> = [];

    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const name = entry.replace(/\.(yaml|yml)$/, "");
      results.push({
        name,
        active: name === activeSoul || entry === activeSoul,
      });
    }

    return results;
  }

  getSoulFile(name: string): {
    name: string;
    description: string;
    modelHint: string;
    systemPrompt: string;
    active: boolean;
  } | null {
    const soulsDir = this.getSoulsDir();
    const filePath = path.join(soulsDir, `${name}.yaml`);
    const altPath = path.join(soulsDir, `${name}.yml`);
    const resolvedPath = fs.existsSync(filePath) ? filePath : fs.existsSync(altPath) ? altPath : null;

    if (!resolvedPath) return null;

    try {
      const soul = loadSoul(resolvedPath);
      const activeSoul = this.agent?.state.get("activeSoul") || "";
      return {
        name: soul.name,
        description: soul.layers?.context?.domain || "",
        modelHint: "",
        systemPrompt: this.soulToPromptContent(soul),
        active: soul.id === activeSoul,
      };
    } catch {
      // Fallback: read raw YAML
      const raw = fs.readFileSync(resolvedPath, "utf-8");
      return {
        name,
        description: "",
        modelHint: "",
        systemPrompt: raw,
        active: false,
      };
    }
  }

  saveSoulFile(name: string, data: {
    name?: string;
    description?: string;
    modelHint?: string;
    systemPrompt?: string;
  }): void {
    const soulsDir = this.getSoulsDir();
    if (!fs.existsSync(soulsDir)) {
      fs.mkdirSync(soulsDir, { recursive: true });
    }

    const filePath = path.join(soulsDir, `${name}.yaml`);

    // Try to load existing soul to preserve structure
    let soulData: Record<string, unknown> = {
      id: name,
      name: data.name || name,
      version: 1,
      layers: {
        context: {
          domain: data.description || "General-purpose assistance",
          special_instructions: [],
        },
        character: {
          traits: ["Helpful and thorough"],
          style: {
            verbosity: "concise",
            tone: "professional",
          },
        },
      },
    };

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        soulData = YAML.parse(raw) || soulData;
      } catch {
        // Use defaults
      }
    }

    // Apply updates
    if (data.name) soulData.name = data.name;
    if (data.description) {
      const layers = (soulData.layers || {}) as Record<string, unknown>;
      const ctx = (layers.context || {}) as Record<string, unknown>;
      ctx.domain = data.description;
      layers.context = ctx;
      soulData.layers = layers;
    }

    // If systemPrompt is provided as raw YAML content, try to parse it
    if (data.systemPrompt) {
      try {
        const parsed = YAML.parse(data.systemPrompt);
        if (parsed && typeof parsed === "object" && parsed.id && parsed.layers) {
          soulData = parsed;
        }
      } catch {
        // Not valid YAML structure - store as special_instructions
        const layers = (soulData.layers || {}) as Record<string, unknown>;
        const ctx = (layers.context || {}) as Record<string, unknown>;
        ctx.special_instructions = data.systemPrompt.split("\n").filter((l: string) => l.trim());
        layers.context = ctx;
        soulData.layers = layers;
      }
    }

    fs.writeFileSync(filePath, YAML.stringify(soulData), "utf-8");
  }

  deleteSoulFile(name: string): void {
    const soulsDir = this.getSoulsDir();
    const filePath = path.join(soulsDir, `${name}.yaml`);
    const altPath = path.join(soulsDir, `${name}.yml`);

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    else if (fs.existsSync(altPath)) fs.unlinkSync(altPath);
  }

  setActiveSoul(name: string): void {
    if (!this.agent) throw new Error("Agent not initialized");
    const oldValue = this.agent.state.get("activeSoul");
    this.agent.state.set("activeSoul", name);
    this.agent.bus.emit("state:change", { path: "activeSoul", oldValue, newValue: name });
  }

  private soulToPromptContent(soul: SoulDocument): string {
    // Reconstruct YAML from the soul document for editing
    const doc: Record<string, unknown> = {
      id: soul.id,
      name: soul.name,
      version: soul.version,
      layers: soul.layers,
    };
    return YAML.stringify(doc);
  }

  // ─── Heartbeat ───────────────────────────────────────────────

  private heartbeatControls: {
    getStatus: () => any;
    updateConfig: (updates: any) => void;
    trigger: () => Promise<void>;
    getHistory: () => any[];
  } | null = null;

  /**
   * Wire up heartbeat plugin controls. Called after plugins are loaded.
   */
  initHeartbeat(controls: {
    getStatus: () => any;
    updateConfig: (updates: any) => void;
    trigger: () => Promise<void>;
    getHistory: () => any[];
  }): void {
    this.heartbeatControls = controls;
  }

  getHeartbeatStatus(): any {
    if (!this.heartbeatControls) throw new Error("Heartbeat plugin not loaded");
    return this.heartbeatControls.getStatus();
  }

  updateHeartbeatConfig(updates: any): void {
    if (!this.heartbeatControls) throw new Error("Heartbeat plugin not loaded");
    this.heartbeatControls.updateConfig(updates);
  }

  async triggerHeartbeat(): Promise<void> {
    if (!this.heartbeatControls) throw new Error("Heartbeat plugin not loaded");
    await this.heartbeatControls.trigger();
  }

  getHeartbeatHistory(): any[] {
    if (!this.heartbeatControls) throw new Error("Heartbeat plugin not loaded");
    return this.heartbeatControls.getHistory();
  }

  // ─── Deliverables (.harness-out/) ──────────────────────────

  getDeliverables(): Array<{ name: string; size: number; type: string; path: string }> {
    const workdir = this.config.workdir || process.cwd();
    const outDir = path.join(workdir, ".harness-out");

    if (!fs.existsSync(outDir)) return [];

    try {
      const entries = fs.readdirSync(outDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => {
          const filePath = path.join(outDir, e.name);
          const stat = fs.statSync(filePath);
          const ext = path.extname(e.name).toLowerCase().replace(".", "") || "file";
          return {
            name: e.name,
            size: stat.size,
            type: ext,
            path: filePath,
          };
        });
    } catch {
      return [];
    }
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

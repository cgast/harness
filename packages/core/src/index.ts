/**
 * Harness Core - Public API
 *
 * The main entry point for creating and running agents.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import YAML from "yaml";

// Re-export all types
export type {
  LLMProvider,
  ChatRequest,
  ChatChunk,
  Message,
  MessageRole,
  ToolCallMessage,
  ToolDefinitionSchema,
  JSONSchema,
} from "./providers/provider.js";

export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "./tools/registry.js";

export type { HarnessPlugin, PluginContext, PluginConfig, Logger } from "./plugins/plugin.js";
export type { EventName, EventPayloads } from "./events/events.js";
export type { HookRegistration, AnyHookRegistration } from "./events/bus.js";
export type { PersistenceStore, SessionRecord, MemoryRecord, EventLogRecord } from "./persistence/store.js";
export type { SoulDocument, SoulLayer } from "./soul/loader.js";
export type { SkillDocument } from "./skills/loader.js";
export type { AgentStateData } from "./engine/state.js";
export type { WorkspacePermissions, WorkspaceValidationResult } from "./workspace/types.js";

// Feedback (human-in-the-loop) types
export type {
  FeedbackType,
  FeedbackRequest,
  FeedbackRequestBase,
  FeedbackResponse,
  FeedbackResponseBase,
  FeedbackStatus,
  ConfirmFeedbackRequest,
  ChoiceFeedbackRequest,
  TextFeedbackRequest,
  ReviewFeedbackRequest,
  FormFeedbackRequest,
  ConfirmFeedbackResponse,
  ChoiceFeedbackResponse,
  TextFeedbackResponse,
  ReviewFeedbackResponse,
  FormFeedbackResponse,
  TimeoutFeedbackResponse,
  CancelledFeedbackResponse,
  ErrorFeedbackResponse,
  ReviewVerdict,
  FormField,
  FeedbackAdapter,
  FeedbackManagerConfig,
  ChainContext,
  ChainResult,
  StepOutcome,
  TaskStepDef,
  GateStepDef,
  TransformStepDef,
  GateConfig,
} from "./feedback/index.js";

// Re-export classes
export { WorkspaceGuard } from "./workspace/guard.js";
export { EventBus } from "./events/bus.js";
export { AgentState } from "./engine/state.js";
export { ToolRegistry } from "./tools/registry.js";
export { ToolExecutor } from "./tools/executor.js";
export { MemoryStore } from "./persistence/memory.js";
export { SqliteStore } from "./persistence/sqlite.js";
export { PluginLoader, createPluginConfig, createLogger } from "./plugins/loader.js";
export { OpenAIProvider } from "./providers/openai.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { createOllamaProvider } from "./providers/ollama.js";

// Feedback (human-in-the-loop) classes
export {
  CallbackFeedbackAdapter,
  DeferredFeedbackAdapter,
  AutoApproveAdapter,
} from "./feedback/index.js";
export { FeedbackManager } from "./feedback/index.js";
export { TaskChain } from "./feedback/index.js";

// Re-export functions
export { loadSoul, findSoul } from "./soul/loader.js";
export { assembleSoulPrompt } from "./soul/injector.js";
export { loadSkill, loadSkillsFromDir } from "./skills/loader.js";
export { resolveActiveSkills, buildSkillPromptInjection, skillToolToDefinition } from "./skills/resolver.js";
export { runLoop } from "./engine/loop.js";
export { assemblePrompt } from "./engine/prompt-assembler.js";

// Built-in tools
export { shellTool } from "./tools/builtin/shell.js";
export { fileReadTool, fileWriteTool, fileListTool } from "./tools/builtin/file-ops.js";
export { httpFetchTool } from "./tools/builtin/http.js";

import { EventBus } from "./events/bus.js";
import { AgentState } from "./engine/state.js";
import { ToolRegistry } from "./tools/registry.js";
import { MemoryStore } from "./persistence/memory.js";
import { SqliteStore } from "./persistence/sqlite.js";
import { PluginLoader, createLogger, createPluginConfig } from "./plugins/loader.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { loadSoul, findSoul } from "./soul/loader.js";
import { loadSkillsFromDir } from "./skills/loader.js";
import { resolveActiveSkills, skillToolToDefinition } from "./skills/resolver.js";
import { runLoop, type LoopResult } from "./engine/loop.js";
import { shellTool } from "./tools/builtin/shell.js";
import { fileReadTool, fileWriteTool, fileListTool } from "./tools/builtin/file-ops.js";
import { httpFetchTool } from "./tools/builtin/http.js";
import type { LLMProvider } from "./providers/provider.js";
import type { PersistenceStore } from "./persistence/store.js";
import type { HarnessPlugin } from "./plugins/plugin.js";
import type { SoulDocument } from "./soul/loader.js";
import type { SkillDocument } from "./skills/loader.js";
import { FeedbackManager } from "./feedback/index.js";
import { WorkspaceGuard } from "./workspace/guard.js";

// ============================================================
// High-level API
// ============================================================

export interface HarnessConfig {
  // Provider settings
  providers?: {
    openai?: { apiKey: string; defaultModel?: string; baseUrl?: string };
    anthropic?: { apiKey: string; defaultModel?: string };
    ollama?: { baseUrl?: string; defaultModel?: string };
  };

  // Defaults
  defaults?: {
    provider?: string;
    soul?: string;
    temperature?: number;
    maxIterations?: number;
    maxTokens?: number;
  };

  // Paths
  harnessHome?: string;
  workdir?: string;

  // Workspace permissions (folder scoping)
  workspace?: {
    allowedPaths?: string[];
    deniedPaths?: string[];
    allowOutsideWorkdir?: boolean;
    shellRestrictToWorkdir?: boolean;
  };

  // Plugins
  plugins?: {
    enabled?: string[];
    /** Per-plugin configuration, keyed by plugin directory name or id. */
    [pluginName: string]: unknown;
  };

  // Human-in-the-loop feedback
  feedback?: {
    /** Default timeout for feedback requests (ms). Default: 300000 (5 min). */
    defaultTimeout?: number;
    /** Default priority for feedback requests. Default: 100. */
    defaultPriority?: number;
  };
}

export interface HarnessAgent {
  run(task: string): Promise<LoopResult>;
  state: AgentState;
  bus: EventBus;
  tools: ToolRegistry;
  store: PersistenceStore;
  feedback: FeedbackManager;
  workspace: WorkspaceGuard;
}

/**
 * Resolve environment variable references in strings (e.g., "${OPENAI_API_KEY}")
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
}

/**
 * Load config from ~/.harness/config.yaml or a given path.
 */
export function loadConfig(configPath?: string): HarnessConfig {
  const home = process.env.HARNESS_HOME || path.join(process.env.HOME || "~", ".harness");
  const filePath = configPath || path.join(home, "config.yaml");

  if (!fs.existsSync(filePath)) {
    return { harnessHome: home };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const config = YAML.parse(raw) as HarnessConfig;
  config.harnessHome = home;

  // Resolve env vars in API keys
  if (config.providers?.openai?.apiKey) {
    config.providers.openai.apiKey = resolveEnvVars(config.providers.openai.apiKey);
  }
  if (config.providers?.anthropic?.apiKey) {
    config.providers.anthropic.apiKey = resolveEnvVars(config.providers.anthropic.apiKey);
  }

  return config;
}

/**
 * Create a Harness agent from configuration.
 */
export async function createAgent(
  config: HarnessConfig = {}
): Promise<HarnessAgent> {
  const home = config.harnessHome || process.env.HARNESS_HOME || path.join(process.env.HOME || "~", ".harness");
  const workdir = config.workdir || process.cwd();

  // Event bus
  const bus = new EventBus();

  // State
  const defaults = config.defaults || {};
  const state = new AgentState(bus, {
    config: {
      model: defaults.provider === "anthropic"
        ? (config.providers?.anthropic?.defaultModel || "claude-sonnet-4-5-20250929")
        : defaults.provider === "ollama"
          ? (config.providers?.ollama?.defaultModel || "llama3.2")
          : (config.providers?.openai?.defaultModel || "gpt-4o"),
      provider: defaults.provider || "openai",
      temperature: defaults.temperature ?? 0.7,
      maxIterations: defaults.maxIterations ?? 25,
      maxTokens: defaults.maxTokens ?? 4096,
    },
  });

  // Persistence
  let store: PersistenceStore;
  const dbDir = path.join(home, "data");
  if (fs.existsSync(home)) {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    store = new SqliteStore(path.join(dbDir, "harness.db"));
  } else {
    store = new MemoryStore();
  }
  store.initialize();

  // Workspace guard (folder-scoped permissions)
  const workspaceGuard = new WorkspaceGuard(workdir, config.workspace);

  // Tool registry
  const toolRegistry = new ToolRegistry(bus);
  toolRegistry.register(shellTool);
  toolRegistry.register(fileReadTool);
  toolRegistry.register(fileWriteTool);
  toolRegistry.register(fileListTool);
  toolRegistry.register(httpFetchTool);

  // Providers
  const providers = new Map<string, LLMProvider>();

  if (config.providers?.openai?.apiKey) {
    providers.set("openai", new OpenAIProvider(config.providers.openai));
  }
  if (config.providers?.anthropic?.apiKey) {
    providers.set("anthropic", new AnthropicProvider(config.providers.anthropic));
  }
  if (config.providers?.ollama) {
    providers.set("ollama", createOllamaProvider(config.providers.ollama));
  }

  // Also check environment directly if no config
  if (!providers.has("openai") && process.env.OPENAI_API_KEY) {
    providers.set("openai", new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));
  }
  if (!providers.has("anthropic") && process.env.ANTHROPIC_API_KEY) {
    providers.set("anthropic", new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }

  // Load soul
  const soulId = defaults.soul || "default";
  const soulDirs = [
    path.join(home, "souls"),
    path.join(process.cwd(), "souls"),
  ];
  const soul = findSoul(soulId, soulDirs);

  // Load skills
  const skillDirs = [
    path.join(home, "skills"),
    path.join(process.cwd(), "skills"),
  ];
  let allSkills: SkillDocument[] = [];
  for (const dir of skillDirs) {
    allSkills = allSkills.concat(loadSkillsFromDir(dir));
  }

  // Register skill tools
  for (const skill of allSkills) {
    if (skill.tools?.provides) {
      for (const st of skill.tools.provides) {
        toolRegistry.register(skillToolToDefinition(st));
      }
    }
  }

  // Plugin loader
  const pluginDirs = [
    path.join(home, "plugins"),
    path.join(process.cwd(), "plugins"),
  ];
  const pluginLoader = new PluginLoader(pluginDirs);

  // Load plugins from config
  if (config.plugins?.enabled) {
    for (const pluginPath of config.plugins.enabled) {
      try {
        // Pass per-plugin config if available (keyed by plugin directory name)
        const pluginSpecificConfig =
          (config.plugins as Record<string, unknown>)?.[pluginPath] ?? {};
        const pluginConfigData =
          typeof pluginSpecificConfig === "object" && pluginSpecificConfig !== null
            ? (pluginSpecificConfig as Record<string, unknown>)
            : {};

        await pluginLoader.loadPlugin(
          pluginPath,
          {
            state,
            store,
            bus,
            config: createPluginConfig(pluginConfigData),
            log: createLogger(pluginPath),
          },
          toolRegistry,
          bus
        );
      } catch (err) {
        console.warn(`[harness] Failed to load plugin '${pluginPath}':`, err);
      }
    }
  }

  // Set up event logging to persistence
  bus.onAll((event, data) => {
    const sessionId = state.get("sessionId");
    store.logEvent({
      sessionId,
      event,
      data: JSON.stringify(data, (_, v) => (v instanceof Error ? v.message : v)),
      timestamp: new Date().toISOString(),
    });
  });

  // Workspace permission enforcement via tool:request hook
  bus.on("tool:request", async (data) => {
    const FILE_TOOLS = ["file_read", "file_write", "file_list"];

    if (FILE_TOOLS.includes(data.name)) {
      const targetPath = (data.args.path as string) || ".";
      const result = workspaceGuard.validatePath(targetPath);
      if (!result.allowed) {
        console.warn(`[workspace] Blocked ${data.name}: ${result.reason}`);
        return { abort: true };
      }
    }

    if (data.name === "shell" && data.args.workdir) {
      const result = workspaceGuard.validateShellWorkdir(data.args.workdir as string);
      if (!result.allowed) {
        console.warn(`[workspace] Blocked shell workdir: ${result.reason}`);
        return { abort: true };
      }
    }

    return data;
  }, 1); // Priority 1: run before all other hooks

  // Feedback manager (human-in-the-loop)
  const feedbackManager = new FeedbackManager(bus, state, config.feedback);

  // Update available tools in state
  state.set("availableTools", toolRegistry.names());
  state.set("activeSkills", allSkills.map((s) => s.id));
  if (soul) state.set("activeSoul", soul.id);

  return {
    state,
    bus,
    tools: toolRegistry,
    store,
    feedback: feedbackManager,
    workspace: workspaceGuard,

    async run(task: string): Promise<LoopResult> {
      const providerName = state.get("config").provider;
      const provider = providers.get(providerName);

      if (!provider) {
        const available = Array.from(providers.keys());
        throw new Error(
          `Provider '${providerName}' not configured. Available: ${available.join(", ") || "none (set OPENAI_API_KEY or ANTHROPIC_API_KEY)"}`
        );
      }

      // Resolve active skills for this task
      const activeSkills = resolveActiveSkills(allSkills, task);

      // Reset state for new task
      state.reset(task);
      state.set("availableTools", toolRegistry.names());
      state.set("activeSkills", activeSkills.map((s) => s.id));
      state.update({
        config: {
          ...state.get("config"),
          provider: providerName,
        },
      });

      const result = await runLoop(task, {
        provider,
        bus,
        toolRegistry,
        state,
        soul,
        activeSkills,
        workdir,
        onText: (text) => process.stdout.write(text),
      });

      // Persist session
      store.saveSession({
        id: state.get("sessionId"),
        task,
        soulId: soul?.id || null,
        messages: JSON.stringify(state.get("messages")),
        state: JSON.stringify(state.snapshot()),
        tokenUsage: JSON.stringify(state.get("tokenUsage")),
        createdAt: state.get("startedAt").toISOString(),
        endedAt: new Date().toISOString(),
      });

      return result;
    },
  };
}

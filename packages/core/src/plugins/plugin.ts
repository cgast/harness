/**
 * Plugin interface and related types.
 */

import type { EventBus, AnyHookRegistration } from "../events/bus.js";
import type { EventName } from "../events/events.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { LLMProvider } from "../providers/provider.js";
import type { PersistenceStore } from "../persistence/store.js";
import type { AgentState } from "../engine/state.js";

export interface PluginConfig {
  get<T>(key: string, defaultValue: T): T;
  set(key: string, value: unknown): void;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface PluginContext {
  state: AgentState;
  store: PersistenceStore;
  bus: EventBus;
  config: PluginConfig;
  log: Logger;
}

export interface UIContribution {
  // Placeholder for Electron UI contributions
  views?: Array<{ id: string; title: string; component: string }>;
}

export interface HarnessPlugin {
  id: string;
  name: string;
  version: string;

  // Lifecycle
  activate(ctx: PluginContext): Promise<void>;
  deactivate(): Promise<void>;

  // What this plugin provides (all optional)
  tools?: ToolDefinition[];
  providers?: LLMProvider[];
  hooks?: AnyHookRegistration[];
  ui?: UIContribution;
}

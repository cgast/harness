/**
 * Plugin loader - discovers and loads plugins from config.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { HarnessPlugin, PluginContext, PluginConfig, Logger } from "./plugin.js";
import type { EventBus } from "../events/bus.js";
import type { ToolRegistry } from "../tools/registry.js";

export function createLogger(pluginId: string): Logger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (msg, ...args) => console.debug(prefix, msg, ...args),
    info: (msg, ...args) => console.log(prefix, msg, ...args),
    warn: (msg, ...args) => console.warn(prefix, msg, ...args),
    error: (msg, ...args) => console.error(prefix, msg, ...args),
  };
}

export function createPluginConfig(
  initial: Record<string, unknown> = {}
): PluginConfig {
  const data = { ...initial };
  return {
    get<T>(key: string, defaultValue: T): T {
      return (data[key] as T) ?? defaultValue;
    },
    set(key: string, value: unknown): void {
      data[key] = value;
    },
  };
}

export class PluginLoader {
  private loaded: Map<string, HarnessPlugin> = new Map();

  /**
   * Load a plugin from a module path or an inline plugin object.
   */
  async loadPlugin(
    pluginOrPath: HarnessPlugin | string,
    ctx: PluginContext,
    toolRegistry: ToolRegistry,
    bus: EventBus
  ): Promise<HarnessPlugin> {
    let plugin: HarnessPlugin;

    if (typeof pluginOrPath === "string") {
      // Load from path
      const resolved = path.resolve(pluginOrPath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Plugin not found: ${resolved}`);
      }
      const mod = await import(resolved);
      plugin = mod.default || mod;
    } else {
      plugin = pluginOrPath;
    }

    // Activate the plugin
    await plugin.activate(ctx);

    // Register plugin's tools
    if (plugin.tools) {
      for (const tool of plugin.tools) {
        toolRegistry.register(tool);
      }
    }

    // Register plugin's hooks
    if (plugin.hooks) {
      for (const hook of plugin.hooks) {
        bus.on(hook.event, hook.handler, hook.priority);
      }
    }

    this.loaded.set(plugin.id, plugin);
    return plugin;
  }

  /**
   * Deactivate and unload all plugins.
   */
  async unloadAll(): Promise<void> {
    for (const plugin of this.loaded.values()) {
      try {
        await plugin.deactivate();
      } catch (err) {
        console.error(`Failed to deactivate plugin ${plugin.id}:`, err);
      }
    }
    this.loaded.clear();
  }

  /**
   * Get a loaded plugin by ID.
   */
  get(id: string): HarnessPlugin | undefined {
    return this.loaded.get(id);
  }

  /**
   * List all loaded plugin IDs.
   */
  list(): string[] {
    return Array.from(this.loaded.keys());
  }
}

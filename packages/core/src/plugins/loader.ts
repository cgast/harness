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
  private pluginDirs: string[];

  constructor(pluginDirs?: string[]) {
    this.pluginDirs = pluginDirs ?? [path.resolve(process.cwd(), "plugins")];
    // Also discover plugins/ in ancestor directories (handles monorepo sub-packages)
    let dir = process.cwd();
    while (true) {
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      const candidate = path.join(parent, "plugins");
      if (!this.pluginDirs.includes(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        this.pluginDirs.push(candidate);
      }
      dir = parent;
    }
  }

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
      // Load from path or plugin name
      const resolved = this.resolvePluginPath(pluginOrPath);
      const mod = await import(resolved);
      // Handle CJS/ESM interop: CJS with __esModule + exports.default
      // gets double-wrapped when loaded via import()
      plugin = mod.default?.default || mod.default || mod;
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
        bus.on(hook.event, hook.handler as any, hook.priority);
      }
    }

    this.loaded.set(plugin.id, plugin);
    return plugin;
  }

  /**
   * Resolve a plugin string to a loadable path.
   *
   * Resolution order:
   * 1. Absolute or relative paths (starting with / ./ ../) — resolve against cwd
   * 2. Try require.resolve for npm packages
   * 3. Scan plugins/ directory for a matching package
   */
  private resolvePluginPath(pluginOrPath: string): string {
    // 1. Explicit file paths — resolve against cwd
    if (pluginOrPath.startsWith("/") || pluginOrPath.startsWith("./") || pluginOrPath.startsWith("../")) {
      const resolved = path.resolve(pluginOrPath);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
      throw new Error(`Plugin not found: ${resolved}`);
    }

    // 2. Try Node module resolution (handles npm packages and workspace links)
    try {
      return require.resolve(pluginOrPath, { paths: [process.cwd()] });
    } catch {
      // Not an installed package, continue
    }

    // 3. Scan configured plugin directories
    for (const pluginsDir of this.pluginDirs) {
      if (!fs.existsSync(pluginsDir) || !fs.statSync(pluginsDir).isDirectory()) continue;

      const candidates: string[] = [];
      try {
        candidates.push(...fs.readdirSync(pluginsDir));
      } catch {
        // Can't read plugins dir, skip
        continue;
      }

      for (const dir of candidates) {
        const pluginDir = path.join(pluginsDir, dir);
        if (!fs.statSync(pluginDir).isDirectory()) continue;

        const pkgPath = path.join(pluginDir, "package.json");
        if (!fs.existsSync(pkgPath)) continue;

        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          const mainEntry = pkg.main || "index.js";
          const entryPoint = path.resolve(pluginDir, mainEntry);

          // Match by directory name, by "harness-<dir>" convention, or by package name
          if (
            dir === pluginOrPath ||
            `harness-${dir}` === pluginOrPath ||
            pkg.name === pluginOrPath
          ) {
            if (fs.existsSync(entryPoint)) {
              return entryPoint;
            }
          }
        } catch {
          // Malformed package.json, skip
        }
      }
    }

    throw new Error(
      `Plugin not found: "${pluginOrPath}". Searched as file path, npm package, and in plugins/ directory.`
    );
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

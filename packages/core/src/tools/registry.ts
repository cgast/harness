/**
 * Tool registry - manages tool registration, discovery, and lookup.
 */

import type { JSONSchema } from "../providers/provider.js";
import type { EventBus } from "../events/bus.js";

export interface ToolContext {
  workdir: string;
  state: any; // AgentState - avoid circular import
  emit: (event: string, data: unknown) => void;
}

export interface ToolResult {
  success: boolean;
  output: string;
  artifacts?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  timeout?: number; // ms, default 30000
  requiresConfirmation?: boolean;
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private bus?: EventBus;

  constructor(bus?: EventBus) {
    this.bus = bus;
  }

  /**
   * Register a tool. Overwrites if already registered.
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.bus?.emit("tool:register", {
      tool: { name: tool.name, description: tool.description },
    });
  }

  /**
   * Unregister a tool by name.
   */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    if (existed) {
      this.bus?.emit("tool:unregister", { name });
    }
    return existed;
  }

  /**
   * Get a tool by name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tool names.
   */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tool definitions.
   */
  all(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions formatted for LLM consumption.
   */
  toSchemas(): Array<{ name: string; description: string; parameters: JSONSchema }> {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
  }
}

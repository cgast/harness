/**
 * Tool executor - safely executes tools with timeout and event emission.
 */

import type { EventBus } from "../events/bus.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./registry.js";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds

export class ToolExecutor {
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  /**
   * Execute a tool with timeout, event emission, and error handling.
   */
  async execute(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const timeout = tool.timeout ?? DEFAULT_TIMEOUT;

    // Emit tool:request (modifiable, can abort)
    const requestData = await this.bus.emit("tool:request", {
      name: tool.name,
      args,
    });

    if (!requestData) {
      // Aborted by a hook
      return {
        success: false,
        output: `Tool call '${tool.name}' was blocked by a plugin hook.`,
      };
    }

    // Use potentially modified args
    const finalArgs = requestData.args;

    // Emit tool:start
    await this.bus.emit("tool:start", {
      name: tool.name,
      args: finalArgs,
    });

    const startTime = Date.now();

    try {
      // Execute with timeout
      const result = await this.withTimeout(
        tool.execute(finalArgs, ctx),
        timeout,
        tool.name
      );

      const duration = Date.now() - startTime;

      // Emit tool:result (modifiable)
      const resultData = await this.bus.emit("tool:result", {
        name: tool.name,
        result,
        duration,
      });

      // Return potentially modified result
      return resultData?.result ?? result;
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = err instanceof Error ? err : new Error(String(err));

      // Emit tool:error
      await this.bus.emit("tool:error", {
        name: tool.name,
        error,
      });

      return {
        success: false,
        output: `Tool '${tool.name}' failed after ${duration}ms: ${error.message}`,
      };
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    toolName: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

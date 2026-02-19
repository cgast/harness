/**
 * Harness Plugin Template
 *
 * A starter template demonstrating all plugin capabilities:
 *   - Lifecycle hooks (activate / deactivate)
 *   - Custom tools
 *   - Event hooks (observe and modify)
 *   - Plugin configuration
 *   - Plugin-scoped persistent state
 *
 * Copy this directory and rename it to start building your own plugin.
 *
 * Quick start:
 *   1. cp -r plugins/template plugins/my-plugin
 *   2. Update package.json name to "@harness/plugin-my-plugin"
 *   3. Edit this file to implement your plugin logic
 *   4. Add "my-plugin" to plugins.enabled in ~/.harness/config.yaml
 *   5. pnpm install && pnpm build
 */

import type {
  HarnessPlugin,
  PluginContext,
  Logger,
  ToolDefinition,
  ToolContext,
  ToolResult,
  EventPayloads,
} from "@harness/core";

// ── Plugin state ───────────────────────────────────────────────
// Module-level variables are available to all hooks and tools
// after activate() runs. Clean them up in deactivate().

let log: Logger;
let ctx: PluginContext;

// ── Plugin definition ──────────────────────────────────────────

const templatePlugin: HarnessPlugin = {
  id: "harness-template",
  name: "Template Plugin",
  version: "0.1.0",

  // ── Lifecycle ──────────────────────────────────────────────

  async activate(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    log = ctx.log;

    // Read plugin configuration (set in ~/.harness/config.yaml or programmatically)
    const greeting = ctx.config.get("greeting", "Hello from template plugin!");
    log.info(greeting);

    // You can read/write persistent state scoped to this plugin:
    //   ctx.store.setMemory("last-activated", new Date().toISOString(), "plugin:harness-template");
    //   const lastActivated = ctx.store.getMemory("last-activated", "plugin:harness-template");

    // You can store arbitrary data in agent state under pluginData:
    //   ctx.state.set("pluginData", {
    //     ...ctx.state.get("pluginData"),
    //     "harness-template": { activatedAt: Date.now() },
    //   });
  },

  async deactivate() {
    log?.info("Template plugin deactivated");
    // Clean up any resources (timers, connections, etc.) here
  },

  // ── Tools ──────────────────────────────────────────────────
  // Tools are registered automatically when the plugin loads.
  // The LLM can invoke them during the agent loop.

  tools: [
    {
      name: "template_echo",
      description:
        "A sample tool that echoes back the provided message. " +
        "Replace this with your own tool implementation.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to echo back.",
          },
        },
        required: ["message"],
      },
      timeout: 5_000, // 5 seconds

      async execute(
        args: Record<string, unknown>,
        toolCtx: ToolContext
      ): Promise<ToolResult> {
        const message = args.message as string;
        log?.info(`template_echo called with: ${message}`);

        return {
          success: true,
          output: `Echo: ${message}`,
          // Optional: return file paths or URIs the LLM should know about
          // artifacts: ["/tmp/generated-file.txt"],
        };
      },
    },
  ],

  // ── Event hooks ────────────────────────────────────────────
  // Hooks let you observe or modify events flowing through the system.
  // Lower priority numbers run first (default: 100).
  //
  // For modifiable events, return the (possibly modified) data to pass
  // it along, or return { abort: true } to cancel the action.
  //
  // For non-modifiable events, return void (the return value is ignored).
  //
  // See docs/plugin-development.md for the full event reference.

  hooks: [
    // ── Example: observe agent start ──
    {
      event: "agent:start" as const,
      priority: 100,
      handler: async (data: EventPayloads["agent:start"]) => {
        log?.info(`Agent starting task: "${data.task}"`);
        // This is a modifiable event. You could modify the payload:
        //   return { ...data, task: data.task + " (modified by template)" };
        // Or abort it:
        //   return { abort: true };
        return data;
      },
    },

    // ── Example: observe tool results ──
    {
      event: "tool:result" as const,
      priority: 100,
      handler: async (data: EventPayloads["tool:result"]) => {
        log?.debug(
          `Tool "${data.name}" returned (${data.result.success ? "ok" : "fail"}) in ${data.duration}ms`
        );
        // tool:result is modifiable — you can transform the result before
        // the LLM sees it:
        //   return { ...data, result: { ...data.result, output: data.result.output + "\n[reviewed]" } };
      },
    },

    // ── Example: modify prompt before LLM call ──
    // Uncomment to inject context into every prompt:
    //
    // {
    //   event: "prompt:assemble" as const,
    //   priority: 50,
    //   handler: async (data: EventPayloads["prompt:assemble"]) => {
    //     return {
    //       ...data,
    //       systemPrompt: data.systemPrompt + "\n\nAdditional context from template plugin.",
    //     };
    //   },
    // },

    // ── Example: gate dangerous tool calls ──
    // Uncomment to require approval for specific tools:
    //
    // {
    //   event: "tool:request" as const,
    //   priority: 10,
    //   handler: async (data: EventPayloads["tool:request"]) => {
    //     const blocked = ["shell", "file_write"];
    //     if (blocked.includes(data.name)) {
    //       log?.warn(`Blocking tool call: ${data.name}`);
    //       return { abort: true };
    //     }
    //     return data;
    //   },
    // },
  ],
};

export default templatePlugin;

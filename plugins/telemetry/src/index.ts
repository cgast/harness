/**
 * Built-in telemetry plugin - logs LLM usage and tool execution stats.
 */

import type { HarnessPlugin, PluginContext, Logger } from "@harness/core";

let log: Logger;

const telemetryPlugin: HarnessPlugin = {
  id: "harness-telemetry",
  name: "Telemetry",
  version: "1.0.0",

  async activate(ctx: PluginContext) {
    log = ctx.log;
    log.info("Telemetry plugin activated");
  },

  async deactivate() {
    log?.info("Telemetry plugin deactivated");
  },

  hooks: [
    {
      event: "llm:response",
      handler: async (data: any) => {
        log?.info(
          `LLM response: ${data.usage.inputTokens}in / ${data.usage.outputTokens}out tokens`
        );
      },
    },
    {
      event: "tool:result",
      handler: async (data: any) => {
        log?.info(
          `Tool ${data.name}: ${data.result.success ? "success" : "fail"} (${data.duration}ms)`
        );
      },
    },
    {
      event: "agent:end",
      handler: async (data: any) => {
        const total = data.tokenUsage.input + data.tokenUsage.output;
        log?.info(
          `Task complete. Total tokens: ${total} (${data.tokenUsage.input}in / ${data.tokenUsage.output}out)`
        );
      },
    },
  ],
};

export default telemetryPlugin;

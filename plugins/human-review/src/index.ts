/**
 * Human Review Gate Plugin
 *
 * Demonstrates the HITL feedback system by adding review gates
 * to dangerous tool calls and providing a tool the LLM can use
 * to explicitly request human input.
 *
 * Features:
 *   - Intercepts dangerous tool calls (shell, file_write) with confirmation gates
 *   - Provides an `ask_human` tool the LLM can invoke when it needs guidance
 *   - Logs all feedback interactions for audit
 *   - Configurable dangerous tools list and timeout
 *
 * Configuration (via plugin config):
 *   - dangerousTools: string[]  — tool names that require confirmation (default: ["shell", "file_write"])
 *   - feedbackTimeout: number   — timeout in ms for feedback requests (default: 120000)
 *   - adapterId: string         — which feedback adapter to use (default: first available)
 *
 * Usage:
 *   const agent = await createAgent(config);
 *
 *   // Register a feedback adapter (required)
 *   agent.feedback.registerAdapter(new CallbackFeedbackAdapter(async (req) => {
 *     // Your UI logic here — show prompt, collect response
 *     return { requestId: req.id, status: "completed", approved: true, respondedAt: new Date().toISOString() };
 *   }));
 *
 *   // The plugin hooks into tool:request automatically
 *   const result = await agent.run("Delete all temp files");
 *   // → Agent will pause and ask for confirmation before running `shell` with `rm`
 */

import type {
  HarnessPlugin,
  PluginContext,
  Logger,
  ToolDefinition,
  ToolContext,
  ToolResult,
  ConfirmFeedbackResponse,
} from "@harness/core";
import { FeedbackManager } from "@harness/core";

let log: Logger;
let feedbackManager: FeedbackManager;
let dangerousTools: string[];
let feedbackTimeout: number;
let preferredAdapterId: string | undefined;

const humanReviewPlugin: HarnessPlugin = {
  id: "harness-human-review",
  name: "Human Review Gate",
  version: "1.0.0",

  async activate(ctx: PluginContext) {
    log = ctx.log;

    // Read configuration
    dangerousTools = ctx.config.get("dangerousTools", ["shell", "file_write"]);
    feedbackTimeout = ctx.config.get("feedbackTimeout", 120_000);
    preferredAdapterId = ctx.config.get("adapterId", undefined);

    // Get the FeedbackManager from the bus — it's created by the agent
    // and available via the plugin context's state/bus
    feedbackManager = new FeedbackManager(ctx.bus, ctx.state, {
      defaultTimeout: feedbackTimeout,
    });

    log.info(
      `Human Review Gate activated. Guarding tools: [${dangerousTools.join(", ")}]`
    );
  },

  async deactivate() {
    if (feedbackManager) {
      await feedbackManager.dispose();
    }
    log?.info("Human Review Gate deactivated");
  },

  // Provide an `ask_human` tool the LLM can use to request input
  tools: [
    {
      name: "ask_human",
      description:
        "Ask a human for guidance, clarification, or approval. Use this when you are " +
        "unsure how to proceed, need to validate an approach, or want feedback on output " +
        "before continuing. The human's response will be returned as text.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question or prompt to show the human.",
          },
          context: {
            type: "string",
            description:
              "Optional context to help the human understand what you need (e.g. what you've done so far, what options you see).",
          },
        },
        required: ["question"],
      },
      requiresConfirmation: false, // The tool itself IS the confirmation mechanism
      timeout: 600_000, // 10 min — humans are slow

      async execute(
        args: Record<string, unknown>,
        ctx: ToolContext
      ): Promise<ToolResult> {
        const question = args.question as string;
        const context = args.context as string | undefined;

        const prompt = context
          ? `${question}\n\nContext: ${context}`
          : question;

        try {
          const response = await feedbackManager.askText(prompt, {
            adapterId: preferredAdapterId,
            timeout: feedbackTimeout,
            multiline: true,
            placeholder: "Type your response...",
            metadata: { source: "ask_human_tool" },
          });

          if (response.status === "timeout") {
            return {
              success: true,
              output: "[Human did not respond within the timeout period. Proceed with your best judgment.]",
            };
          }

          if (response.status === "cancelled") {
            return {
              success: true,
              output: "[Human cancelled the request. Proceed with your best judgment.]",
            };
          }

          return {
            success: true,
            output: `Human response: ${(response as any).text || "(no text)"}`,
          };
        } catch (err) {
          return {
            success: false,
            output: `Failed to reach human: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
  ],

  hooks: [
    {
      // Intercept dangerous tool calls with a confirmation gate
      event: "tool:request",
      priority: 5, // Run early — before other plugins
      handler: async (data: any) => {
        if (!dangerousTools.includes(data.name)) {
          return data; // Not a dangerous tool — pass through
        }

        log?.info(
          `[Human Review] Tool '${data.name}' requires confirmation. Args: ${JSON.stringify(data.args)}`
        );

        try {
          const response = await feedbackManager.confirm(
            `The agent wants to execute a potentially dangerous tool.`,
            `${data.name}(${JSON.stringify(data.args, null, 2)})`,
            {
              adapterId: preferredAdapterId,
              timeout: feedbackTimeout,
              defaultDeny: true, // If timeout, deny by default
              metadata: { tool: data.name, args: data.args },
            }
          );

          if (response.status === "timeout") {
            log?.warn(
              `[Human Review] Confirmation timed out for '${data.name}'. Denying.`
            );
            return { abort: true };
          }

          if (
            response.status === "completed" &&
            (response as ConfirmFeedbackResponse).approved
          ) {
            log?.info(`[Human Review] Tool '${data.name}' approved.`);
            return data; // Continue execution
          }

          log?.info(
            `[Human Review] Tool '${data.name}' denied. Reason: ${(response as ConfirmFeedbackResponse).reason || "none"}`
          );
          return { abort: true };
        } catch (err) {
          log?.error(
            `[Human Review] Error during confirmation for '${data.name}':`,
            err
          );
          return { abort: true }; // Fail-safe: deny on error
        }
      },
    },

    {
      // Log all feedback events for audit
      event: "feedback:response",
      priority: 100,
      handler: async (data: any) => {
        log?.info(
          `[Human Review] Feedback received for request ${data.request.id}: ` +
            `status=${data.response.status}, adapter=${data.adapterId}, ` +
            `duration=${data.durationMs}ms`
        );
      },
    },

    {
      // Log feedback timeouts
      event: "feedback:timeout",
      priority: 100,
      handler: async (data: any) => {
        log?.warn(
          `[Human Review] Feedback timeout for request ${data.request.id}: ` +
            `adapter=${data.adapterId}, timeout=${data.timeoutMs}ms`
        );
      },
    },
  ],
};

export default humanReviewPlugin;

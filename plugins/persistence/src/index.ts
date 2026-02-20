/**
 * Persistence Plugin
 *
 * Maintains cross-session continuity by:
 *   1. Summarizing each session's key outcomes and storing them
 *   2. Injecting past session summaries into the system prompt ("soul context")
 *   3. Providing a tool to browse session history
 *
 * This effectively gives the agent a long-term memory that enriches its soul
 * document — it "knows" what happened in past conversations and can reference
 * that context naturally.
 *
 * Stored data (PersistenceStore, scope "plugin:persistence"):
 *   - "session-log": array of SessionRecord objects
 *
 * Example usage in config:
 *   plugins:
 *     enabled:
 *       - "persistence"
 */

import type {
  HarnessPlugin,
  PluginContext,
  Logger,
  ToolContext,
  ToolResult,
} from "@harness/core";

// ── Types ─────────────────────────────────────────────────────

interface SessionRecord {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  task: string;
  summary: string;
  outcome: "completed" | "partial" | "error";
  tokenUsage: { input: number; output: number };
}

// ── State ─────────────────────────────────────────────────────

const SCOPE = "plugin:persistence";
const LOG_KEY = "session-log";
const MAX_HISTORY_IN_PROMPT = 10; // only inject the last N sessions

let log: Logger;
let ctx: PluginContext;
let sessionStartTime: string;
let sessionTask: string;

// ── Helpers ───────────────────────────────────────────────────

function loadSessionLog(): SessionRecord[] {
  const raw = ctx.store.getMemory(LOG_KEY, SCOPE);
  if (!raw) return [];
  return raw as SessionRecord[];
}

function saveSessionLog(records: SessionRecord[]): void {
  ctx.store.setMemory(LOG_KEY, records, SCOPE);
}

function formatHistoryForPrompt(records: SessionRecord[]): string {
  if (records.length === 0) return "";

  const recent = records.slice(-MAX_HISTORY_IN_PROMPT);
  const lines = recent.map(
    (r) =>
      `- [${r.endedAt}] Task: "${r.task}" — ${r.outcome}. ${r.summary}`
  );

  return (
    "\n\n## Past session context\n" +
    "The following is a summary of recent past sessions with this user. " +
    "Use this context to maintain continuity, but do not repeat it unless asked.\n" +
    lines.join("\n")
  );
}

function buildSummary(messages: any[]): string {
  // Extract a lightweight summary from the conversation.
  // In a real implementation you might call the LLM to summarize,
  // but for simplicity we take the last assistant message as a proxy.
  if (!messages || messages.length === 0) return "No messages recorded.";

  const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
  if (assistantMsgs.length === 0) return "Session had no assistant responses.";

  const last = assistantMsgs[assistantMsgs.length - 1];
  const text =
    typeof last.content === "string"
      ? last.content
      : JSON.stringify(last.content);

  // Truncate to a reasonable length
  const maxLen = 200;
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// ── Plugin ────────────────────────────────────────────────────

const persistencePlugin: HarnessPlugin = {
  id: "harness-persistence",
  name: "Session Persistence",
  version: "0.1.0",

  async activate(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    log = ctx.log;

    const records = loadSessionLog();
    log.info(
      `Persistence plugin activated. ${records.length} past session(s) on file.`
    );
  },

  async deactivate() {
    log?.info("Persistence plugin deactivated");
  },

  // ── Tools ────────────────────────────────────────────────

  tools: [
    {
      name: "session_history",
      description:
        "Browse past session summaries. Use this to recall what happened in " +
        "previous conversations with the user.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description:
              "Maximum number of sessions to return (default: 5, newest first).",
          },
          query: {
            type: "string",
            description: "Optional keyword to filter sessions by task or summary.",
          },
        },
        required: [],
      },
      timeout: 5_000,

      async execute(
        args: Record<string, unknown>,
        _toolCtx: ToolContext
      ): Promise<ToolResult> {
        const limit = (args.limit as number) || 5;
        const query = (args.query as string)?.toLowerCase();

        let records = loadSessionLog();

        if (query) {
          records = records.filter(
            (r) =>
              r.task.toLowerCase().includes(query) ||
              r.summary.toLowerCase().includes(query)
          );
        }

        const recent = records.slice(-limit).reverse();

        if (recent.length === 0) {
          return {
            success: true,
            output: query
              ? `No past sessions matching "${query}".`
              : "No past sessions recorded yet.",
          };
        }

        const lines = recent.map(
          (r, i) =>
            `${i + 1}. [${r.endedAt}] (${r.outcome})\n   Task: ${r.task}\n   Summary: ${r.summary}`
        );

        return {
          success: true,
          output: `Past sessions (${recent.length}):\n\n${lines.join("\n\n")}`,
        };
      },
    },
  ],

  // ── Hooks ────────────────────────────────────────────────

  hooks: [
    {
      // Capture the task when a session starts
      event: "agent:start" as const,
      priority: 90,
      handler: async (data: any) => {
        sessionStartTime = new Date().toISOString();
        sessionTask = data.task || "unknown";
        log?.debug(`Session started: "${sessionTask}"`);
        return data;
      },
    },

    {
      // Record the session when it ends
      event: "agent:end" as const,
      priority: 90,
      handler: async (data: any) => {
        const messages = ctx.state.get("messages") || [];
        const record: SessionRecord = {
          sessionId: ctx.state.get("sessionId") || "unknown",
          startedAt: sessionStartTime || new Date().toISOString(),
          endedAt: new Date().toISOString(),
          task: sessionTask || "unknown",
          summary: buildSummary(messages),
          outcome: data.error ? "error" : "completed",
          tokenUsage: data.tokenUsage || { input: 0, output: 0 },
        };

        const records = loadSessionLog();
        records.push(record);
        saveSessionLog(records);

        log?.info(`Session recorded: "${record.task}" (${record.outcome})`);
      },
    },

    {
      // Inject past session context into the system prompt
      event: "prompt:assemble" as const,
      priority: 70,
      handler: async (data: any) => {
        const records = loadSessionLog();
        if (records.length === 0) return data;

        return {
          ...data,
          systemPrompt: data.systemPrompt + formatHistoryForPrompt(records),
        };
      },
    },
  ],
};

export default persistencePlugin;

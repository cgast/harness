/**
 * Memory Plugin
 *
 * Stores essential facts about the user ("wisdom") that persist across sessions.
 * The LLM can save and recall facts using two tools:
 *   - memory_store: save a fact (e.g. "User prefers TypeScript over JavaScript")
 *   - memory_recall: retrieve stored facts, optionally filtered by a search term
 *
 * Facts are stored in the PersistenceStore under the "plugin:memory" scope.
 * On each session start, all stored facts are injected into the system prompt
 * so the agent already "knows" the user.
 *
 * Example usage in config:
 *   plugins:
 *     enabled:
 *       - "memory"
 */

import type {
  HarnessPlugin,
  PluginContext,
  Logger,
  ToolContext,
  ToolResult,
} from "@harness/core";

// ── Types ─────────────────────────────────────────────────────

interface MemoryEntry {
  fact: string;
  category: string;
  createdAt: string;
}

// ── State ─────────────────────────────────────────────────────

const SCOPE = "plugin:memory";
const STORE_KEY = "user-facts";

let log: Logger;
let ctx: PluginContext;

// ── Helpers ───────────────────────────────────────────────────

function loadFacts(): MemoryEntry[] {
  const raw = ctx.store.getMemory(STORE_KEY, SCOPE);
  if (!raw) return [];
  return raw as MemoryEntry[];
}

function saveFacts(facts: MemoryEntry[]): void {
  ctx.store.setMemory(STORE_KEY, facts, SCOPE);
}

function formatFactsForPrompt(facts: MemoryEntry[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((f) => `- [${f.category}] ${f.fact}`);
  return (
    "\n\n## Known facts about the user\n" +
    "The following was remembered from previous conversations:\n" +
    lines.join("\n")
  );
}

// ── Plugin ────────────────────────────────────────────────────

const memoryPlugin: HarnessPlugin = {
  id: "harness-memory",
  name: "Memory",
  version: "0.1.0",

  async activate(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    log = ctx.log;

    const facts = loadFacts();
    log.info(`Memory plugin activated with ${facts.length} stored fact(s)`);
  },

  async deactivate() {
    log?.info("Memory plugin deactivated");
  },

  // ── Tools ────────────────────────────────────────────────

  tools: [
    {
      name: "memory_store",
      description:
        "Store an important fact about the user for future sessions. " +
        "Use this when the user shares a preference, constraint, or personal detail " +
        "that would be useful to remember later. Avoid storing trivial or transient info.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description:
              'The fact to remember (e.g. "Prefers dark mode", "Works at Acme Corp").',
          },
          category: {
            type: "string",
            description:
              "A short category for the fact: preference, background, project, or general.",
          },
        },
        required: ["fact"],
      },
      timeout: 5_000,

      async execute(
        args: Record<string, unknown>,
        _toolCtx: ToolContext
      ): Promise<ToolResult> {
        const fact = args.fact as string;
        const category = (args.category as string) || "general";

        const facts = loadFacts();

        // Avoid exact duplicates
        if (facts.some((f) => f.fact === fact)) {
          return { success: true, output: "This fact is already stored." };
        }

        facts.push({
          fact,
          category,
          createdAt: new Date().toISOString(),
        });

        saveFacts(facts);
        log?.info(`Stored fact [${category}]: ${fact}`);

        return {
          success: true,
          output: `Remembered: "${fact}" (${category}). Total facts: ${facts.length}.`,
        };
      },
    },

    {
      name: "memory_recall",
      description:
        "Recall stored facts about the user. Optionally filter by a search term. " +
        "Use this when you need to check what you already know about the user.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional search term to filter facts. Omit to retrieve all facts.",
          },
        },
        required: [],
      },
      timeout: 5_000,

      async execute(
        args: Record<string, unknown>,
        _toolCtx: ToolContext
      ): Promise<ToolResult> {
        const query = (args.query as string)?.toLowerCase();
        let facts = loadFacts();

        if (query) {
          facts = facts.filter(
            (f) =>
              f.fact.toLowerCase().includes(query) ||
              f.category.toLowerCase().includes(query)
          );
        }

        if (facts.length === 0) {
          return {
            success: true,
            output: query
              ? `No facts found matching "${query}".`
              : "No facts stored yet.",
          };
        }

        const lines = facts.map((f) => `- [${f.category}] ${f.fact}`);
        return {
          success: true,
          output: `Known facts (${facts.length}):\n${lines.join("\n")}`,
        };
      },
    },
  ],

  // ── Hooks ────────────────────────────────────────────────

  hooks: [
    {
      // Inject known facts into the system prompt at the start of each session
      event: "prompt:assemble" as const,
      priority: 60,
      handler: async (data: any) => {
        const facts = loadFacts();
        if (facts.length === 0) return data;

        return {
          ...data,
          systemPrompt: data.systemPrompt + formatFactsForPrompt(facts),
        };
      },
    },
  ],
};

export default memoryPlugin;

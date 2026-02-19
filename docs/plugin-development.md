# Plugin Development Guide

This guide covers everything you need to build plugins for Harness. Plugins extend the agent runtime with new tools, event hooks, LLM providers, and UI contributions — all without touching core code.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Plugin Interface](#plugin-interface)
- [Lifecycle](#lifecycle)
- [PluginContext](#plugincontext)
- [Tools](#tools)
- [Event Hooks](#event-hooks)
- [Event Reference](#event-reference)
- [Configuration](#configuration)
- [Persistent State](#persistent-state)
- [LLM Providers](#llm-providers)
- [Testing](#testing)
- [Publishing](#publishing)
- [Examples](#examples)

---

## Quick Start

The fastest way to create a plugin is to copy the built-in template:

```bash
# 1. Copy the template
cp -r plugins/template plugins/my-plugin

# 2. Update the package name
cd plugins/my-plugin
# Edit package.json: change name to "@harness/plugin-my-plugin" (or "harness-plugin-my-plugin" for npm)

# 3. Install dependencies and build
cd ../..
pnpm install
pnpm build

# 4. Enable it in your config
# Add to ~/.harness/config.yaml:
#   plugins:
#     enabled:
#       - "my-plugin"

# 5. Run Harness — your plugin is now active
npx harness "Hello"
```

The template at `plugins/template/src/index.ts` includes annotated examples of tools, hooks, and lifecycle methods.

---

## Plugin Interface

Every plugin implements the `HarnessPlugin` interface:

```typescript
import type {
  HarnessPlugin,
  PluginContext,
  ToolDefinition,
  LLMProvider,
  HookRegistration,
} from "@harness/core";

const myPlugin: HarnessPlugin = {
  // Required: unique identifier (used in config and resolution)
  id: "my-plugin",

  // Required: human-readable name
  name: "My Plugin",

  // Required: semver version string
  version: "1.0.0",

  // Required: called when the plugin is loaded
  async activate(ctx: PluginContext): Promise<void> { },

  // Required: called when the plugin is unloaded
  async deactivate(): Promise<void> { },

  // Optional: tools the LLM can invoke
  tools?: ToolDefinition[],

  // Optional: additional LLM providers
  providers?: LLMProvider[],

  // Optional: event hooks for observing or modifying behavior
  hooks?: HookRegistration[],

  // Optional: UI contributions (Electron desktop app)
  ui?: { views?: Array<{ id: string; title: string; component: string }> },
};

export default myPlugin;
```

---

## Lifecycle

### `activate(ctx: PluginContext)`

Called once when the plugin is loaded. Use this to:
- Read configuration
- Initialize connections, caches, or timers
- Store references to the context for later use

```typescript
let log: Logger;
let ctx: PluginContext;

async activate(pluginCtx: PluginContext) {
  ctx = pluginCtx;
  log = ctx.log;
  log.info("Plugin activated");
}
```

### `deactivate()`

Called when the agent shuts down or the plugin is unloaded. Clean up any resources:

```typescript
async deactivate() {
  // Close connections, clear timers, flush buffers
  log?.info("Plugin deactivated");
}
```

**Lifecycle order**: All plugins are activated in the order they appear in `config.yaml`. On shutdown, they are deactivated in reverse order.

---

## PluginContext

The `PluginContext` object is passed to `activate()` and provides access to the Harness runtime:

| Property | Type | Description |
|----------|------|-------------|
| `state` | `AgentState` | Read/write access to the agent's in-memory state |
| `store` | `PersistenceStore` | SQLite-backed persistence (sessions, memory, event logs) |
| `bus` | `EventBus` | Emit or listen to typed events |
| `config` | `PluginConfig` | Plugin-specific configuration key-value store |
| `log` | `Logger` | Scoped logger (`debug`, `info`, `warn`, `error`) |

### AgentState

```typescript
// Read state
const model = ctx.state.get("config").model;           // "gpt-4o"
const status = ctx.state.get("status");                // "running"
const messages = ctx.state.get("messages");             // Message[]
const iteration = ctx.state.get("iteration");           // number

// Write state
ctx.state.set("pluginData", {
  ...ctx.state.get("pluginData"),
  "my-plugin": { counter: 0 },
});

// Full state snapshot (read-only copy)
const snapshot = ctx.state.snapshot();
```

**Key fields**: `sessionId`, `taskId`, `status`, `iteration`, `messages`, `config`, `activeSoul`, `activeSkills`, `availableTools`, `startedAt`, `tokenUsage`, `pluginData`.

### Logger

Messages are prefixed with `[plugin:<id>]`:

```typescript
log.debug("Detailed info");   // Only shown in verbose mode
log.info("Normal info");
log.warn("Something unexpected");
log.error("Something broke");
```

---

## Tools

Plugins can register tools that the LLM can call during the agent loop. Tools are declared in the `tools` array and registered automatically at load time.

```typescript
import type { ToolDefinition, ToolContext, ToolResult } from "@harness/core";

const myTool: ToolDefinition = {
  name: "my_tool",
  description: "A clear description of what the tool does and when to use it.",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The input to process.",
      },
      verbose: {
        type: "boolean",
        description: "Whether to include detailed output.",
      },
    },
    required: ["input"],
  },

  // Optional: execution timeout in ms (default: 30000)
  timeout: 10_000,

  // Optional: if true, the human-review plugin will gate this tool
  requiresConfirmation: false,

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const input = args.input as string;
    const verbose = (args.verbose as boolean) ?? false;

    try {
      const result = processInput(input, verbose);

      return {
        success: true,
        output: result,
        // Optional: list of file paths or URIs for the LLM to reference
        artifacts: [],
      };
    } catch (err) {
      return {
        success: false,
        output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
```

### ToolContext

The `ctx` passed to `execute()` provides:

| Property | Type | Description |
|----------|------|-------------|
| `workdir` | `string` | The agent's working directory |
| `state` | `AgentState` | Current agent state |
| `emit` | `(event, data) => void` | Emit events to the bus |

### Tool naming conventions

- Use `snake_case` for tool names
- Prefix with your plugin name to avoid collisions: `myplugin_action`
- Keep descriptions clear and specific — the LLM uses them to decide when to call the tool

### Parameter schemas

Tool parameters use [JSON Schema](https://json-schema.org/) format. Supported types: `string`, `number`, `boolean`, `object`, `array`. The schema is passed directly to the LLM provider.

---

## Event Hooks

Hooks let your plugin observe or modify the flow of events through the system. Every action in Harness (LLM calls, tool executions, state changes) emits a typed event.

```typescript
hooks: [
  {
    event: "tool:request",       // Which event to listen to
    priority: 50,                // Lower = runs earlier (default: 100)
    handler: async (data) => {
      // For modifiable events, return data to pass through,
      // modified data to transform, or { abort: true } to cancel.
      return data;
    },
  },
]
```

### Hook priorities

Hooks for the same event run in priority order (lowest first):

| Priority | Convention |
|----------|-----------|
| 1-10 | Security gates (approval, blocking) |
| 11-50 | Transform / enrich |
| 51-99 | Business logic |
| 100 | Default — observation / logging |

### Modifiable vs. non-modifiable events

**Modifiable events** allow hooks to transform the payload or abort the action:

```typescript
// Transform: return modified data
handler: async (data) => {
  return { ...data, task: data.task + " (augmented)" };
}

// Abort: return { abort: true }
handler: async (data) => {
  if (isBadRequest(data)) return { abort: true };
  return data;
}
```

**Non-modifiable events** are fire-and-forget. The return value is ignored:

```typescript
// Observe only
handler: async (data) => {
  log.info(`Agent finished: ${data.result}`);
}
```

### Global listener

To observe all events without modifying them:

```typescript
async activate(ctx: PluginContext) {
  ctx.bus.onAll((event, data) => {
    log.debug(`[${event}]`, JSON.stringify(data).slice(0, 200));
  });
}
```

---

## Event Reference

### Agent events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `agent:start` | `{ task, soul, skills, config }` | Yes | Task begins |
| `agent:end` | `{ task, result, tokenUsage }` | No | Task completes |
| `agent:error` | `{ error, iteration }` | No | Unrecoverable error |

### Loop events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `loop:iteration_start` | `{ iteration, state }` | Yes | Before each iteration |
| `loop:iteration_end` | `{ iteration, state }` | No | After each iteration |

### Prompt events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `prompt:assemble` | `{ systemPrompt, messages, tools }` | Yes | Before sending to LLM |

### LLM events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `llm:request` | `{ provider, model, messages }` | Yes | Before LLM API call |
| `llm:chunk` | `{ chunk }` | No | Each streaming chunk |
| `llm:response` | `{ response, usage }` | No | Full response received |
| `llm:error` | `{ error, retryCount, retry? }` | Yes | LLM call failed |

### Tool events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `tool:request` | `{ name, args, abort? }` | Yes | Tool call requested by LLM |
| `tool:start` | `{ name, args }` | No | Tool execution begins |
| `tool:result` | `{ name, result, duration }` | Yes | Tool returned |
| `tool:error` | `{ name, error }` | No | Tool threw an error |
| `tool:register` | `{ tool: { name, description } }` | No | Tool added to registry |
| `tool:unregister` | `{ name }` | No | Tool removed from registry |

### State events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `state:change` | `{ path, oldValue, newValue }` | No | State mutated |

### User events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `user:input` | `{ text }` | Yes | User sends input |
| `user:interrupt` | `{}` | No | User sends interrupt signal |
| `user:confirm` | `{ message }` | No | Confirmation requested |

### Skill events

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `skill:activate` | `{ skillId }` | No | Skill activated |
| `skill:deactivate` | `{ skillId }` | No | Skill deactivated |

### Feedback events (human-in-the-loop)

| Event | Payload | Modifiable | When |
|-------|---------|------------|------|
| `feedback:request` | `{ request, adapterId }` | Yes | Feedback requested from human |
| `feedback:response` | `{ request, response, adapterId, durationMs }` | No | Human responded |
| `feedback:timeout` | `{ request, adapterId, timeoutMs }` | No | Feedback request timed out |
| `feedback:cancel` | `{ requestId, reason }` | No | Feedback request cancelled |

---

## Configuration

Plugin configuration is managed through `PluginConfig`, a simple key-value store:

```typescript
async activate(ctx: PluginContext) {
  // Read with default values
  const maxRetries = ctx.config.get("maxRetries", 3);
  const apiUrl = ctx.config.get("apiUrl", "https://api.example.com");

  // Write configuration at runtime
  ctx.config.set("lastRun", Date.now());
}
```

Users set plugin configuration in `~/.harness/config.yaml`:

```yaml
plugins:
  enabled:
    - "my-plugin"

  # Plugin-specific config (planned — currently passed programmatically)
  # my-plugin:
  #   maxRetries: 5
  #   apiUrl: "https://custom.api.com"
```

For now, plugin configuration is typically set programmatically when loading inline plugins:

```typescript
import { createAgent, PluginLoader, createPluginConfig } from "@harness/core";

const config = createPluginConfig({
  maxRetries: 5,
  apiUrl: "https://custom.api.com",
});
```

---

## Persistent State

Plugins can store data that survives across sessions using the `PersistenceStore`:

```typescript
async activate(ctx: PluginContext) {
  const store = ctx.store;
  const scope = "plugin:my-plugin";

  // Write
  store.setMemory("last-activated", new Date().toISOString(), scope);
  store.setMemory("settings", { theme: "dark", limit: 50 }, scope);

  // Read
  const lastActivated = store.getMemory("last-activated", scope) as string;
  const settings = store.getMemory("settings", scope) as { theme: string; limit: number };

  // Delete
  store.deleteMemory("old-key", scope);
}
```

**Scope conventions**:
- `"global"` — shared across all plugins (use carefully)
- `"plugin:<id>"` — scoped to your plugin (recommended)
- `"soul:<id>"` — scoped to a soul document

For per-session data that doesn't need persistence, use `AgentState.pluginData`:

```typescript
ctx.state.set("pluginData", {
  ...ctx.state.get("pluginData"),
  "my-plugin": { requestCount: 0 },
});
```

---

## LLM Providers

Plugins can register additional LLM providers. Each provider implements a thin adapter interface:

```typescript
import type { LLMProvider, ChatRequest, ChatChunk, Message } from "@harness/core";

const myProvider: LLMProvider = {
  id: "my-provider",
  name: "My LLM Provider",

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    // request.messages — conversation history
    // request.tools — available tool schemas
    // request.temperature, request.maxTokens — generation params

    // Yield streaming chunks:
    yield { type: "text", text: "Hello" };
    yield { type: "text", text: " world" };

    // Or yield tool calls:
    // yield { type: "tool_call", id: "call_1", name: "shell", args: { command: "ls" } };

    // Final chunk with usage stats:
    yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
  },
};
```

Register providers in the `providers` array of your plugin:

```typescript
const myPlugin: HarnessPlugin = {
  // ...
  providers: [myProvider],
};
```

Users can then select your provider via CLI or config:

```bash
npx harness --provider my-provider "Hello"
```

---

## Testing

### Unit testing tools

Test tool implementations directly without the full agent loop:

```typescript
import { describe, it, assert } from "node:test";
import myPlugin from "../src/index.js";

describe("my-plugin tools", () => {
  it("my_tool returns expected output", async () => {
    const tool = myPlugin.tools?.find(t => t.name === "my_tool");
    assert(tool, "Tool should exist");

    const result = await tool.execute(
      { input: "test" },
      { workdir: "/tmp", state: {} as any, emit: () => {} }
    );

    assert.strictEqual(result.success, true);
    assert(result.output.includes("test"));
  });
});
```

### Testing hooks

Create a mock `EventBus` to test hook handlers:

```typescript
import { EventBus } from "@harness/core";

it("hook modifies prompt", async () => {
  const hook = myPlugin.hooks?.find(h => h.event === "prompt:assemble");
  assert(hook, "Hook should exist");

  const input = {
    systemPrompt: "You are helpful.",
    messages: [],
    tools: [],
  };

  const result = await hook.handler(input);
  assert(result?.systemPrompt?.includes("additional context"));
});
```

### Integration testing

Spin up a full agent to test end-to-end:

```typescript
import { createAgent } from "@harness/core";

it("plugin integrates with agent", async () => {
  const agent = await createAgent({
    defaults: { provider: "ollama" },
    plugins: { enabled: ["./plugins/my-plugin"] },
  });

  // Verify tools are registered
  assert(agent.tools.has("my_tool"));

  // Verify hooks are wired
  assert(agent.bus.listenerCount("tool:request") > 0);
});
```

---

## Publishing

### As a workspace plugin (local)

Place your plugin in the `plugins/` directory. It's automatically part of the pnpm workspace:

```
harness/
└── plugins/
    └── my-plugin/
        ├── package.json    # name: "@harness/plugin-my-plugin"
        ├── tsconfig.json
        └── src/
            └── index.ts
```

Enable with the directory name:

```yaml
plugins:
  enabled:
    - "my-plugin"
```

### As an npm package

1. Name your package with the `harness-plugin-` prefix: `harness-plugin-my-plugin`
2. Make sure the default export is a `HarnessPlugin` object
3. Publish to npm: `npm publish`

Users install and enable it:

```bash
npm install harness-plugin-my-plugin
```

```yaml
plugins:
  enabled:
    - "harness-plugin-my-plugin"
```

### Plugin resolution order

When Harness encounters a plugin name in config, it resolves in this order:

1. **Explicit paths** — `./plugins/my-plugin` or `/absolute/path`
2. **npm packages** — `require.resolve("harness-plugin-my-plugin")`
3. **plugins/ directory scan** — matches by directory name, `harness-<dir>` convention, or `package.json` name

---

## Examples

### Minimal logger plugin

```typescript
const loggerPlugin: HarnessPlugin = {
  id: "simple-logger",
  name: "Simple Logger",
  version: "1.0.0",
  async activate(ctx) { ctx.log.info("Logger active"); },
  async deactivate() {},
  hooks: [
    {
      event: "llm:response",
      handler: async (data) => {
        console.log(`Tokens: ${data.usage.inputTokens}in / ${data.usage.outputTokens}out`);
      },
    },
  ],
};
```

### Tool-only plugin

```typescript
const calculatorPlugin: HarnessPlugin = {
  id: "calculator",
  name: "Calculator",
  version: "1.0.0",
  async activate() {},
  async deactivate() {},
  tools: [
    {
      name: "calculate",
      description: "Evaluate a mathematical expression.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Math expression (e.g. '2 + 2 * 3')" },
        },
        required: ["expression"],
      },
      async execute(args) {
        try {
          // WARNING: In production, use a safe math parser, not eval
          const result = Function(`"use strict"; return (${args.expression})`)();
          return { success: true, output: String(result) };
        } catch (err) {
          return { success: false, output: `Invalid expression: ${err}` };
        }
      },
    },
  ],
};
```

### Prompt injection plugin

```typescript
const contextPlugin: HarnessPlugin = {
  id: "context-injector",
  name: "Context Injector",
  version: "1.0.0",
  async activate() {},
  async deactivate() {},
  hooks: [
    {
      event: "prompt:assemble",
      priority: 50,
      handler: async (data) => {
        const now = new Date().toISOString();
        return {
          ...data,
          systemPrompt: data.systemPrompt + `\n\nCurrent time: ${now}`,
        };
      },
    },
  ],
};
```

### Cost tracking plugin

```typescript
let totalCost = 0;

const costTracker: HarnessPlugin = {
  id: "cost-tracker",
  name: "Cost Tracker",
  version: "1.0.0",
  async activate(ctx) {
    totalCost = 0;
    ctx.log.info("Cost tracking started");
  },
  async deactivate() {},
  hooks: [
    {
      event: "llm:response",
      handler: async (data) => {
        // Rough cost estimate (adjust rates per model)
        const inputCost = data.usage.inputTokens * 0.000003;
        const outputCost = data.usage.outputTokens * 0.000015;
        totalCost += inputCost + outputCost;
      },
    },
    {
      event: "agent:end",
      handler: async () => {
        console.log(`Total estimated cost: $${totalCost.toFixed(6)}`);
      },
    },
  ],
};
```

---

## Checklist

When building a plugin, make sure you:

- [ ] Implement both `activate()` and `deactivate()` (even if deactivate is empty)
- [ ] Clean up resources (timers, connections) in `deactivate()`
- [ ] Use descriptive tool names with `snake_case`
- [ ] Write clear tool descriptions — the LLM decides when to use tools based on these
- [ ] Handle errors in tool `execute()` — return `{ success: false, output: "..." }` instead of throwing
- [ ] Handle errors in hook handlers — uncaught exceptions are logged but don't crash the bus
- [ ] Use appropriate hook priorities (security: 1-10, transforms: 11-50, logic: 51-99, logging: 100)
- [ ] Scope persistent data with `"plugin:<id>"` to avoid collisions
- [ ] Test tools and hooks independently before integration testing
- [ ] Export the plugin as the default export from your entry point

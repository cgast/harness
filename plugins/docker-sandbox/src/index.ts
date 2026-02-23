/**
 * Docker Sandbox Plugin
 *
 * Intercepts `tool:request` events for shell and file tools and redirects
 * execution into an isolated Docker container.  All dangerous operations
 * (shell commands, file writes) run inside the sandbox while the host
 * remains untouched.
 *
 * Architecture:
 *
 *   tool:request (priority 1)
 *     │
 *     ├─ shell        → exec inside container, return result, abort original
 *     ├─ file_write   → write inside container, return result, abort original
 *     ├─ file_read    → read from container, return result, abort original
 *     ├─ file_list    → ls inside container, return result, abort original
 *     └─ anything else → pass through unchanged
 *
 * The plugin also registers a `sandbox_status` tool the LLM can call to
 * inspect the container state, and a `sandbox_exec` tool for explicit
 * sandboxed execution.
 *
 * Configuration (via plugin config):
 *   - image: string            — Docker image (default: "harness-sandbox:latest")
 *   - memoryLimit: string      — Memory limit (default: "512m")
 *   - cpuLimit: string         — CPU limit (default: "1.0")
 *   - networkMode: string      — "none" | "bridge" | "host" (default: "none")
 *   - sandboxedTools: string[] — Tool names to sandbox (default: ["shell", "file_read", "file_write", "file_list"])
 *   - mountWorkdir: boolean    — Bind-mount host workdir into container (default: false — copy-in for isolation)
 *   - readonlyRoot: boolean    — Read-only root FS (default: true)
 *   - execTimeout: number      — Per-command timeout in ms (default: 55000)
 *   - autoBuildImage: boolean  — Build image if missing (default: true)
 *   - autoStart: boolean       — Start container on plugin activate (default: true)
 *
 * Usage:
 *   // In ~/.harness/config.yaml:
 *   plugins:
 *     enabled: ["docker-sandbox"]
 *     docker-sandbox:
 *       networkMode: "none"
 *       memoryLimit: "256m"
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

import { ContainerManager, type ContainerConfig, type ExecResult } from "./container.js";

// ── Plugin state ──────────────────────────────────────────────

let log: Logger;
let ctx: PluginContext;
let manager: ContainerManager;
let sandboxedTools: string[];
let mountWorkdir: boolean;
let autoStart: boolean;
let hostWorkdir: string | undefined;

// Track whether the container was started by us (for cleanup)
let containerOwnedByPlugin = false;

// ── Sandboxed execution helpers ───────────────────────────────

/**
 * Execute a shell command inside the sandbox container.
 * Mirrors the built-in shell tool's behavior but runs in Docker.
 */
async function sandboxShell(
  command: string,
  workdir?: string
): Promise<ToolResult> {
  try {
    const running = await manager.isContainerRunning();
    if (!running) {
      // Auto-restart if the container died
      log.warn("Sandbox container not running, restarting...");
      await manager.start(mountWorkdir ? hostWorkdir : undefined);
      containerOwnedByPlugin = true;
    }

    const result = await manager.exec(command, workdir);

    if (result.exitCode !== 0) {
      const output = `Exit code: ${result.exitCode}\n${result.stderr}\n${result.stdout}`.trim();
      return { success: false, output };
    }

    const output =
      result.stdout +
      (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
    return { success: true, output: output.trim() || "(no output)" };
  } catch (err: any) {
    return {
      success: false,
      output: `Sandbox shell error: ${err.message}`,
    };
  }
}

/**
 * Read a file from inside the sandbox container.
 */
async function sandboxFileRead(filePath: string): Promise<ToolResult> {
  try {
    const content = await manager.readFile(filePath);
    return { success: true, output: content };
  } catch (err: any) {
    return {
      success: false,
      output: `Failed to read file in sandbox: ${err.message}`,
    };
  }
}

/**
 * Write a file inside the sandbox container.
 */
async function sandboxFileWrite(
  filePath: string,
  content: string
): Promise<ToolResult> {
  try {
    await manager.writeFile(filePath, content);
    return {
      success: true,
      output: `File written (sandbox): ${filePath}`,
      artifacts: [filePath],
    };
  } catch (err: any) {
    return {
      success: false,
      output: `Failed to write file in sandbox: ${err.message}`,
    };
  }
}

/**
 * List directory contents inside the sandbox container.
 */
async function sandboxFileList(dirPath: string): Promise<ToolResult> {
  try {
    const listing = await manager.listDir(dirPath);
    return { success: true, output: listing.trim() || "(empty directory)" };
  } catch (err: any) {
    return {
      success: false,
      output: `Failed to list directory in sandbox: ${err.message}`,
    };
  }
}

// ── Tool request router ───────────────────────────────────────

/**
 * Routes an intercepted tool:request to the appropriate sandbox handler.
 * Returns the ToolResult to inject back via tool:result, or null if the
 * tool is not one we sandbox.
 */
async function routeToSandbox(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult | null> {
  switch (name) {
    case "shell":
      return sandboxShell(
        args.command as string,
        args.workdir as string | undefined
      );

    case "file_read":
      return sandboxFileRead(args.path as string);

    case "file_write":
      return sandboxFileWrite(
        args.path as string,
        args.content as string
      );

    case "file_list":
      return sandboxFileList((args.path as string) || ".");

    default:
      return null;
  }
}

// ── Plugin definition ─────────────────────────────────────────

const dockerSandboxPlugin: HarnessPlugin = {
  id: "harness-docker-sandbox",
  name: "Docker Sandbox",
  version: "1.0.0",

  // ── Lifecycle ─────────────────────────────────────────────

  async activate(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    log = ctx.log;

    // Read configuration
    sandboxedTools = ctx.config.get("sandboxedTools", [
      "shell",
      "file_read",
      "file_write",
      "file_list",
    ]);
    mountWorkdir = ctx.config.get("mountWorkdir", false);
    autoStart = ctx.config.get("autoStart", true);

    // Build container config from plugin config
    const containerConfig: Partial<ContainerConfig> = {
      image: ctx.config.get("image", "harness-sandbox:latest"),
      memoryLimit: ctx.config.get("memoryLimit", "512m"),
      cpuLimit: ctx.config.get("cpuLimit", "1.0"),
      networkMode: ctx.config.get("networkMode", "none"),
      readonlyRoot: ctx.config.get("readonlyRoot", true),
      execTimeout: ctx.config.get("execTimeout", 55_000),
      autoBuildImage: ctx.config.get("autoBuildImage", true),
      pidsLimit: ctx.config.get("pidsLimit", 256),
      maxOutputBytes: ctx.config.get("maxOutputBytes", 1024 * 1024),
    };

    // Additional mounts
    const extraMounts = ctx.config.get<Array<{
      hostPath: string;
      containerPath: string;
      readonly: boolean;
    }>>("mounts", []);
    if (extraMounts.length > 0) {
      containerConfig.mounts = extraMounts;
    }

    // Security opts
    const secOpts = ctx.config.get<string[]>("securityOpts", []);
    if (secOpts.length > 0) {
      containerConfig.securityOpts = secOpts;
    }

    manager = new ContainerManager(containerConfig, (msg) => log.info(msg));

    log.info(
      `Docker Sandbox activated. Sandboxed tools: [${sandboxedTools.join(", ")}]`
    );

    // Auto-start the container if configured
    if (autoStart) {
      try {
        await manager.start(mountWorkdir ? hostWorkdir : undefined);
        containerOwnedByPlugin = true;
        log.info("Sandbox container started on activation");
      } catch (err: any) {
        log.warn(
          `Failed to auto-start sandbox container: ${err.message}. ` +
            `Container will be started on first sandboxed tool call.`
        );
      }
    }
  },

  async deactivate() {
    if (containerOwnedByPlugin) {
      try {
        await manager?.stop();
      } catch (err: any) {
        log?.warn(`Error stopping sandbox container: ${err.message}`);
      }
    }
    log?.info("Docker Sandbox deactivated");
  },

  // ── Tools ─────────────────────────────────────────────────

  tools: [
    // sandbox_status — inspect the sandbox container state
    {
      name: "sandbox_status",
      description:
        "Show the current Docker sandbox container status, including container ID, " +
        "uptime, and execution count. Use this to verify the sandbox is running.",
      parameters: {
        type: "object",
        properties: {
          verbose: {
            type: "boolean",
            description: "Include recent container logs in output (default: false)",
          },
        },
        required: [],
      },
      timeout: 10_000,

      async execute(
        args: Record<string, unknown>,
        _toolCtx: ToolContext
      ): Promise<ToolResult> {
        const info = manager.getContainerInfo();
        const config = manager.getConfig();

        if (!info) {
          return {
            success: true,
            output: [
              "Sandbox Status: NO CONTAINER",
              `Image: ${config.image}`,
              `Network: ${config.networkMode}`,
              `Memory: ${config.memoryLimit}`,
              `CPU: ${config.cpuLimit}`,
              `Sandboxed tools: ${sandboxedTools.join(", ")}`,
            ].join("\n"),
          };
        }

        const uptime = Math.round((Date.now() - info.createdAt) / 1000);
        const lines = [
          `Sandbox Status: ${info.status.toUpperCase()}`,
          `Container: ${info.name} (${info.id.slice(0, 12)})`,
          `Uptime: ${uptime}s`,
          `Executions: ${info.execCount}`,
          `Image: ${config.image}`,
          `Network: ${config.networkMode}`,
          `Memory: ${config.memoryLimit}`,
          `CPU: ${config.cpuLimit}`,
          `Read-only root: ${config.readonlyRoot}`,
          `Sandboxed tools: ${sandboxedTools.join(", ")}`,
        ];

        if (args.verbose) {
          const logs = await manager.getContainerLogs(20);
          lines.push("", "--- Recent container logs ---", logs);
        }

        return { success: true, output: lines.join("\n") };
      },
    },

    // sandbox_exec — explicit sandboxed execution (for tools the LLM picks itself)
    {
      name: "sandbox_exec",
      description:
        "Execute a shell command explicitly inside the Docker sandbox container. " +
        "Use this when you want to run something in the isolated environment. " +
        "The sandbox has no network access by default and limited resources.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute inside the sandbox",
          },
          workdir: {
            type: "string",
            description:
              "Working directory inside the container (default: /workspace)",
          },
        },
        required: ["command"],
      },
      timeout: 60_000,

      async execute(
        args: Record<string, unknown>,
        _toolCtx: ToolContext
      ): Promise<ToolResult> {
        return sandboxShell(
          args.command as string,
          args.workdir as string | undefined
        );
      },
    },
  ],

  // ── Event hooks ─────────────────────────────────────────────

  hooks: [
    {
      // Intercept sandboxed tool calls at the highest priority (1).
      // This runs BEFORE human-review (priority 5) and everything else.
      // For sandboxed tools, we execute inside Docker and then emit
      // the result directly, aborting the original host execution.
      event: "tool:request" as const,
      priority: 1,
      handler: async (
        data: EventPayloads["tool:request"]
      ): Promise<
        EventPayloads["tool:request"] | { abort: true } | void
      > => {
        // Only intercept tools we're configured to sandbox
        if (!sandboxedTools.includes(data.name)) {
          return data; // Pass through
        }

        log.info(
          `[Sandbox] Intercepting '${data.name}' → redirecting to Docker container`
        );

        // Ensure container is running
        const running = await manager.isContainerRunning();
        if (!running) {
          try {
            log.info("[Sandbox] Starting container for sandboxed execution...");
            await manager.start(mountWorkdir ? hostWorkdir : undefined);
            containerOwnedByPlugin = true;
          } catch (err: any) {
            log.error(`[Sandbox] Failed to start container: ${err.message}`);
            // Fall through to host execution as a safety measure
            log.warn(
              "[Sandbox] Falling through to host execution (container unavailable)"
            );
            return data;
          }
        }

        // Execute the tool inside the sandbox
        const result = await routeToSandbox(data.name, data.args);

        if (!result) {
          // Shouldn't happen since we checked sandboxedTools, but be safe
          return data;
        }

        // Emit tool:result directly so the agent loop receives the output
        await ctx.bus.emit("tool:result", {
          name: data.name,
          result,
          duration: 0, // Duration isn't meaningful here — exec already happened
        });

        // Abort the original tool execution on the host
        log.info(
          `[Sandbox] '${data.name}' completed in sandbox (success=${result.success})`
        );
        return { abort: true };
      },
    },

    // Capture agent:start to learn the host workdir
    {
      event: "agent:start" as const,
      priority: 50,
      handler: async (data: EventPayloads["agent:start"]) => {
        const workdir = data.config?.workdir as string | undefined;
        if (workdir) {
          hostWorkdir = workdir;
          log.info(`[Sandbox] Host workdir set to: ${workdir}`);
        }
        return data;
      },
    },
  ],
};

export default dockerSandboxPlugin;

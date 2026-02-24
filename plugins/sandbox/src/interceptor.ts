/**
 * Tool interceptor - hooks into tool:request events to redirect
 * shell, file_read, file_write, and file_list execution into the
 * Docker sandbox container.
 */

import type { EventPayloads, AnyHookRegistration, Logger } from "@harness/core";
import type { DockerClient } from "./docker.js";
import { SANDBOXED_TOOLS, DELIVERABLES_DIR } from "./types.js";

/**
 * Create event hooks that intercept tool requests and redirect them
 * into the Docker sandbox container.
 *
 * The interceptor works by:
 * 1. Catching `tool:request` for sandboxed tools (priority 5, before most hooks)
 * 2. Executing the command inside Docker
 * 3. Injecting the result back via a modified `tool:result` event
 *
 * Since the event bus `tool:request` hook can return `{ abort: true }` to
 * prevent the default (host) execution, and we need to supply a result,
 * we intercept at both `tool:request` (to abort host execution and stash
 * the sandboxed result) and `tool:result` (to inject the sandboxed result).
 */
export function createInterceptorHooks(
  docker: DockerClient,
  log: Logger
): AnyHookRegistration[] {
  // Stash for sandbox results so we can inject them into tool:result
  let pendingSandboxResult: { success: boolean; output: string; artifacts?: string[] } | null = null;

  return [
    // ── Intercept tool:request to run in sandbox ──────────────
    {
      event: "tool:request" as const,
      priority: 5, // Run early, after workspace guard (priority 1)
      handler: async (data: EventPayloads["tool:request"]) => {
        if (!(SANDBOXED_TOOLS as readonly string[]).includes(data.name)) {
          return data; // Not a sandboxed tool, pass through
        }

        log.debug(`Intercepting ${data.name} for sandbox execution`);

        try {
          const result = await executeSandboxed(data.name, data.args, docker, log);
          pendingSandboxResult = result;

          // Return modified data with a flag so our tool:result hook can
          // inject the sandbox result. We set args.__sandboxHandled so the
          // executor still runs, but we also modify args to be a no-op.
          return {
            ...data,
            args: {
              ...data.args,
              __sandboxHandled: true,
              __sandboxResult: result,
            },
          };
        } catch (err: any) {
          log.error(`Sandbox execution failed for ${data.name}: ${err.message}`);
          pendingSandboxResult = {
            success: false,
            output: `Sandbox execution failed: ${err.message}`,
          };
          return {
            ...data,
            args: {
              ...data.args,
              __sandboxHandled: true,
              __sandboxResult: pendingSandboxResult,
            },
          };
        }
      },
    },

    // ── Intercept tool:result to inject sandbox output ────────
    {
      event: "tool:result" as const,
      priority: 5,
      handler: async (data: EventPayloads["tool:result"]) => {
        if (pendingSandboxResult && (SANDBOXED_TOOLS as readonly string[]).includes(data.name)) {
          const sandboxedResult = pendingSandboxResult;
          pendingSandboxResult = null;

          log.debug(`Injecting sandbox result for ${data.name}`);

          return {
            ...data,
            result: sandboxedResult,
          };
        }
        return data;
      },
    },

    // ── Inject sandbox prompt context via prompt:assemble ─────
    {
      event: "prompt:assemble" as const,
      priority: 90,
      handler: async (data: EventPayloads["prompt:assemble"]) => {
        return {
          ...data,
          systemPrompt:
            data.systemPrompt +
            "\n\n" +
            SANDBOX_PROMPT_INJECTION,
        };
      },
    },
  ];
}

// ── Tool-specific sandbox execution ────────────────────────────

async function executeSandboxed(
  toolName: string,
  args: Record<string, unknown>,
  docker: DockerClient,
  log: Logger
): Promise<{ success: boolean; output: string; artifacts?: string[] }> {
  switch (toolName) {
    case "shell":
      return executeSandboxedShell(args, docker, log);
    case "file_read":
      return executeSandboxedFileRead(args, docker, log);
    case "file_write":
      return executeSandboxedFileWrite(args, docker, log);
    case "file_list":
      return executeSandboxedFileList(args, docker, log);
    default:
      return { success: false, output: `Unknown sandboxed tool: ${toolName}` };
  }
}

async function executeSandboxedShell(
  args: Record<string, unknown>,
  docker: DockerClient,
  log: Logger
): Promise<{ success: boolean; output: string }> {
  const command = args.command as string;
  const workdir = (args.workdir as string) || "/workspace";

  log.info(`[sandbox] shell: ${command.slice(0, 100)}${command.length > 100 ? "..." : ""}`);

  const result = await docker.execute(command, { workdir });

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Exit code: ${result.exitCode}\n${result.stderr || ""}\n${result.stdout}`.trim(),
    };
  }

  const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
  return {
    success: true,
    output: output.trim() || "(no output)",
  };
}

async function executeSandboxedFileRead(
  args: Record<string, unknown>,
  docker: DockerClient,
  log: Logger
): Promise<{ success: boolean; output: string }> {
  const filePath = args.path as string;
  // Resolve relative paths to /workspace
  const resolvedPath = filePath.startsWith("/") ? filePath : `/workspace/${filePath}`;

  log.info(`[sandbox] file_read: ${resolvedPath}`);

  const result = await docker.readFile(resolvedPath);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to read file: ${result.stderr || "file not found"}`,
    };
  }

  return { success: true, output: result.stdout };
}

async function executeSandboxedFileWrite(
  args: Record<string, unknown>,
  docker: DockerClient,
  log: Logger
): Promise<{ success: boolean; output: string; artifacts?: string[] }> {
  const filePath = args.path as string;
  const content = args.content as string;
  // Resolve relative paths to /workspace
  const resolvedPath = filePath.startsWith("/") ? filePath : `/workspace/${filePath}`;

  log.info(`[sandbox] file_write: ${resolvedPath}`);

  const result = await docker.writeFile(resolvedPath, content);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to write file: ${result.stderr || result.stdout}`,
    };
  }

  // Check if the file is in the deliverables directory
  const artifacts: string[] = [];
  if (resolvedPath.includes(`/${DELIVERABLES_DIR}/`)) {
    artifacts.push(resolvedPath);
  }

  return {
    success: true,
    output: `File written: ${resolvedPath}`,
    artifacts,
  };
}

async function executeSandboxedFileList(
  args: Record<string, unknown>,
  docker: DockerClient,
  log: Logger
): Promise<{ success: boolean; output: string }> {
  const dirPath = (args.path as string) || ".";
  // Resolve relative paths to /workspace
  const resolvedPath = dirPath.startsWith("/") ? dirPath : `/workspace/${dirPath}`;

  log.info(`[sandbox] file_list: ${resolvedPath}`);

  const result = await docker.listFiles(resolvedPath);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to list directory: ${result.stderr || "directory not found"}`,
    };
  }

  return {
    success: true,
    output: result.stdout.trim() || "(empty directory)",
  };
}

// ── Prompt injection for sandbox awareness ─────────────────────

const SANDBOX_PROMPT_INJECTION = `\
[Sandbox Environment]
Your commands run inside an isolated Docker container with:
- Python 3.12 (with pandas, openpyxl, python-pptx, Pillow, matplotlib, requests)
- Node.js 20 (with npm available)
- LibreOffice headless (convert documents with: libreoffice --headless --convert-to pdf document.docx)
- curl, jq, git

Your working directory is /workspace (the user's project folder).

Place final deliverables (generated files the user should receive) in /workspace/${DELIVERABLES_DIR}/
Use /tmp for intermediate/scratch files.

Network access is disabled by default. The http_fetch tool handles external requests.
You cannot install system packages (no sudo). You can pip install or npm install as needed.`;

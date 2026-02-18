/**
 * Built-in shell tool - executes shell commands.
 */

import { exec } from "node:child_process";
import type { ToolDefinition } from "../registry.js";

export const shellTool: ToolDefinition = {
  name: "shell",
  description: "Execute a shell command and return its output. Use this for running system commands, scripts, and CLI tools.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      workdir: {
        type: "string",
        description: "Working directory for the command (optional, defaults to agent workdir)",
      },
    },
    required: ["command"],
  },
  timeout: 60_000, // 60 seconds for shell commands
  requiresConfirmation: true,

  async execute(args, ctx) {
    const command = args.command as string;
    const workdir = (args.workdir as string) || ctx.workdir;

    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: workdir,
          timeout: 55_000, // slightly less than tool timeout
          maxBuffer: 1024 * 1024, // 1MB
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              success: false,
              output: `Exit code: ${error.code ?? 1}\n${stderr || error.message}\n${stdout}`.trim(),
            });
          } else {
            const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
            resolve({
              success: true,
              output: output.trim() || "(no output)",
            });
          }
        }
      );
    });
  },
};

/**
 * Built-in file operations tool - read, write, list files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "../registry.js";

export const fileReadTool: ToolDefinition = {
  name: "file_read",
  description:
    "Read the contents of a file. Returns the file contents as a string.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (relative to workdir or absolute)",
      },
    },
    required: ["path"],
  },

  async execute(args, ctx) {
    const filePath = path.resolve(ctx.workdir, args.path as string);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: `Failed to read file: ${err.message}` };
    }
  },
};

export const fileWriteTool: ToolDefinition = {
  name: "file_write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write (relative to workdir or absolute)",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
  requiresConfirmation: true,

  async execute(args, ctx) {
    const filePath = path.resolve(ctx.workdir, args.path as string);
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, args.content as string, "utf-8");
      return {
        success: true,
        output: `File written: ${filePath}`,
        artifacts: [filePath],
      };
    } catch (err: any) {
      return { success: false, output: `Failed to write file: ${err.message}` };
    }
  },
};

export const fileListTool: ToolDefinition = {
  name: "file_list",
  description:
    "List files and directories in a given path. Returns names with type indicators.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory path to list (relative to workdir or absolute). Defaults to workdir.",
      },
    },
    required: [],
  },

  async execute(args, ctx) {
    const dirPath = path.resolve(ctx.workdir, (args.path as string) || ".");
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const lines = entries.map((e) => {
        const suffix = e.isDirectory() ? "/" : "";
        return `${e.name}${suffix}`;
      });
      return {
        success: true,
        output: lines.join("\n") || "(empty directory)",
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to list directory: ${err.message}`,
      };
    }
  },
};

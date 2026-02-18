/**
 * Skill resolver - determines which skills should be active for a given task
 * and registers their tools.
 */

import { exec } from "node:child_process";
import type { SkillDocument, SkillToolProvide } from "./loader.js";
import type { ToolDefinition } from "../tools/registry.js";

/**
 * Resolve which skills should be active based on the task and skill activation rules.
 */
export function resolveActiveSkills(
  skills: SkillDocument[],
  task: string
): SkillDocument[] {
  return skills.filter((skill) => {
    // Auto-activated skills are always on
    if (skill.activation.auto) return true;

    // Keyword-based activation
    if (skill.activation.keywords?.length) {
      const taskLower = task.toLowerCase();
      return skill.activation.keywords.some((kw) =>
        taskLower.includes(kw.toLowerCase())
      );
    }

    return false;
  });
}

/**
 * Build prompt injection string from active skills.
 */
export function buildSkillPromptInjection(skills: SkillDocument[]): string {
  const injections = skills
    .filter((s) => s.prompt_injection)
    .map((s) => s.prompt_injection!.trim());

  return injections.join("\n\n");
}

/**
 * Convert a skill-provided tool definition into a ToolDefinition.
 * Skill tools that define a `command` are executed as shell commands with parameter substitution.
 */
export function skillToolToDefinition(
  skillTool: SkillToolProvide
): ToolDefinition {
  const parameters: Record<string, unknown> = {
    type: "object",
    properties: {} as Record<string, unknown>,
    required: [] as string[],
  };

  if (skillTool.parameters) {
    for (const [name, param] of Object.entries(skillTool.parameters)) {
      (parameters.properties as Record<string, unknown>)[name] = {
        type: param.type,
        description: param.description,
      };
      if (param.required) {
        (parameters.required as string[]).push(name);
      }
    }
  }

  return {
    name: skillTool.name,
    description: skillTool.description,
    parameters,
    async execute(args) {
      if (!skillTool.command) {
        return {
          success: false,
          output: `Skill tool '${skillTool.name}' has no command defined.`,
        };
      }

      // Substitute parameters into command template
      let cmd = skillTool.command;
      for (const [key, value] of Object.entries(args)) {
        cmd = cmd.replace(`{${key}}`, String(value));
      }

      return new Promise((resolve) => {
        exec(cmd, { timeout: 30_000 }, (error, stdout, stderr) => {
          if (error) {
            resolve({
              success: false,
              output: `${stderr || error.message}\n${stdout}`.trim(),
            });
          } else {
            resolve({
              success: true,
              output: (stdout + (stderr ? `\n${stderr}` : "")).trim() || "(no output)",
            });
          }
        });
      });
    },
  };
}

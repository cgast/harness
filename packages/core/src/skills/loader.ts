/**
 * Skill YAML loader - loads and parses skill definition files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

export interface SkillToolProvide {
  name: string;
  description: string;
  command?: string;
  parameters?: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
}

export interface SkillDocument {
  id: string;
  name: string;
  description: string;
  version: number;

  activation: {
    auto?: boolean;
    keywords?: string[];
  };

  tools?: {
    provides?: SkillToolProvide[];
    requires?: string[];
  };

  prompt_injection?: string;
}

/**
 * Load a skill from a YAML file.
 */
export function loadSkill(filePath: string): SkillDocument {
  const content = fs.readFileSync(filePath, "utf-8");
  const doc = YAML.parse(content) as SkillDocument;

  if (!doc.id) throw new Error(`Skill missing 'id': ${filePath}`);
  if (!doc.name) throw new Error(`Skill missing 'name': ${filePath}`);

  // Defaults
  doc.activation = doc.activation || { auto: false };

  return doc;
}

/**
 * Load all skills from a directory.
 */
export function loadSkillsFromDir(dir: string): SkillDocument[] {
  if (!fs.existsSync(dir)) return [];

  const skills: SkillDocument[] = [];
  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const fullPath = path.join(dir, entry);
    try {
      skills.push(loadSkill(fullPath));
    } catch (err) {
      console.warn(`[skills] Failed to load ${fullPath}:`, err);
    }
  }

  return skills;
}

/**
 * Soul document loader - loads and validates soul YAML files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

export interface SoulLayer {
  boundaries?: string[];
  ethics?: string[];
  character?: {
    traits?: string[];
    style?: {
      verbosity?: string;
      tone?: string;
      language?: string;
    };
  };
  context?: {
    domain?: string;
    audience?: string;
    special_instructions?: string[];
  };
}

export interface SoulDocument {
  id: string;
  name: string;
  version: number;
  layers: SoulLayer;
}

/**
 * Load a soul document from a YAML file.
 */
export function loadSoul(filePath: string): SoulDocument {
  const content = fs.readFileSync(filePath, "utf-8");
  const doc = YAML.parse(content) as SoulDocument;

  // Basic validation
  if (!doc.id) throw new Error(`Soul document missing 'id': ${filePath}`);
  if (!doc.name) throw new Error(`Soul document missing 'name': ${filePath}`);
  if (!doc.layers) throw new Error(`Soul document missing 'layers': ${filePath}`);

  return doc;
}

/**
 * Find and load a soul by ID from a list of directories.
 */
export function findSoul(
  soulId: string,
  searchDirs: string[]
): SoulDocument | null {
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const fullPath = path.join(dir, entry);
      try {
        const soul = loadSoul(fullPath);
        if (soul.id === soulId) return soul;
      } catch {
        // Skip invalid files
      }
    }
  }
  return null;
}

/**
 * Soul injector - merges soul document layers into a system prompt string.
 * Layers are assembled in order: boundaries -> ethics -> character -> context
 */

import type { SoulDocument } from "./loader.js";

/**
 * Convert a soul document into a system prompt string.
 */
export function assembleSoulPrompt(soul: SoulDocument): string {
  const sections: string[] = [];
  const layers = soul.layers;

  // Layer 1: Boundaries (hard limits)
  if (layers.boundaries?.length) {
    sections.push("## Boundaries\n" + layers.boundaries.map((b) => `- ${b}`).join("\n"));
  }

  // Layer 2: Ethics
  if (layers.ethics?.length) {
    sections.push("## Ethics\n" + layers.ethics.map((e) => `- ${e}`).join("\n"));
  }

  // Layer 3: Character
  if (layers.character) {
    const charLines: string[] = [];
    if (layers.character.traits?.length) {
      charLines.push("Traits:");
      charLines.push(...layers.character.traits.map((t) => `- ${t}`));
    }
    if (layers.character.style) {
      const s = layers.character.style;
      if (s.verbosity) charLines.push(`Verbosity: ${s.verbosity}`);
      if (s.tone) charLines.push(`Tone: ${s.tone}`);
      if (s.language) charLines.push(`Language: ${s.language}`);
    }
    if (charLines.length) {
      sections.push("## Character\n" + charLines.join("\n"));
    }
  }

  // Layer 4: Context
  if (layers.context) {
    const ctxLines: string[] = [];
    if (layers.context.domain) ctxLines.push(`Domain: ${layers.context.domain}`);
    if (layers.context.audience) ctxLines.push(`Audience: ${layers.context.audience}`);
    if (layers.context.special_instructions?.length) {
      ctxLines.push("Instructions:");
      ctxLines.push(
        ...layers.context.special_instructions.map((i) => `- ${i}`)
      );
    }
    if (ctxLines.length) {
      sections.push("## Context\n" + ctxLines.join("\n"));
    }
  }

  if (sections.length === 0) {
    return `You are ${soul.name}.`;
  }

  return `You are ${soul.name}.\n\n${sections.join("\n\n")}`;
}

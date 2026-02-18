/**
 * Prompt assembler - builds the final prompt from soul + skills + context.
 */

import type { Message, ToolDefinitionSchema } from "../providers/provider.js";
import type { SoulDocument } from "../soul/loader.js";
import type { SkillDocument } from "../skills/loader.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventBus } from "../events/bus.js";
import { assembleSoulPrompt } from "../soul/injector.js";
import { buildSkillPromptInjection } from "../skills/resolver.js";

export interface AssembledPrompt {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinitionSchema[];
}

/**
 * Assemble the full prompt for the LLM from soul, active skills,
 * conversation history, and available tools.
 */
export async function assemblePrompt(
  soul: SoulDocument | null,
  activeSkills: SkillDocument[],
  messages: Message[],
  toolRegistry: ToolRegistry,
  bus: EventBus
): Promise<AssembledPrompt | null> {
  // Build system prompt from soul
  let systemPrompt = soul
    ? assembleSoulPrompt(soul)
    : "You are a helpful assistant.";

  // Add skill prompt injections
  const skillInjection = buildSkillPromptInjection(activeSkills);
  if (skillInjection) {
    systemPrompt += "\n\n" + skillInjection;
  }

  // Add tool instructions
  const tools = toolRegistry.toSchemas();
  if (tools.length > 0) {
    systemPrompt +=
      "\n\nYou have access to tools. Use them when appropriate to complete the user's request. When you have enough information to provide a final answer, respond without using any tools.";
  }

  // Build message array (system prompt + conversation history)
  const allMessages: Message[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  // Emit prompt:assemble event (modifiable)
  const eventData = await bus.emit("prompt:assemble", {
    systemPrompt,
    messages: allMessages,
    tools,
  });

  if (!eventData) {
    // Aborted
    return null;
  }

  return {
    systemPrompt: eventData.systemPrompt,
    messages: eventData.messages,
    tools: eventData.tools,
  };
}

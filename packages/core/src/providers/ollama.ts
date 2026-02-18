/**
 * Ollama provider - uses the OpenAI-compatible API that Ollama exposes.
 * Also works with LM Studio and other OpenAI-compatible local servers.
 */

import { OpenAIProvider, type OpenAIProviderConfig } from "./openai.js";

export interface OllamaProviderConfig {
  baseUrl?: string; // Defaults to http://localhost:11434
  defaultModel?: string;
}

export function createOllamaProvider(
  config: OllamaProviderConfig = {}
): OpenAIProvider {
  const baseUrl = config.baseUrl || "http://localhost:11434";
  return new OpenAIProvider(
    {
      apiKey: "ollama", // Ollama doesn't need a real key
      baseUrl: `${baseUrl}/v1`,
      defaultModel: config.defaultModel || "llama3.2",
    },
    "ollama"
  );
}

/**
 * OpenAI provider - works with OpenAI API and any OpenAI-compatible endpoint
 * (Ollama, LM Studio, vLLM, etc.)
 */

import type {
  LLMProvider,
  ChatRequest,
  ChatChunk,
  ToolCallMessage,
} from "./provider.js";

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string; // Defaults to https://api.openai.com/v1
  defaultModel?: string;
}

export class OpenAIProvider implements LLMProvider {
  id: string;
  name: string;
  supportsTools = true;
  supportsStreaming = true;
  supportsImages = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(config: OpenAIProviderConfig, id?: string) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(
      /\/$/,
      ""
    );
    this.id = id || "openai";
    this.name = id === "ollama" ? "Ollama" : "OpenAI";
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const body = this.buildRequestBody(request);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield {
        type: "error",
        error: `OpenAI API error ${response.status}: ${errorText}`,
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls: Map<
      number,
      { id: string; name: string; args: string }
    > = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const choice = json.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            // Text content
            if (delta.content) {
              yield { type: "text", content: delta.content };
            }

            // Tool calls (streaming - may arrive in chunks)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls.has(idx)) {
                  toolCalls.set(idx, {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    args: "",
                  });
                }
                const existing = toolCalls.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments)
                  existing.args += tc.function.arguments;
              }
            }

            // Usage info (in final chunk)
            if (json.usage) {
              yield {
                type: "text",
                content: "",
                usage: {
                  inputTokens: json.usage.prompt_tokens || 0,
                  outputTokens: json.usage.completion_tokens || 0,
                },
              };
            }

            // Check if finished
            if (choice.finish_reason === "stop") {
              // Emit any accumulated tool calls
              for (const tc of toolCalls.values()) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(tc.args || "{}");
                } catch {
                  // Invalid JSON args
                }
                yield {
                  type: "tool_call",
                  toolCall: { id: tc.id, name: tc.name, args },
                };
              }
            }

            if (choice.finish_reason === "tool_calls") {
              // Emit accumulated tool calls
              for (const tc of toolCalls.values()) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(tc.args || "{}");
                } catch {
                  // Invalid JSON args
                }
                yield {
                  type: "tool_call",
                  toolCall: { id: tc.id, name: tc.name, args },
                };
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done" };
  }

  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const messages = request.messages.map((msg) => {
      if (msg.role === "tool") {
        return {
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId,
        };
      }
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return {
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        };
      }
      return { role: msg.role, content: msg.content };
    });

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    return body;
  }
}

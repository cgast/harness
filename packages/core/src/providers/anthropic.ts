/**
 * Anthropic provider - Claude models via the Anthropic Messages API.
 */

import type {
  LLMProvider,
  ChatRequest,
  ChatChunk,
  Message,
} from "./provider.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class AnthropicProvider implements LLMProvider {
  id = "anthropic";
  name = "Anthropic Claude";
  supportsTools = true;
  supportsStreaming = true;
  supportsImages = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl || "https://api.anthropic.com"
    ).replace(/\/$/, "");
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const body = this.buildRequestBody(request);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield {
        type: "error",
        error: `Anthropic API error ${response.status}: ${errorText}`,
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
    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));

            switch (json.type) {
              case "message_start":
                if (json.message?.usage) {
                  inputTokens = json.message.usage.input_tokens || 0;
                }
                break;

              case "content_block_start":
                if (json.content_block?.type === "tool_use") {
                  currentToolId = json.content_block.id || "";
                  currentToolName = json.content_block.name || "";
                  currentToolArgs = "";
                }
                break;

              case "content_block_delta":
                if (json.delta?.type === "text_delta") {
                  yield { type: "text", content: json.delta.text };
                } else if (json.delta?.type === "input_json_delta") {
                  currentToolArgs += json.delta.partial_json || "";
                }
                break;

              case "content_block_stop":
                if (currentToolName) {
                  let args: Record<string, unknown> = {};
                  try {
                    args = JSON.parse(currentToolArgs || "{}");
                  } catch {
                    // Invalid args
                  }
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: currentToolId,
                      name: currentToolName,
                      args,
                    },
                  };
                  currentToolId = "";
                  currentToolName = "";
                  currentToolArgs = "";
                }
                break;

              case "message_delta":
                if (json.usage) {
                  outputTokens = json.usage.output_tokens || 0;
                }
                break;

              case "message_stop":
                yield {
                  type: "done",
                  usage: { inputTokens, outputTokens },
                };
                break;

              case "error":
                yield {
                  type: "error",
                  error: json.error?.message || "Unknown Anthropic error",
                };
                break;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    // Anthropic separates system prompt from messages
    let systemPrompt = "";
    const messages: Array<Record<string, unknown>> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n" : "") + msg.content;
        continue;
      }

      if (msg.role === "tool") {
        // Anthropic tool results are user messages with tool_result content
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId,
              content: msg.content,
            },
          ],
        });
        continue;
      }

      if (msg.role === "assistant" && msg.toolCalls?.length) {
        // Assistant message with tool use blocks
        const content: Array<Record<string, unknown>> = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
        messages.push({ role: "assistant", content });
        continue;
      }

      messages.push({ role: msg.role, content: msg.content });
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      max_tokens: request.maxTokens || 4096,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    return body;
  }
}

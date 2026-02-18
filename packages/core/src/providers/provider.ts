// Message types for LLM conversations
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string; // For tool results
  toolCallId?: string; // For tool results - references which tool call this result is for
  toolCalls?: ToolCallMessage[]; // For assistant messages containing tool calls
}

export interface ToolCallMessage {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// JSON Schema type (simplified)
export type JSONSchema = Record<string, unknown>;

// Tool definition as sent to LLM
export interface ToolDefinitionSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
}

// Chat request/response types
export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinitionSchema[];
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatChunk {
  type: "text" | "tool_call" | "done" | "error";
  content?: string;
  toolCall?: ToolCallMessage;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

// The LLM Provider interface
export interface LLMProvider {
  id: string;
  name: string;

  chat(request: ChatRequest): AsyncGenerator<ChatChunk>;

  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsImages: boolean;
}

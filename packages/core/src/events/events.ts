/**
 * Event type definitions for the Harness event bus.
 * All behavior changes go through events.
 */

import type { Message, ToolDefinitionSchema } from "../providers/provider.js";
import type { FeedbackRequest, FeedbackResponse } from "../feedback/types.js";

// All event names as a union type
export type EventName =
  | "agent:start"
  | "agent:end"
  | "agent:error"
  | "loop:iteration_start"
  | "loop:iteration_end"
  | "prompt:assemble"
  | "llm:request"
  | "llm:chunk"
  | "llm:response"
  | "llm:error"
  | "tool:request"
  | "tool:start"
  | "tool:result"
  | "tool:error"
  | "tool:register"
  | "tool:unregister"
  | "state:change"
  | "user:input"
  | "user:interrupt"
  | "user:confirm"
  | "skill:activate"
  | "skill:deactivate"
  | "feedback:request"
  | "feedback:response"
  | "feedback:timeout"
  | "feedback:cancel"
  | "heartbeat:before"
  | "heartbeat:after"
  | "heartbeat:skip";

// Event payload map: maps event names to their data types
export interface EventPayloads {
  "agent:start": {
    task: string;
    soul: string;
    skills: string[];
    config: Record<string, unknown>;
  };
  "agent:end": {
    task: string;
    result: string;
    tokenUsage: { input: number; output: number; cost?: number };
  };
  "agent:error": {
    error: Error;
    iteration: number;
  };
  "loop:iteration_start": {
    iteration: number;
    state: Record<string, unknown>;
  };
  "loop:iteration_end": {
    iteration: number;
    state: Record<string, unknown>;
  };
  "prompt:assemble": {
    systemPrompt: string;
    messages: Message[];
    tools: ToolDefinitionSchema[];
  };
  "llm:request": {
    provider: string;
    model: string;
    messages: Message[];
  };
  "llm:chunk": {
    chunk: unknown;
  };
  "llm:response": {
    response: Message;
    usage: { inputTokens: number; outputTokens: number };
  };
  "llm:error": {
    error: Error;
    retryCount: number;
    retry?: boolean;
  };
  "tool:request": {
    name: string;
    args: Record<string, unknown>;
    abort?: boolean;
  };
  "tool:start": {
    name: string;
    args: Record<string, unknown>;
  };
  "tool:result": {
    name: string;
    result: { success: boolean; output: string; artifacts?: string[] };
    duration: number;
  };
  "tool:error": {
    name: string;
    error: Error;
  };
  "tool:register": {
    tool: { name: string; description: string };
  };
  "tool:unregister": {
    name: string;
  };
  "state:change": {
    path: string;
    oldValue: unknown;
    newValue: unknown;
  };
  "user:input": {
    text: string;
  };
  "user:interrupt": Record<string, never>;
  "user:confirm": {
    message: string;
  };
  "skill:activate": {
    skillId: string;
  };
  "skill:deactivate": {
    skillId: string;
  };

  // Feedback (human-in-the-loop) events
  "feedback:request": {
    request: FeedbackRequest;
    adapterId: string;
  };
  "feedback:response": {
    request: FeedbackRequest;
    response: FeedbackResponse;
    adapterId: string;
    durationMs: number;
  };
  "feedback:timeout": {
    request: FeedbackRequest;
    adapterId: string;
    timeoutMs: number;
  };
  "feedback:cancel": {
    requestId: string;
    reason: string;
  };

  // Heartbeat events
  "heartbeat:before": {
    mission: string;
    soulId: string | null;
    maxIterations: number;
    timestamp: string;
  };
  "heartbeat:after": {
    summary: string;
    tokenUsage: { input: number; output: number };
    iterations: number;
    tickCount: number;
    timestamp: string;
  };
  "heartbeat:skip": {
    reason: string;
    timestamp: string;
  };
}

// Modifiable events - hooks can modify data or abort
export const MODIFIABLE_EVENTS: Set<EventName> = new Set([
  "agent:start",
  "loop:iteration_start",
  "prompt:assemble",
  "llm:request",
  "llm:error",
  "tool:request",
  "tool:result",
  "user:input",
  "feedback:request",
  "heartbeat:before",
]);

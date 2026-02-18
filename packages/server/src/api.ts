/**
 * API definitions for server mode (REST + WebSocket).
 */

// ── REST API types ────────────────────────────────────────────────

export interface RunTaskRequest {
  task: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

export interface RunTaskResponse {
  success: boolean;
  response: string;
  iterations: number;
  tokenUsage: { input: number; output: number };
  aborted: boolean;
}

export interface HealthResponse {
  status: "ok" | "error";
  version: string;
  /** Number of active WebSocket connections. */
  connections: number;
}

// ── Re-export WebSocket protocol types ────────────────────────────

export type {
  ClientMessage,
  ServerMessage,
  RunMessage,
  CancelMessage,
  FeedbackMessage,
  PingMessage,
  SessionInitMessage,
  TaskStartMessage,
  TaskCompleteMessage,
  TaskErrorMessage,
  EventMessage,
  TextDeltaMessage,
  FeedbackRequestMessage,
  PongMessage,
  ErrorMessage,
} from "./protocol.js";

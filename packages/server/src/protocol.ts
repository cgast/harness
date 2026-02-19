/**
 * WebSocket streaming protocol types.
 *
 * Defines the bidirectional message format between WebSocket clients
 * and the Harness server. All messages are JSON-encoded.
 */

// ── Client → Server messages ──────────────────────────────────────

export interface RunMessage {
  type: "run";
  /** Client-generated correlation ID for this task. */
  id: string;
  task: string;
  config?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxIterations?: number;
  };
}

export interface CancelMessage {
  type: "cancel";
  /** The task ID (from RunMessage.id) to cancel. */
  id: string;
}

export interface FeedbackMessage {
  type: "feedback";
  /** The feedback request ID to respond to. */
  requestId: string;
  response: Record<string, unknown>;
}

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | RunMessage
  | CancelMessage
  | FeedbackMessage
  | PingMessage;

// ── Server → Client messages ──────────────────────────────────────

export interface SessionInitMessage {
  type: "session:init";
  sessionId: string;
}

export interface TaskStartMessage {
  type: "task:start";
  taskId: string;
}

export interface TaskCompleteMessage {
  type: "task:complete";
  taskId: string;
  result: {
    success: boolean;
    response: string;
    iterations: number;
    tokenUsage: { input: number; output: number };
    aborted: boolean;
  };
}

export interface TaskErrorMessage {
  type: "task:error";
  taskId: string;
  error: string;
}

export interface EventMessage {
  type: "event";
  taskId: string;
  event: string;
  data: unknown;
}

export interface TextDeltaMessage {
  type: "text:delta";
  taskId: string;
  content: string;
}

export interface FeedbackRequestMessage {
  type: "feedback:request";
  taskId: string;
  request: Record<string, unknown>;
}

export interface PongMessage {
  type: "pong";
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ServerMessage =
  | SessionInitMessage
  | TaskStartMessage
  | TaskCompleteMessage
  | TaskErrorMessage
  | EventMessage
  | TextDeltaMessage
  | FeedbackRequestMessage
  | PongMessage
  | ErrorMessage;

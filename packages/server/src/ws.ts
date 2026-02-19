/**
 * WebSocket handler - bridges the Harness EventBus to WebSocket clients.
 *
 * Handles:
 * - Connection lifecycle (open, close, error)
 * - Client message routing (run, cancel, feedback, ping)
 * - Forwarding agent events as streaming messages to the client
 * - Text delta streaming for real-time LLM output
 * - Human-in-the-loop feedback via DeferredFeedbackAdapter
 */

import type { WebSocket, WebSocketServer } from "ws";
import type { HarnessAgent, EventName, FeedbackResponse } from "@harness/core";
import { DeferredFeedbackAdapter } from "@harness/core";
import type {
  ClientMessage,
  ServerMessage,
} from "./protocol.js";
import { SessionManager, type Session } from "./sessions.js";

/** Events forwarded to the client as `event` messages. */
const FORWARDED_EVENTS: EventName[] = [
  "agent:start",
  "agent:end",
  "agent:error",
  "loop:iteration_start",
  "loop:iteration_end",
  "llm:request",
  "llm:response",
  "llm:error",
  "tool:request",
  "tool:start",
  "tool:result",
  "tool:error",
];

/**
 * Send a JSON message to a WebSocket client, guarding against closed sockets.
 */
function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Attach WebSocket handling to a WebSocketServer.
 *
 * Registers a DeferredFeedbackAdapter with the agent's FeedbackManager so that
 * feedback requests are routed to WebSocket clients and responses delivered back.
 */
export function attachWebSocket(
  wss: WebSocketServer,
  agent: HarnessAgent
): SessionManager {
  const sessions = new SessionManager();

  // Register a deferred feedback adapter for WebSocket clients.
  // Feedback requests are forwarded to clients via the event bus hook;
  // client responses are routed back through adapter.resolve().
  const feedbackAdapter = new DeferredFeedbackAdapter();
  agent.feedback.registerAdapter(feedbackAdapter);

  wss.on("connection", (ws: WebSocket) => {
    const session = sessions.create();

    // Send session:init
    send(ws, { type: "session:init", sessionId: session.id });

    // Wire up message handling
    ws.on("message", (raw: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
      } catch {
        send(ws, { type: "error", code: "PARSE_ERROR", message: "Invalid JSON" });
        return;
      }

      handleClientMessage(ws, session, agent, sessions, feedbackAdapter, msg);
    });

    ws.on("close", () => {
      sessions.destroy(session.id);
    });

    ws.on("error", () => {
      sessions.destroy(session.id);
    });
  });

  return sessions;
}

/**
 * Route a parsed client message to the appropriate handler.
 */
function handleClientMessage(
  ws: WebSocket,
  session: Session,
  agent: HarnessAgent,
  sessions: SessionManager,
  feedbackAdapter: DeferredFeedbackAdapter,
  msg: ClientMessage
): void {
  switch (msg.type) {
    case "ping":
      send(ws, { type: "pong" });
      break;

    case "run":
      handleRun(ws, session, agent, sessions, msg.id, msg.task, msg.config);
      break;

    case "cancel":
      handleCancel(ws, session, sessions, msg.id);
      break;

    case "feedback":
      handleFeedback(ws, feedbackAdapter, msg.requestId, msg.response);
      break;

    default:
      send(ws, {
        type: "error",
        code: "UNKNOWN_TYPE",
        message: `Unknown message type: ${(msg as any).type}`,
      });
  }
}

/**
 * Handle a "run" message: start a task with full event streaming.
 */
function handleRun(
  ws: WebSocket,
  session: Session,
  agent: HarnessAgent,
  sessions: SessionManager,
  taskId: string,
  task: string,
  config?: { provider?: string; model?: string; temperature?: number; maxIterations?: number }
): void {
  // Reject if a task is already running
  if (session.activeTask) {
    send(ws, {
      type: "error",
      code: "TASK_ACTIVE",
      message: "A task is already running. Cancel it first.",
    });
    return;
  }

  if (!task) {
    send(ws, {
      type: "error",
      code: "INVALID_REQUEST",
      message: "Missing 'task' field",
    });
    return;
  }

  // Apply per-task config overrides
  if (config) {
    const stateConfig = agent.state.get("config");
    agent.state.update({
      config: {
        ...stateConfig,
        ...(config.provider && { provider: config.provider }),
        ...(config.model && { model: config.model }),
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxIterations !== undefined && { maxIterations: config.maxIterations }),
      },
    });
  }

  // Register the task
  const abortController = sessions.setTask(session.id, taskId);

  // Subscribe to agent events for this session
  const unsubscribes: Array<() => void> = [];

  // Forward standard events
  for (const eventName of FORWARDED_EVENTS) {
    const unsub = agent.bus.on(eventName, async (data: any) => {
      const safeData = sanitizeEventData(eventName, data);
      send(ws, {
        type: "event",
        taskId,
        event: eventName,
        data: safeData,
      });
    });
    unsubscribes.push(unsub);
  }

  // Stream LLM text deltas
  const chunkUnsub = agent.bus.on("llm:chunk", async (data: any) => {
    const chunk = data.chunk;
    if (chunk && chunk.type === "text" && chunk.content) {
      send(ws, {
        type: "text:delta",
        taskId,
        content: chunk.content,
      });
    }
  });
  unsubscribes.push(chunkUnsub);

  // Forward feedback requests
  const feedbackUnsub = agent.bus.on("feedback:request", async (data: any) => {
    send(ws, {
      type: "feedback:request",
      taskId,
      request: data.request,
    });
  });
  unsubscribes.push(feedbackUnsub);

  // Track unsubscribes on the session for cleanup
  session.unsubscribes.push(...unsubscribes);

  // Send task:start
  send(ws, { type: "task:start", taskId });

  // Run the agent (async, non-blocking)
  agent
    .run(task)
    .then((result) => {
      send(ws, {
        type: "task:complete",
        taskId,
        result: {
          success: result.success,
          response: result.response,
          iterations: result.iterations,
          tokenUsage: result.tokenUsage,
          aborted: result.aborted,
        },
      });
    })
    .catch((err: Error) => {
      // Don't send error if the task was aborted by the client
      if (abortController.signal.aborted) {
        send(ws, {
          type: "task:complete",
          taskId,
          result: {
            success: false,
            response: "Task cancelled by client.",
            iterations: 0,
            tokenUsage: { input: 0, output: 0 },
            aborted: true,
          },
        });
      } else {
        send(ws, {
          type: "task:error",
          taskId,
          error: err.message,
        });
      }
    })
    .finally(() => {
      // Clean up event listeners
      for (const unsub of unsubscribes) {
        unsub();
      }
      // Remove from session unsubscribes
      session.unsubscribes = session.unsubscribes.filter(
        (u) => !unsubscribes.includes(u)
      );
      sessions.clearTask(session.id);
    });
}

/**
 * Handle a "cancel" message: abort the running task.
 */
function handleCancel(
  ws: WebSocket,
  session: Session,
  sessions: SessionManager,
  taskId: string
): void {
  if (!session.activeTask) {
    send(ws, {
      type: "error",
      code: "NO_TASK",
      message: "No active task to cancel.",
    });
    return;
  }

  if (session.activeTask.taskId !== taskId) {
    send(ws, {
      type: "error",
      code: "TASK_MISMATCH",
      message: `Active task is '${session.activeTask.taskId}', not '${taskId}'.`,
    });
    return;
  }

  sessions.cancelTask(session.id);
}

/**
 * Handle a "feedback" message: deliver the response to the DeferredFeedbackAdapter.
 */
function handleFeedback(
  ws: WebSocket,
  feedbackAdapter: DeferredFeedbackAdapter,
  requestId: string,
  response: Record<string, unknown>
): void {
  const delivered = feedbackAdapter.resolve(
    requestId,
    response as unknown as FeedbackResponse
  );

  if (!delivered) {
    send(ws, {
      type: "error",
      code: "FEEDBACK_ERROR",
      message: `No pending feedback request with ID '${requestId}'`,
    });
  }
}

/**
 * Make event data safe for JSON serialization (convert Errors, strip circular refs).
 */
function sanitizeEventData(event: string, data: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(data, (_key, value) => {
        if (value instanceof Error) {
          return { message: value.message, name: value.name };
        }
        return value;
      })
    );
  } catch {
    return { _serialization_error: true, event };
  }
}

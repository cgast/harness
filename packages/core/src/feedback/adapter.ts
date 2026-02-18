/**
 * FeedbackAdapter - Abstraction over the transport channel for human feedback.
 *
 * The adapter answers: "How do I actually reach a human and get their response?"
 * Different environments need different adapters:
 *   - CLI: prompt on stdin
 *   - Web: POST webhook, wait for callback
 *   - API: return pending status, poll/wait for response
 *   - Slack/Teams: send message to channel, wait for reaction/thread reply
 *   - Queue: push to a task queue, dequeue response
 *
 * Adapters are intentionally simple — they only need to deliver a request
 * and return a response. The FeedbackManager handles timeouts, retries,
 * event emission, and state coordination.
 */

import type { FeedbackRequest, FeedbackResponse, CancelledFeedbackResponse } from "./types.js";

export interface FeedbackAdapter {
  /** Unique ID for this adapter (e.g. "cli", "slack", "webhook"). */
  readonly id: string;

  /** Human-readable name. */
  readonly name: string;

  /**
   * Send a feedback request to a human and wait for their response.
   * The adapter should block (async) until a response is available.
   *
   * The FeedbackManager wraps this with its own timeout, so the adapter
   * does not need to implement timeout logic — but it can if the transport
   * requires it (e.g. HTTP request timeout).
   *
   * Throw an error if the transport fails (network error, channel unavailable, etc.).
   * Return a response with status: "cancelled" if the human actively declines to respond.
   */
  requestFeedback(request: FeedbackRequest): Promise<FeedbackResponse>;

  /**
   * Optional: cancel a pending feedback request.
   * Called when the agent times out or no longer needs the feedback.
   * Adapters that support this should clean up any pending UI/messages.
   */
  cancelRequest?(requestId: string): Promise<void>;

  /**
   * Optional: check if this adapter can handle a given request type.
   * Useful for routing — e.g. a Slack adapter might only handle confirmations,
   * while a web form adapter handles structured forms.
   */
  canHandle?(request: FeedbackRequest): boolean;

  /**
   * Optional lifecycle: called when the adapter is registered with a FeedbackManager.
   */
  initialize?(): Promise<void>;

  /**
   * Optional lifecycle: called when the adapter is removed or the manager shuts down.
   */
  dispose?(): Promise<void>;
}

// ── Built-in adapters ───────────────────────────────────────────────

/**
 * CallbackFeedbackAdapter — wraps a user-supplied callback function.
 *
 * The simplest adapter: you provide a function, it gets called with the
 * request, and whatever it returns becomes the response. Good for:
 *   - Tests and mocks
 *   - Simple programmatic integrations
 *   - Wrapping existing approval APIs
 *
 * Usage:
 *   const adapter = new CallbackFeedbackAdapter(async (req) => {
 *     const approved = await myApprovalService.check(req.prompt);
 *     return { requestId: req.id, status: "completed", approved };
 *   });
 */
export class CallbackFeedbackAdapter implements FeedbackAdapter {
  readonly id: string;
  readonly name: string;

  private callback: (request: FeedbackRequest) => Promise<FeedbackResponse>;
  private cancelCallback?: (requestId: string) => Promise<void>;

  constructor(
    callback: (request: FeedbackRequest) => Promise<FeedbackResponse>,
    options?: {
      id?: string;
      name?: string;
      onCancel?: (requestId: string) => Promise<void>;
    }
  ) {
    this.callback = callback;
    this.id = options?.id ?? "callback";
    this.name = options?.name ?? "Callback Adapter";
    this.cancelCallback = options?.onCancel;
  }

  async requestFeedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    return this.callback(request);
  }

  async cancelRequest(requestId: string): Promise<void> {
    if (this.cancelCallback) {
      await this.cancelCallback(requestId);
    }
  }
}

/**
 * DeferredFeedbackAdapter — returns a promise that resolves when
 * you call `.resolve(requestId, response)` externally.
 *
 * This is the adapter for API/webhook patterns where:
 *   1. Agent requests feedback → adapter creates a pending promise
 *   2. External system (webhook handler, API endpoint, UI) eventually calls resolve()
 *   3. The promise resolves and the agent loop continues
 *
 * Usage:
 *   const adapter = new DeferredFeedbackAdapter();
 *   manager.registerAdapter(adapter);
 *
 *   // In your HTTP handler:
 *   app.post("/feedback/:requestId", (req, res) => {
 *     adapter.resolve(req.params.requestId, req.body);
 *     res.json({ ok: true });
 *   });
 */
export class DeferredFeedbackAdapter implements FeedbackAdapter {
  readonly id = "deferred";
  readonly name = "Deferred Feedback Adapter";

  private pending = new Map<
    string,
    {
      resolve: (response: FeedbackResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  /** Called by the FeedbackManager to request feedback. Creates a pending promise. */
  async requestFeedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    return new Promise<FeedbackResponse>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
    });
  }

  /** Call this externally when a human response arrives. */
  resolve(requestId: string, response: FeedbackResponse): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(response);
    return true;
  }

  /** Call this externally to reject/error a pending request. */
  reject(requestId: string, error: Error): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.reject(error);
    return true;
  }

  /** Cancel a pending request. */
  async cancelRequest(requestId: string): Promise<void> {
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      const cancelledResponse: CancelledFeedbackResponse = {
        requestId,
        status: "cancelled",
        reason: "Request cancelled by agent",
        respondedAt: new Date().toISOString(),
      };
      entry.resolve(cancelledResponse);
    }
  }

  /** Check if a request is still pending. */
  isPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Get all pending request IDs. */
  pendingRequests(): string[] {
    return Array.from(this.pending.keys());
  }

  async dispose(): Promise<void> {
    // Cancel all pending requests on shutdown
    for (const requestId of this.pending.keys()) {
      await this.cancelRequest(requestId);
    }
  }
}

/**
 * AutoApproveAdapter — automatically approves/responds to all requests.
 *
 * Useful for:
 *   - Development/testing where you don't want manual gates
 *   - Non-interactive environments (CI/CD)
 *   - "YOLO mode" (use with caution)
 */
export class AutoApproveAdapter implements FeedbackAdapter {
  readonly id = "auto-approve";
  readonly name = "Auto-Approve Adapter";

  async requestFeedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    const now = new Date().toISOString();

    switch (request.type) {
      case "confirm":
        return { requestId: request.id, status: "completed", respondedBy: "auto-approve", respondedAt: now, approved: true };
      case "choice":
        return { requestId: request.id, status: "completed", respondedBy: "auto-approve", respondedAt: now, selected: request.defaults.length > 0 ? request.defaults : [request.options[0]?.id] };
      case "text":
        return { requestId: request.id, status: "completed", respondedBy: "auto-approve", respondedAt: now, text: "" };
      case "review":
        return { requestId: request.id, status: "completed", respondedBy: "auto-approve", respondedAt: now, verdict: "approve" as const };
      case "form": {
        const values: Record<string, unknown> = {};
        for (const field of request.fields) {
          values[field.id] = field.default ?? null;
        }
        return { requestId: request.id, status: "completed", respondedBy: "auto-approve", respondedAt: now, values };
      }
    }
  }
}

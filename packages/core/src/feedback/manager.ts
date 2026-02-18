/**
 * FeedbackManager - Coordinates human-in-the-loop feedback.
 *
 * Sits between the agent loop and FeedbackAdapters. Responsibilities:
 *   - Route feedback requests to the right adapter
 *   - Handle timeouts (agent can't wait forever)
 *   - Emit feedback lifecycle events on the bus
 *   - Pause agent state while waiting, resume when feedback arrives
 *   - Track pending requests for observability
 *   - Provide helper methods for common patterns (confirm, choose, review)
 */

import { v4 as uuid } from "uuid";
import type { EventBus } from "../events/bus.js";
import type { AgentState } from "../engine/state.js";
import type {
  FeedbackRequest,
  FeedbackRequestBase,
  FeedbackResponse,
  FeedbackType,
  ConfirmFeedbackRequest,
  ChoiceFeedbackRequest,
  TextFeedbackRequest,
  ReviewFeedbackRequest,
  FormFeedbackRequest,
  ReviewVerdict,
  FormField,
  ConfirmFeedbackResponse,
  ChoiceFeedbackResponse,
  TextFeedbackResponse,
  ReviewFeedbackResponse,
  FormFeedbackResponse,
} from "./types.js";
import type { FeedbackAdapter } from "./adapter.js";

export interface FeedbackManagerConfig {
  /** Default timeout for feedback requests (ms). 0 = no timeout. Default: 300000 (5 min). */
  defaultTimeout?: number;
  /** Default priority for feedback requests. Default: 100. */
  defaultPriority?: number;
}

interface PendingRequest {
  request: FeedbackRequest;
  adapterId: string;
  startTime: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export class FeedbackManager {
  private adapters = new Map<string, FeedbackAdapter>();
  private pending = new Map<string, PendingRequest>();
  private bus: EventBus;
  private state: AgentState;
  private config: Required<FeedbackManagerConfig>;

  constructor(bus: EventBus, state: AgentState, config: FeedbackManagerConfig = {}) {
    this.bus = bus;
    this.state = state;
    this.config = {
      defaultTimeout: config.defaultTimeout ?? 300_000,
      defaultPriority: config.defaultPriority ?? 100,
    };
  }

  // ── Adapter management ──────────────────────────────────────────

  async registerAdapter(adapter: FeedbackAdapter): Promise<void> {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Feedback adapter '${adapter.id}' is already registered.`);
    }
    if (adapter.initialize) {
      await adapter.initialize();
    }
    this.adapters.set(adapter.id, adapter);
  }

  async unregisterAdapter(adapterId: string): Promise<void> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return;

    // Cancel any pending requests for this adapter
    for (const [reqId, pending] of this.pending) {
      if (pending.adapterId === adapterId) {
        await this.cancelRequest(reqId, "Adapter unregistered");
      }
    }

    if (adapter.dispose) {
      await adapter.dispose();
    }
    this.adapters.delete(adapterId);
  }

  getAdapter(id: string): FeedbackAdapter | undefined {
    return this.adapters.get(id);
  }

  listAdapters(): FeedbackAdapter[] {
    return Array.from(this.adapters.values());
  }

  // ── Core feedback request ───────────────────────────────────────

  /**
   * Request feedback from a human via the specified adapter (or first available).
   *
   * This is the low-level method. Prefer the typed helpers below (confirm, choose, etc.).
   *
   * The method:
   *   1. Emits feedback:request (modifiable — plugins can transform or abort)
   *   2. Sets agent state to "paused"
   *   3. Sends request to adapter
   *   4. Waits for response (with timeout)
   *   5. Emits feedback:response or feedback:timeout
   *   6. Sets agent state back to "running"
   *   7. Returns the response
   */
  async request(
    request: FeedbackRequest,
    adapterId?: string
  ): Promise<FeedbackResponse> {
    // Resolve adapter
    const adapter = this.resolveAdapter(request, adapterId);

    // Emit feedback:request (modifiable — can be transformed or aborted)
    const emitResult = await this.bus.emit("feedback:request", {
      request,
      adapterId: adapter.id,
    });

    if (!emitResult) {
      // Aborted by plugin
      return {
        requestId: request.id,
        status: "cancelled",
        reason: "Feedback request aborted by plugin",
        respondedAt: new Date().toISOString(),
      };
    }

    // Use possibly-modified request from event
    const finalRequest = emitResult.request;

    // Track pending request
    const startTime = Date.now();
    const pendingEntry: PendingRequest = {
      request: finalRequest,
      adapterId: adapter.id,
      startTime,
    };
    this.pending.set(finalRequest.id, pendingEntry);

    // Pause agent state
    const previousStatus = this.state.get("status");
    this.state.set("status", "paused");

    try {
      // Race adapter response against timeout
      const response = await this.raceTimeout(
        adapter.requestFeedback(finalRequest),
        finalRequest,
        adapter
      );

      const durationMs = Date.now() - startTime;

      // Emit feedback:response
      await this.bus.emit("feedback:response", {
        request: finalRequest,
        response,
        adapterId: adapter.id,
        durationMs,
      });

      return response;
    } finally {
      // Clean up
      this.cleanupPending(finalRequest.id);

      // Restore agent state (only if still paused — something else might have changed it)
      if (this.state.get("status") === "paused") {
        this.state.set("status", previousStatus === "paused" ? "running" : previousStatus);
      }
    }
  }

  // ── Typed helper methods ────────────────────────────────────────

  /**
   * Ask for a yes/no confirmation.
   */
  async confirm(
    prompt: string,
    action: string,
    options?: {
      adapterId?: string;
      timeout?: number;
      defaultDeny?: boolean;
      metadata?: Record<string, unknown>;
    }
  ): Promise<ConfirmFeedbackResponse> {
    const request: ConfirmFeedbackRequest = {
      ...this.buildBase("confirm", prompt, options?.timeout, options?.metadata),
      type: "confirm",
      action,
      defaultDeny: options?.defaultDeny ?? false,
    };
    return (await this.request(request, options?.adapterId)) as ConfirmFeedbackResponse;
  }

  /**
   * Ask the human to choose from options.
   */
  async choose(
    prompt: string,
    optionsList: Array<{ id: string; label: string; description?: string }>,
    options?: {
      adapterId?: string;
      timeout?: number;
      multiple?: boolean;
      defaults?: string[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<ChoiceFeedbackResponse> {
    const request: ChoiceFeedbackRequest = {
      ...this.buildBase("choice", prompt, options?.timeout, options?.metadata),
      type: "choice",
      options: optionsList,
      multiple: options?.multiple ?? false,
      defaults: options?.defaults ?? [],
    };
    return (await this.request(request, options?.adapterId)) as ChoiceFeedbackResponse;
  }

  /**
   * Ask for free-text input.
   */
  async askText(
    prompt: string,
    options?: {
      adapterId?: string;
      timeout?: number;
      placeholder?: string;
      multiline?: boolean;
      metadata?: Record<string, unknown>;
    }
  ): Promise<TextFeedbackResponse> {
    const request: TextFeedbackRequest = {
      ...this.buildBase("text", prompt, options?.timeout, options?.metadata),
      type: "text",
      placeholder: options?.placeholder,
      multiline: options?.multiline ?? false,
    };
    return (await this.request(request, options?.adapterId)) as TextFeedbackResponse;
  }

  /**
   * Ask a human to review an artifact (code, plan, output).
   */
  async review(
    prompt: string,
    artifact: ReviewFeedbackRequest["artifact"],
    options?: {
      adapterId?: string;
      timeout?: number;
      allowedVerdicts?: ReviewVerdict[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<ReviewFeedbackResponse> {
    const request: ReviewFeedbackRequest = {
      ...this.buildBase("review", prompt, options?.timeout, options?.metadata),
      type: "review",
      artifact,
      allowedVerdicts: options?.allowedVerdicts ?? ["approve", "reject", "revise"],
    };
    return (await this.request(request, options?.adapterId)) as ReviewFeedbackResponse;
  }

  /**
   * Ask a human to fill out a structured form.
   */
  async form(
    prompt: string,
    fields: FormField[],
    options?: {
      adapterId?: string;
      timeout?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<FormFeedbackResponse> {
    const request: FormFeedbackRequest = {
      ...this.buildBase("form", prompt, options?.timeout, options?.metadata),
      type: "form",
      fields,
    };
    return (await this.request(request, options?.adapterId)) as FormFeedbackResponse;
  }

  // ── Cancellation ────────────────────────────────────────────────

  async cancelRequest(requestId: string, reason: string): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) return;

    const adapter = this.adapters.get(pending.adapterId);
    if (adapter?.cancelRequest) {
      await adapter.cancelRequest(requestId);
    }

    await this.bus.emit("feedback:cancel", { requestId, reason });
    this.cleanupPending(requestId);
  }

  async cancelAll(reason: string): Promise<void> {
    const ids = Array.from(this.pending.keys());
    for (const id of ids) {
      await this.cancelRequest(id, reason);
    }
  }

  // ── Observability ───────────────────────────────────────────────

  getPendingRequests(): Array<{
    request: FeedbackRequest;
    adapterId: string;
    elapsedMs: number;
  }> {
    const now = Date.now();
    return Array.from(this.pending.values()).map((p) => ({
      request: p.request,
      adapterId: p.adapterId,
      elapsedMs: now - p.startTime,
    }));
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async dispose(): Promise<void> {
    await this.cancelAll("FeedbackManager disposing");
    for (const adapterId of Array.from(this.adapters.keys())) {
      await this.unregisterAdapter(adapterId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private buildBase(
    type: FeedbackType,
    prompt: string,
    timeout?: number,
    metadata?: Record<string, unknown>
  ): FeedbackRequestBase {
    return {
      id: uuid(),
      type,
      prompt,
      source: {
        sessionId: this.state.get("sessionId"),
        taskId: this.state.get("taskId"),
        iteration: this.state.get("iteration"),
      },
      timeout: timeout ?? this.config.defaultTimeout,
      priority: this.config.defaultPriority,
      metadata: metadata ?? {},
    };
  }

  private resolveAdapter(request: FeedbackRequest, preferredId?: string): FeedbackAdapter {
    // If a specific adapter was requested, use it
    if (preferredId) {
      const adapter = this.adapters.get(preferredId);
      if (!adapter) {
        throw new Error(`Feedback adapter '${preferredId}' not found.`);
      }
      return adapter;
    }

    // Find first adapter that can handle this request type
    for (const adapter of this.adapters.values()) {
      if (!adapter.canHandle || adapter.canHandle(request)) {
        return adapter;
      }
    }

    throw new Error(
      `No feedback adapter available for request type '${request.type}'. ` +
        `Register an adapter with FeedbackManager.registerAdapter().`
    );
  }

  private async raceTimeout(
    adapterPromise: Promise<FeedbackResponse>,
    request: FeedbackRequest,
    adapter: FeedbackAdapter
  ): Promise<FeedbackResponse> {
    if (request.timeout <= 0) {
      // No timeout
      return adapterPromise;
    }

    return new Promise<FeedbackResponse>((resolve) => {
      let settled = false;

      const timer = setTimeout(async () => {
        if (settled) return;
        settled = true;

        // Cancel the adapter's pending request
        if (adapter.cancelRequest) {
          await adapter.cancelRequest(request.id).catch(() => {});
        }

        // Emit timeout event
        await this.bus.emit("feedback:timeout", {
          request,
          adapterId: adapter.id,
          timeoutMs: request.timeout,
        });

        // Resolve with timeout response, respecting defaultDeny for confirmations
        if (request.type === "confirm") {
          resolve({
            requestId: request.id,
            status: "timeout",
            approved: !request.defaultDeny,
            respondedAt: new Date().toISOString(),
          });
        } else {
          resolve({
            requestId: request.id,
            status: "timeout",
            respondedAt: new Date().toISOString(),
          });
        }
      }, request.timeout);

      // Store timeout handle for cleanup
      const pending = this.pending.get(request.id);
      if (pending) {
        pending.timeoutHandle = timer;
      }

      adapterPromise
        .then((response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(response);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            requestId: request.id,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            respondedAt: new Date().toISOString(),
          });
        });
    });
  }

  private cleanupPending(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending?.timeoutHandle) {
      clearTimeout(pending.timeoutHandle);
    }
    this.pending.delete(requestId);
  }
}

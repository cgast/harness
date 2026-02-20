/**
 * Harness Web Transport - Replaces Electron IPC with REST + WebSocket.
 *
 * Implements the same HarnessDesktopApi interface that the renderer
 * expects via window.harness, but communicates over HTTP and WebSocket
 * to the @harness/server backend instead of Electron IPC.
 */

// ── Types ────────────────────────────────────────────────────────────

interface IpcResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface RunTaskOptions {
  task: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

// WebSocket protocol messages (matches @harness/server protocol)
interface WsMessage {
  type: string;
  [key: string]: unknown;
}

// ── Transport Implementation ─────────────────────────────────────────

type EventCallback = (payload: { event: string; data: unknown }) => void;
type MenuCallback = () => void;

class HarnessWebTransport {
  private ws: WebSocket | null = null;
  private eventCallbacks: EventCallback[] = [];
  private menuCallbacks: Map<string, MenuCallback[]> = new Map();
  private wsSessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private taskResolvers: Map<string, {
    resolve: (result: IpcResult) => void;
    onEvent?: (event: string, data: unknown) => void;
  }> = new Map();
  private taskCounter = 0;

  constructor() {
    this.connectWebSocket();
  }

  // ─── WebSocket Connection ────────────────────────────────────────

  private connectWebSocket(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[harness-web] WebSocket connected");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg: WsMessage = JSON.parse(ev.data as string);
        this.handleWsMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      console.log("[harness-web] WebSocket disconnected");
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 3000);
  }

  private handleWsMessage(msg: WsMessage): void {
    switch (msg.type) {
      case "session:init":
        this.wsSessionId = msg.sessionId as string;
        break;

      case "task:start":
        // Task started, events will follow
        break;

      case "task:complete": {
        const taskId = msg.taskId as string;
        const resolver = this.taskResolvers.get(taskId);
        if (resolver) {
          this.taskResolvers.delete(taskId);
          const result = msg.result as any;
          resolver.resolve({ ok: true, data: result });
        }
        break;
      }

      case "task:error": {
        const taskId = msg.taskId as string;
        const resolver = this.taskResolvers.get(taskId);
        if (resolver) {
          this.taskResolvers.delete(taskId);
          resolver.resolve({ ok: false, error: msg.error as string });
        }
        break;
      }

      case "event": {
        const event = msg.event as string;
        const data = msg.data;
        // Forward to all event listeners
        for (const cb of this.eventCallbacks) {
          try {
            cb({ event, data });
          } catch {
            // Ignore callback errors
          }
        }
        break;
      }

      case "text:delta": {
        // Forward as llm:chunk event for the renderer
        for (const cb of this.eventCallbacks) {
          try {
            cb({
              event: "llm:chunk",
              data: { chunk: { type: "text", content: msg.content } },
            });
          } catch {
            // Ignore callback errors
          }
        }
        break;
      }

      case "feedback:request": {
        for (const cb of this.eventCallbacks) {
          try {
            cb({
              event: "feedback:ui-request",
              data: msg.request,
            });
          } catch {
            // Ignore callback errors
          }
        }
        break;
      }

      case "pong":
        break;

      case "error":
        console.warn("[harness-web] Server error:", msg.message);
        break;
    }
  }

  private sendWs(msg: WsMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // ─── REST Helpers ────────────────────────────────────────────────

  private async get<T = unknown>(path: string): Promise<IpcResult<T>> {
    try {
      const resp = await fetch(path);
      const data = await resp.json();
      return data as IpcResult<T>;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  private async post<T = unknown>(path: string, body?: unknown): Promise<IpcResult<T>> {
    try {
      const resp = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json();
      return data as IpcResult<T>;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  private async put<T = unknown>(path: string, body?: unknown): Promise<IpcResult<T>> {
    try {
      const resp = await fetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json();
      return data as IpcResult<T>;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  private async patch<T = unknown>(path: string, body?: unknown): Promise<IpcResult<T>> {
    try {
      const resp = await fetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json();
      return data as IpcResult<T>;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  private async del<T = unknown>(path: string): Promise<IpcResult<T>> {
    try {
      const resp = await fetch(path, { method: "DELETE" });
      const data = await resp.json();
      return data as IpcResult<T>;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ─── Task Execution ──────────────────────────────────────────────

  runTask = (options: RunTaskOptions): Promise<IpcResult> => {
    return new Promise((resolve) => {
      const taskId = `web-task-${++this.taskCounter}`;

      // Register resolver to receive the task:complete or task:error
      this.taskResolvers.set(taskId, { resolve });

      const sent = this.sendWs({
        type: "run",
        id: taskId,
        task: options.task,
        config: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature,
          maxIterations: options.maxIterations,
        },
      });

      if (!sent) {
        this.taskResolvers.delete(taskId);
        resolve({ ok: false, error: "WebSocket not connected" });
      }
    });
  };

  sendInput = async (text: string): Promise<IpcResult> => {
    // Use WebSocket feedback mechanism or REST
    return { ok: true };
  };

  isRunning = (): Promise<IpcResult<boolean>> => {
    return this.get<boolean>("/api/running");
  };

  // ─── Feedback / HITL ─────────────────────────────────────────────

  feedbackRespond = (requestId: string, response: unknown): Promise<IpcResult> => {
    this.sendWs({
      type: "feedback",
      requestId,
      response: response as Record<string, unknown>,
    });
    return Promise.resolve({ ok: true });
  };

  feedbackPending = (): Promise<IpcResult> => {
    return this.get("/api/feedback/pending");
  };

  // ─── Telemetry ───────────────────────────────────────────────────

  getTelemetry = (): Promise<IpcResult> => {
    return this.get("/api/telemetry");
  };

  // ─── Tools ───────────────────────────────────────────────────────

  getTools = (): Promise<IpcResult> => {
    return this.get("/api/tools");
  };

  unregisterTool = (name: string): Promise<IpcResult> => {
    return this.del(`/api/tools/${encodeURIComponent(name)}`);
  };

  // ─── Skills ──────────────────────────────────────────────────────

  getSkills = (): Promise<IpcResult> => {
    return this.get("/api/skills");
  };

  activateSkill = (skillId: string): Promise<IpcResult> => {
    return this.post(`/api/skills/${encodeURIComponent(skillId)}/activate`);
  };

  deactivateSkill = (skillId: string): Promise<IpcResult> => {
    return this.post(`/api/skills/${encodeURIComponent(skillId)}/deactivate`);
  };

  // ─── Plugins ─────────────────────────────────────────────────────

  getPlugins = (): Promise<IpcResult> => {
    return this.get("/api/plugins");
  };

  // ─── Sessions ────────────────────────────────────────────────────

  getSessions = (limit?: number): Promise<IpcResult> => {
    return this.get(`/api/sessions${limit ? `?limit=${limit}` : ""}`);
  };

  getSession = (id: string): Promise<IpcResult> => {
    return this.get(`/api/sessions/${encodeURIComponent(id)}`);
  };

  getSessionEvents = (sessionId: string, limit?: number): Promise<IpcResult> => {
    return this.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/events${limit ? `?limit=${limit}` : ""}`
    );
  };

  // ─── State / Config ──────────────────────────────────────────────

  getState = (): Promise<IpcResult> => {
    return this.get("/api/state");
  };

  getConfig = (): Promise<IpcResult> => {
    return this.get("/api/config");
  };

  updateConfig = (partial: Record<string, unknown>): Promise<IpcResult> => {
    return this.patch("/api/config", partial);
  };

  getSettings = (): Promise<IpcResult> => {
    return this.get("/api/settings");
  };

  saveSettings = (settings: Record<string, unknown>): Promise<IpcResult> => {
    return this.put("/api/settings", settings);
  };

  // ─── Messages ────────────────────────────────────────────────────

  getMessages = (): Promise<IpcResult> => {
    return this.get("/api/messages");
  };

  // ─── Soul Files ──────────────────────────────────────────────────

  getSoulFiles = (): Promise<IpcResult> => {
    return this.get("/api/souls");
  };

  getSoulFile = (name: string): Promise<IpcResult> => {
    return this.get(`/api/souls/${encodeURIComponent(name)}`);
  };

  saveSoulFile = (name: string, data: Record<string, unknown>): Promise<IpcResult> => {
    return this.put(`/api/souls/${encodeURIComponent(name)}`, data);
  };

  deleteSoulFile = (name: string): Promise<IpcResult> => {
    return this.del(`/api/souls/${encodeURIComponent(name)}`);
  };

  setActiveSoul = (name: string): Promise<IpcResult> => {
    return this.post(`/api/souls/${encodeURIComponent(name)}/activate`);
  };

  // ─── Events ──────────────────────────────────────────────────────

  onEvent = (callback: EventCallback): void => {
    this.eventCallbacks.push(callback);
  };

  onMenuAction = (action: string, callback: MenuCallback): void => {
    const list = this.menuCallbacks.get(action) || [];
    list.push(callback);
    this.menuCallbacks.set(action, list);
  };
}

// ── Expose globally ──────────────────────────────────────────────────

export function initTransport(): void {
  (window as any).harness = new HarnessWebTransport();
}

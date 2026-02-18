/**
 * Session manager - tracks active WebSocket connections and their running tasks.
 *
 * Each WebSocket connection gets a Session. Each session can run one task at a
 * time. The session holds EventBus unsubscribe handles so listeners are cleaned
 * up when the client disconnects.
 */

import { v4 as uuid } from "uuid";

export interface TaskHandle {
  taskId: string;
  abortController: AbortController;
}

export interface Session {
  id: string;
  /** Currently running task, if any. */
  activeTask: TaskHandle | null;
  /** EventBus unsubscribe callbacks to clean up on disconnect. */
  unsubscribes: Array<() => void>;
  /** Timestamp the session was created. */
  createdAt: Date;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /**
   * Create a new session and return it.
   */
  create(): Session {
    const session: Session = {
      id: uuid(),
      activeTask: null,
      unsubscribes: [],
      createdAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Get a session by ID.
   */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Set the active task for a session.
   */
  setTask(sessionId: string, taskId: string): AbortController {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const abortController = new AbortController();
    session.activeTask = { taskId, abortController };
    return abortController;
  }

  /**
   * Clear the active task for a session.
   */
  clearTask(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeTask = null;
    }
  }

  /**
   * Cancel the active task for a session.
   */
  cancelTask(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.activeTask) return false;

    session.activeTask.abortController.abort();
    return true;
  }

  /**
   * Destroy a session: cancel running task, clean up event listeners.
   */
  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Cancel any active task
    if (session.activeTask) {
      session.activeTask.abortController.abort();
    }

    // Unsubscribe all event listeners
    for (const unsub of session.unsubscribes) {
      unsub();
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Get the count of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }
}

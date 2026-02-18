/**
 * In-memory persistence store - for tests and ephemeral sessions.
 */

import type {
  PersistenceStore,
  SessionRecord,
  MemoryRecord,
  EventLogRecord,
} from "./store.js";

export class MemoryStore implements PersistenceStore {
  private sessions: Map<string, SessionRecord> = new Map();
  private memory: Map<string, MemoryRecord> = new Map();
  private events: EventLogRecord[] = [];
  private eventId = 0;

  initialize(): void {
    // Nothing to initialize
  }

  close(): void {
    this.sessions.clear();
    this.memory.clear();
    this.events = [];
  }

  // Sessions
  saveSession(session: SessionRecord): void {
    this.sessions.set(session.id, { ...session });
  }

  getSession(id: string): SessionRecord | null {
    return this.sessions.get(id) ?? null;
  }

  listSessions(limit: number = 50): SessionRecord[] {
    const all = Array.from(this.sessions.values());
    all.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return all.slice(0, limit);
  }

  // Memory
  setMemory(key: string, value: unknown, scope: string = "global"): void {
    const compositeKey = `${scope}:${key}`;
    this.memory.set(compositeKey, {
      key,
      value: JSON.stringify(value),
      scope,
      updatedAt: new Date().toISOString(),
    });
  }

  getMemory(key: string, scope: string = "global"): unknown | null {
    const compositeKey = `${scope}:${key}`;
    const record = this.memory.get(compositeKey);
    if (!record) return null;
    return JSON.parse(record.value);
  }

  deleteMemory(key: string, scope: string = "global"): void {
    const compositeKey = `${scope}:${key}`;
    this.memory.delete(compositeKey);
  }

  // Events
  logEvent(record: Omit<EventLogRecord, "id">): void {
    this.events.push({ ...record, id: ++this.eventId });
  }

  getEvents(sessionId: string, limit: number = 100): EventLogRecord[] {
    return this.events
      .filter((e) => e.sessionId === sessionId)
      .slice(-limit);
  }
}

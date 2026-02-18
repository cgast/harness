/**
 * Persistence store interface.
 */

export interface SessionRecord {
  id: string;
  task: string;
  soulId: string | null;
  messages: string; // JSON
  state: string; // JSON
  tokenUsage: string | null; // JSON
  createdAt: string;
  endedAt: string | null;
}

export interface MemoryRecord {
  key: string;
  value: string; // JSON
  scope: string; // 'global' | 'soul:{id}' | 'plugin:{id}'
  updatedAt: string;
}

export interface EventLogRecord {
  id?: number;
  sessionId: string;
  event: string;
  data: string | null; // JSON
  timestamp: string;
}

export interface PersistenceStore {
  // Sessions
  saveSession(session: SessionRecord): void;
  getSession(id: string): SessionRecord | null;
  listSessions(limit?: number): SessionRecord[];

  // Memory (key-value)
  setMemory(key: string, value: unknown, scope?: string): void;
  getMemory(key: string, scope?: string): unknown | null;
  deleteMemory(key: string, scope?: string): void;

  // Event log
  logEvent(record: Omit<EventLogRecord, "id">): void;
  getEvents(sessionId: string, limit?: number): EventLogRecord[];

  // Lifecycle
  initialize(): void;
  close(): void;
}

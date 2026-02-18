/**
 * SQLite persistence store using better-sqlite3.
 */

import Database from "better-sqlite3";
import type {
  PersistenceStore,
  SessionRecord,
  EventLogRecord,
} from "./store.js";

export class SqliteStore implements PersistenceStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        soul_id TEXT,
        messages TEXT NOT NULL,
        state TEXT NOT NULL,
        token_usage TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS memory (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        scope TEXT DEFAULT 'global',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (key, scope)
      );

      CREATE TABLE IF NOT EXISTS events_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        data TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events_log(session_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  // Sessions
  saveSession(session: SessionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, task, soul_id, messages, state, token_usage, created_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.task,
      session.soulId,
      session.messages,
      session.state,
      session.tokenUsage,
      session.createdAt,
      session.endedAt
    );
  }

  getSession(id: string): SessionRecord | null {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      task: row.task,
      soulId: row.soul_id,
      messages: row.messages,
      state: row.state,
      tokenUsage: row.token_usage,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    };
  }

  listSessions(limit: number = 50): SessionRecord[] {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?"
    );
    const rows = stmt.all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      task: row.task,
      soulId: row.soul_id,
      messages: row.messages,
      state: row.state,
      tokenUsage: row.token_usage,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    }));
  }

  // Memory
  setMemory(key: string, value: unknown, scope: string = "global"): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory (key, value, scope, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(key, JSON.stringify(value), scope);
  }

  getMemory(key: string, scope: string = "global"): unknown | null {
    const stmt = this.db.prepare(
      "SELECT value FROM memory WHERE key = ? AND scope = ?"
    );
    const row = stmt.get(key, scope) as any;
    if (!row) return null;
    return JSON.parse(row.value);
  }

  deleteMemory(key: string, scope: string = "global"): void {
    const stmt = this.db.prepare(
      "DELETE FROM memory WHERE key = ? AND scope = ?"
    );
    stmt.run(key, scope);
  }

  // Events
  logEvent(record: Omit<EventLogRecord, "id">): void {
    const stmt = this.db.prepare(`
      INSERT INTO events_log (session_id, event, data, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(record.sessionId, record.event, record.data, record.timestamp);
  }

  getEvents(sessionId: string, limit: number = 100): EventLogRecord[] {
    const stmt = this.db.prepare(
      "SELECT * FROM events_log WHERE session_id = ? ORDER BY id DESC LIMIT ?"
    );
    const rows = stmt.all(sessionId, limit) as any[];
    return rows.reverse().map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      event: row.event,
      data: row.data,
      timestamp: row.timestamp,
    }));
  }
}

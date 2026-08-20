import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Per-user chat history persistence (G4.S7.T11-followup, 2026-08-20) + chat
 * sessions (G4.S7.T12, 2026-08-20).
 *
 * Chat messages were previously kept only in the browser store — a reload
 * (F5) wiped the conversation. G4.S7.T11-followup persisted user/assistant
 * turns per employee into `chat_messages`. G4.S7.T12 adds the session layer on
 * top: every message belongs to a `session_id` (a chat session), and each user
 * keeps a picker of their ~10 most recent sessions (resume-style switcher).
 *
 * Design:
 * - One row per chat message, keyed by (employee_id, message_id).
 * - `speaker_id`/`speaker_name` describe the assistant speaker (agent alias
 *   or "Athena"); user messages carry the employee id as speaker.
 * - `progress` is a JSONB snapshot of tool-progress rows (remote agents);
 *   `thinking` stores the accumulated reasoning text (G4.S7.T11).
 * - `session_id` (TEXT, default '') — the chat session the message belongs to.
 *   **Legacy rows** (pre-T12, session_id = '') are treated as ONE virtual
 *   session titled "Previous chat" (a synthetic entry in `listSessions`, never
 *   a real `chat_sessions` row). Messages added to it keep session_id = ''.
 * - Sessions live in `chat_sessions` (session_id PK, employee_id, title,
 *   created_at, updated_at) — `touchSession` refreshes updated_at when a
 *   message lands so the picker surfaces recently-active sessions first.
 * - Lazy CREATE TABLE IF NOT EXISTS + additive ALTERs, same pattern as the
 *   agent registry / employee store; idempotent, safe on existing DBs.
 */

/** Title shown for the single flat conversation that predates sessions (T12). */
export const LEGACY_SESSION_TITLE = "Previous chat";

export interface PersistedChatMessage {
  message_id: string;
  employee_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  speaker_id: string;
  speaker_name: string;
  page: string;
  thinking: string;
  progress: Array<Record<string, unknown>>;
  session_id: string;
  created_at: string;
}

/** One picker row for a user's session (G4.S7.T12). */
export interface ChatSessionSummary {
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatHistoryStore {
  /** Persist one message. Idempotent per message_id (ON CONFLICT DO NOTHING). */
  saveMessage(msg: {
    employeeId: string;
    role: "user" | "assistant" | "system";
    content: string;
    speakerId?: string;
    speakerName?: string;
    page?: string;
    thinking?: string;
    progress?: Array<Record<string, unknown>>;
    messageId?: string;
    /** G4.S7.T12: the chat session the message belongs to ('' = legacy flat conversation). */
    sessionId?: string;
  }): Promise<void>;
  /**
   * Fetch the most recent `limit` messages for an employee, oldest-first.
   * When `sessionId` is given, only that session's messages are returned;
   * when omitted, all of the employee's messages (pre-T12 behavior).
   */
  listMessages(
    employeeId: string,
    sessionId?: string,
    limit?: number,
  ): Promise<PersistedChatMessage[]>;
  /** G4.S7.T12: create a chat session, returning its session_id. */
  createSession(employeeId: string, title?: string): Promise<string>;
  /** G4.S7.T12: the employee's recent sessions (most-recent first, capped).
   *  Includes the virtual legacy "Previous chat" session when flat rows exist. */
  listSessions(employeeId: string, limit?: number): Promise<ChatSessionSummary[]>;
  /** G4.S7.T12: does a session exist AND belong to this employee? ('' = legacy rows). */
  ensureSession(employeeId: string, sessionId: string): Promise<boolean>;
  /** G4.S7.T12: refresh a session's updated_at after a message lands ('' = no-op). */
  touchSession(employeeId: string, sessionId: string): Promise<void>;
}

export class PostgresChatHistoryStore implements ChatHistoryStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(options: { pool?: pg.Pool; connectionString?: string } = {}) {
    this.pool =
      options.pool ?? new pg.Pool({ connectionString: options.connectionString });
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.init();
    }
    return this.ready;
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL DEFAULT '',
        speaker_id TEXT NOT NULL DEFAULT '',
        speaker_name TEXT NOT NULL DEFAULT '',
        page TEXT NOT NULL DEFAULT '',
        thinking TEXT NOT NULL DEFAULT '',
        progress JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // G4.S7.T12: every message belongs to a session ('' = legacy flat conversation).
    await this.pool.query(
      `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT ''`,
    );
    // For fast per-employee history listing (oldest-first window).
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS chat_messages_employee_created_idx ON chat_messages (employee_id, created_at)`,
    );
    // For per-session history listings (G4.S7.T12).
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages (employee_id, session_id, created_at)`,
    );
    // G4.S7.T12: the session picker rows.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS chat_sessions_employee_updated_idx ON chat_sessions (employee_id, updated_at DESC)`,
    );
  }

  async saveMessage(msg: {
    employeeId: string;
    role: "user" | "assistant" | "system";
    content: string;
    speakerId?: string;
    speakerName?: string;
    page?: string;
    thinking?: string;
    progress?: Array<Record<string, unknown>>;
    messageId?: string;
    sessionId?: string;
  }): Promise<void> {
    await this.ensureReady();
    const messageId = msg.messageId ?? randomUUID();
    const progress = Array.isArray(msg.progress) ? JSON.stringify(msg.progress) : "[]";
    await this.pool.query(
      `INSERT INTO chat_messages
         (message_id, employee_id, role, content, speaker_id, speaker_name, page, thinking, progress, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (message_id) DO NOTHING`,
      [
        messageId,
        msg.employeeId,
        msg.role,
        msg.content,
        msg.speakerId ?? "",
        msg.speakerName ?? "",
        msg.page ?? "",
        msg.thinking ?? "",
        progress,
        msg.sessionId ?? "",
      ],
    );
  }

  async listMessages(
    employeeId: string,
    sessionId?: string,
    limit = 200,
  ): Promise<PersistedChatMessage[]> {
    await this.ensureReady();
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const where = sessionId === undefined
      ? "employee_id = $1"
      : "employee_id = $1 AND session_id = $2";
    const args = sessionId === undefined ? [employeeId, safeLimit] : [employeeId, sessionId, safeLimit];
    const sql = `SELECT message_id, employee_id, role, content, speaker_id, speaker_name,
                        page, thinking, progress, session_id, created_at
                   FROM (
                     SELECT * FROM chat_messages
                      WHERE ${where}
                      ORDER BY created_at DESC
                      LIMIT $${args.length}
                   ) recent
                  ORDER BY created_at ASC`;
    const res = await this.pool.query(sql, args);
    return res.rows.map((row) => ({
      message_id: row.message_id,
      employee_id: row.employee_id,
      role: row.role as "user" | "assistant" | "system",
      content: row.content ?? "",
      speaker_id: row.speaker_id ?? "",
      speaker_name: row.speaker_name ?? "",
      page: row.page ?? "",
      thinking: row.thinking ?? "",
      progress: Array.isArray(row.progress) ? row.progress : [],
      session_id: row.session_id ?? "",
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }

  async createSession(employeeId: string, title?: string): Promise<string> {
    await this.ensureReady();
    const sessionId = randomUUID();
    await this.pool.query(
      `INSERT INTO chat_sessions (session_id, employee_id, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, employeeId, title ?? ""],
    );
    return sessionId;
  }

  async listSessions(employeeId: string, limit = 10): Promise<ChatSessionSummary[]> {
    await this.ensureReady();
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const sessions: ChatSessionSummary[] = [];
    const toIso = (v: unknown): string =>
      v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";

    // Virtual legacy session: the pre-T12 flat conversation (session_id = '').
    const legacy = await this.pool.query(
      `SELECT COUNT(*)::int AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM chat_messages WHERE employee_id = $1 AND session_id = ''`,
      [employeeId],
    );
    const legacyRow = legacy.rows[0] as { count: number; first_at: unknown; last_at: unknown };
    if (legacyRow.count > 0) {
      sessions.push({
        session_id: "",
        title: LEGACY_SESSION_TITLE,
        created_at: toIso(legacyRow.first_at),
        updated_at: toIso(legacyRow.last_at),
        message_count: legacyRow.count,
      });
    }

    const res = await this.pool.query(
      `SELECT s.session_id, s.title, s.created_at, s.updated_at,
              COUNT(m.message_id)::int AS message_count
         FROM chat_sessions s
         LEFT JOIN chat_messages m ON m.session_id = s.session_id
        WHERE s.employee_id = $1
        GROUP BY s.session_id
        ORDER BY s.updated_at DESC
        LIMIT $2`,
      [employeeId, safeLimit],
    );
    for (const row of res.rows) {
      sessions.push({
        session_id: row.session_id,
        title: row.title ?? "",
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
        message_count: Number(row.message_count) || 0,
      });
    }

    sessions.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return sessions.slice(0, safeLimit);
  }

  async ensureSession(employeeId: string, sessionId: string): Promise<boolean> {
    await this.ensureReady();
    if (sessionId === "") {
      // The virtual legacy session exists when the employee has flat rows.
      const res = await this.pool.query(
        `SELECT 1 FROM chat_messages WHERE employee_id = $1 AND session_id = '' LIMIT 1`,
        [employeeId],
      );
      return res.rows.length > 0;
    }
    const res = await this.pool.query(
      `SELECT 1 FROM chat_sessions WHERE session_id = $1 AND employee_id = $2 LIMIT 1`,
      [sessionId, employeeId],
    );
    return res.rows.length > 0;
  }

  async touchSession(employeeId: string, sessionId: string): Promise<void> {
    await this.ensureReady();
    if (sessionId === "") return; // virtual legacy session has no row to bump
    await this.pool.query(
      `UPDATE chat_sessions SET updated_at = now() WHERE session_id = $1 AND employee_id = $2`,
      [sessionId, employeeId],
    );
  }
}

/** In-memory store — used by tests and as a dev fallback without DATABASE_URL. */
export class MemoryChatHistoryStore implements ChatHistoryStore {
  private messages: PersistedChatMessage[] = [];
  private sessions: Map<string, { session_id: string; employee_id: string; title: string; created_at: string; updated_at: string }> = new Map();
  /** Monotonically increasing clock so rapid creates/touches order deterministically. */
  private lastTickMs = 0;
  private tick(): string {
    const now = Date.now();
    const ts = now > this.lastTickMs ? now : this.lastTickMs + 1;
    this.lastTickMs = ts;
    return new Date(ts).toISOString();
  }

  async saveMessage(msg: {
    employeeId: string;
    role: "user" | "assistant" | "system";
    content: string;
    speakerId?: string;
    speakerName?: string;
    page?: string;
    thinking?: string;
    progress?: Array<Record<string, unknown>>;
    messageId?: string;
    sessionId?: string;
  }): Promise<void> {
    const messageId = msg.messageId ?? randomUUID();
    if (this.messages.some((m) => m.message_id === messageId)) return;
    const session = msg.sessionId ?? "";
    const now = this.tick();
    this.messages.push({
      message_id: messageId,
      employee_id: msg.employeeId,
      role: msg.role,
      content: msg.content,
      speaker_id: msg.speakerId ?? "",
      speaker_name: msg.speakerName ?? "",
      page: msg.page ?? "",
      thinking: msg.thinking ?? "",
      progress: Array.isArray(msg.progress) ? msg.progress : [],
      session_id: session,
      created_at: now,
    });
    this.bumpSession(msg.employeeId, session, now);
  }

  async listMessages(
    employeeId: string,
    sessionId?: string,
    limit = 200,
  ): Promise<PersistedChatMessage[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    return this.messages
      .filter(
        (m) =>
          m.employee_id === employeeId &&
          (sessionId === undefined || m.session_id === sessionId),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-safeLimit);
  }

  async createSession(employeeId: string, title?: string): Promise<string> {
    const sessionId = randomUUID();
    const now = this.tick();
    this.sessions.set(sessionId, {
      session_id: sessionId,
      employee_id: employeeId,
      title: title ?? "",
      created_at: now,
      updated_at: now,
    });
    return sessionId;
  }

  async listSessions(employeeId: string, limit = 10): Promise<ChatSessionSummary[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const rows = new Map<string, ChatSessionSummary>();
    // Real session rows.
    for (const s of this.sessions.values()) {
      if (s.employee_id !== employeeId) continue;
      rows.set(s.session_id, {
        session_id: s.session_id,
        title: s.title,
        created_at: s.created_at,
        updated_at: s.updated_at,
        message_count: 0,
      });
    }
    // Fold messages in (counts + timestamp bumps); legacy '' becomes one row.
    for (const m of this.messages) {
      if (m.employee_id !== employeeId) continue;
      const key = m.session_id;
      let row = rows.get(key);
      if (!row) {
        row = {
          session_id: key,
          title: key === "" ? LEGACY_SESSION_TITLE : "",
          created_at: m.created_at,
          updated_at: m.created_at,
          message_count: 0,
        };
        rows.set(key, row);
      }
      row.message_count += 1;
      if (m.created_at > row.updated_at) row.updated_at = m.created_at;
    }
    return [...rows.values()]
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .slice(0, safeLimit);
  }

  async ensureSession(employeeId: string, sessionId: string): Promise<boolean> {
    if (sessionId === "") {
      return this.messages.some(
        (m) => m.employee_id === employeeId && m.session_id === "",
      );
    }
    const s = this.sessions.get(sessionId);
    return Boolean(s && s.employee_id === employeeId);
  }

  async touchSession(employeeId: string, sessionId: string): Promise<void> {
    if (sessionId === "") return; // virtual legacy session has no row to bump
    const s = this.sessions.get(sessionId);
    if (s && s.employee_id === employeeId) {
      s.updated_at = this.tick();
    }
  }

  private bumpSession(employeeId: string, sessionId: string, at: string): void {
    const s = this.sessions.get(sessionId);
    if (s && s.employee_id === employeeId && at > s.updated_at) {
      s.updated_at = at;
    }
  }
}
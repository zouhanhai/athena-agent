import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Per-user chat history persistence (G4.S7.T11-followup, 2026-08-20).
 *
 * Chat messages were previously kept only in the browser store — a reload
 * (F5) wiped the conversation. This module persists user/assistant turns per
 * employee and lets the frontend restore history on load.
 *
 * Design:
 * - One row per chat message, keyed by (employee_id, message_id).
 * - `speaker_id`/`speaker_name` describe the assistant speaker (agent alias
 *   or "Athena"); user messages carry the employee id as speaker.
 * - `progress` is a JSONB snapshot of tool-progress rows (remote agents);
 *   `thinking` stores the accumulated reasoning text (G4.S7.T11).
 * - Lazy CREATE TABLE IF NOT EXISTS + additive ALTERs, same pattern as the
 *   agent registry / employee store; idempotent, safe on existing DBs.
 */

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
  created_at: string;
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
  }): Promise<void>;
  /** Fetch the most recent `limit` messages for an employee, oldest-first. */
  listMessages(employeeId: string, limit?: number): Promise<PersistedChatMessage[]>;
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
    // For fast per-employee history listing (oldest-first window).
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS chat_messages_employee_created_idx ON chat_messages (employee_id, created_at)`,
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
  }): Promise<void> {
    await this.ensureReady();
    const messageId = msg.messageId ?? randomUUID();
    const progress = Array.isArray(msg.progress) ? JSON.stringify(msg.progress) : "[]";
    await this.pool.query(
      `INSERT INTO chat_messages
         (message_id, employee_id, role, content, speaker_id, speaker_name, page, thinking, progress)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
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
      ],
    );
  }

  async listMessages(
    employeeId: string,
    limit = 200,
  ): Promise<PersistedChatMessage[]> {
    await this.ensureReady();
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const res = await this.pool.query(
      `SELECT message_id, employee_id, role, content, speaker_id, speaker_name,
              page, thinking, progress, created_at
         FROM (
           SELECT * FROM chat_messages
            WHERE employee_id = $1
            ORDER BY created_at DESC
            LIMIT $2
         ) recent
        ORDER BY created_at ASC`,
      [employeeId, safeLimit],
    );
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
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }
}

/** In-memory store — used by tests and as a dev fallback without DATABASE_URL. */
export class MemoryChatHistoryStore implements ChatHistoryStore {
  private messages: PersistedChatMessage[] = [];

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
  }): Promise<void> {
    const messageId = msg.messageId ?? randomUUID();
    if (this.messages.some((m) => m.message_id === messageId)) return;
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
      created_at: new Date().toISOString(),
    });
  }

  async listMessages(
    employeeId: string,
    limit = 200,
  ): Promise<PersistedChatMessage[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    return this.messages
      .filter((m) => m.employee_id === employeeId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-safeLimit);
  }
}
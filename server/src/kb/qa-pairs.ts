/**
 * Q&A pair table (G4.S3.T5).
 *
 * The feedback loop stores every rated answer as a Q&A pair
 * `{question, answer, sources, feedback}` so the answer is reusable (no re-RAG
 * for the same question). Two implementations of the same table semantics:
 *   - `MemoryQaPairStore`     — dev fallback / unit tests
 *   - `PostgresQaPairStore`   — the real `qa_pairs` table (DATABASE_URL)
 *
 * Dedup: `FeedbackService` vector-searches the existing questions (G4.S3.T5,
 * via `QaEmbeddingIndex`) before inserting — a semantically similar question
 * calls `merge` (append answer / aggregate feedback) instead of a new row.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

/** Thumbs up = reinforce (raise confidence), thumbs down = fade (lower it). */
export type FeedbackDirection = "up" | "down";

export function isFeedbackDirection(value: unknown): value is FeedbackDirection {
  return value === "up" || value === "down";
}

/** A source the answer was grounded on. `path`/`wikiPath` point at the wiki page
 *  whose confidence feedback reacts to (only `wiki/**` paths adjust confidence). */
export interface QaSource {
  /** Wiki page path, e.g. "wiki/events/c-day.md". */
  path?: string;
  /** Alias used by RAG search hits (G4.S2.T11) — accepted on feedback input. */
  wikiPath?: string;
  title?: string;
  snippet?: string;
}

export interface QaPair {
  id: string;
  question: string;
  answer: string;
  sources: QaSource[];
  /** Latest user feedback direction (null when never rated). */
  feedback: FeedbackDirection | null;
  created_at: string;
  updated_at: string;
}

export interface QaPairUpsertInput {
  question: string;
  answer: string;
  sources?: QaSource[];
  feedback: FeedbackDirection;
}

export interface QaPairStore {
  /** Insert a new pair, or update the exact-text duplicate in place (no new row). */
  upsert(input: QaPairUpsertInput): Promise<QaPair>;
  /** Merge a semantically-similar new Q&A into an existing pair: append the new
   *  answer, union sources, aggregate the feedback. Falls back to insert. */
  merge(id: string, input: QaPairUpsertInput): Promise<QaPair>;
  findByQuestion(question: string): Promise<QaPair | null>;
  getById(id: string): Promise<QaPair | null>;
  setFeedback(id: string, feedback: FeedbackDirection): Promise<QaPair | null>;
  list(): Promise<QaPair[]>;
  /** Ensure the table exists (Postgres) / no-op (memory). Idempotent. */
  seed(): Promise<void>;
  close(): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeQuestion(question: string): string {
  return question.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Keep the stringish fields of a source, tolerating unknown API shapes. */
export function toSource(value: unknown): QaSource {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.wikiPath === "string" ? { wikiPath: value.wikiPath } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.snippet === "string" ? { snippet: value.snippet } : {}),
  };
}

/** Normalize an arbitrary `sources` body value into `QaSource[]`. */
export function toSources(value: unknown): QaSource[] {
  return Array.isArray(value) ? value.map(toSource) : [];
}

function sourceKey(source: QaSource): string {
  return source.path ?? source.wikiPath ?? source.title ?? "";
}

/** Append a distinct new answer to an existing one (dedup merge keeps both). */
function mergeAnswer(existing: string, incoming: string): string {
  return existing === incoming ? existing : `${existing}\n\n${incoming}`;
}

/** Union two source lists, deduplicating by their identity key. */
function mergeSources(existing: QaSource[], incoming: QaSource[]): QaSource[] {
  const out = [...existing];
  for (const source of incoming) {
    const key = sourceKey(source);
    if (key && out.some((s) => sourceKey(s) === key)) continue;
    out.push(source);
  }
  return out;
}

/** In-memory Q&A registry — used by tests and as a dev fallback. */
export class MemoryQaPairStore implements QaPairStore {
  private readonly byId = new Map<string, QaPair>();
  private readonly byQuestion = new Map<string, QaPair>();

  private setRecord(input: QaPairUpsertInput, existing?: QaPair): QaPair {
    const timestamp = now();
    const record: QaPair = existing
      ? {
          ...existing,
          answer: input.answer,
          sources: input.sources ?? [],
          feedback: input.feedback,
          updated_at: timestamp,
        }
      : {
          id: randomUUID(),
          question: input.question,
          answer: input.answer,
          sources: input.sources ?? [],
          feedback: input.feedback,
          created_at: timestamp,
          updated_at: timestamp,
        };
    this.byId.set(record.id, record);
    this.byQuestion.set(normalizeQuestion(record.question), record);
    return record;
  }

  async upsert(input: QaPairUpsertInput): Promise<QaPair> {
    const existing = this.byQuestion.get(normalizeQuestion(input.question));
    return this.setRecord(input, existing);
  }

  async merge(id: string, input: QaPairUpsertInput): Promise<QaPair> {
    const existing = this.byId.get(id);
    if (!existing) return this.setRecord(input);
    const merged: QaPair = {
      ...existing,
      answer: mergeAnswer(existing.answer, input.answer),
      sources: mergeSources(existing.sources, input.sources ?? []),
      feedback: input.feedback,
      updated_at: now(),
    };
    this.byId.set(id, merged);
    this.byQuestion.set(normalizeQuestion(merged.question), merged);
    return merged;
  }

  async findByQuestion(question: string): Promise<QaPair | null> {
    return this.byQuestion.get(normalizeQuestion(question)) ?? null;
  }

  async getById(id: string): Promise<QaPair | null> {
    return this.byId.get(id) ?? null;
  }

  async setFeedback(id: string, feedback: FeedbackDirection): Promise<QaPair | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const updated: QaPair = { ...existing, feedback, updated_at: now() };
    this.byId.set(id, updated);
    this.byQuestion.set(normalizeQuestion(updated.question), updated);
    return updated;
  }

  async list(): Promise<QaPair[]> {
    return [...this.byQuestion.values()];
  }

  async seed(): Promise<void> {
    // memory registry is seeded via the constructor inputs
  }

  async close(): Promise<void> {
    this.byId.clear();
    this.byQuestion.clear();
  }
}

export interface PostgresQaPairStoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
}

interface QaPairRow {
  id: string;
  question: string;
  answer: string;
  sources: unknown;
  feedback: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToPair(row: QaPairRow): QaPair {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    sources: typeof row.sources === "string" ? (JSON.parse(row.sources) as QaSource[]) : (row.sources as QaSource[]),
    feedback: row.feedback as FeedbackDirection | null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Postgres-backed Q&A table: lazy CREATE TABLE + seed on first use. */
export class PostgresQaPairStore implements QaPairStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(options: PostgresQaPairStoreOptions = {}) {
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.init();
    }
    return this.ready;
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS qa_pairs (
        id TEXT PRIMARY KEY,
        question TEXT UNIQUE NOT NULL,
        answer TEXT NOT NULL,
        sources JSONB NOT NULL DEFAULT '[]',
        feedback TEXT CHECK (feedback IN ('up', 'down')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async seed(): Promise<void> {
    await this.ensureReady();
  }

  async upsert(input: QaPairUpsertInput): Promise<QaPair> {
    await this.ensureReady();
    const result = await this.pool.query<QaPairRow>(
      `INSERT INTO qa_pairs (id, question, answer, sources, feedback)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (question) DO UPDATE SET
         answer = EXCLUDED.answer,
         sources = EXCLUDED.sources,
         feedback = EXCLUDED.feedback,
         updated_at = now()
       RETURNING *`,
      [
        randomUUID(),
        normalizeQuestion(input.question),
        input.answer,
        JSON.stringify(input.sources ?? []),
        input.feedback,
      ],
    );
    return rowToPair(result.rows[0]);
  }

  async merge(id: string, input: QaPairUpsertInput): Promise<QaPair> {
    await this.ensureReady();
    const existing = await this.getById(id);
    if (!existing) return this.upsert(input);
    const answer = mergeAnswer(existing.answer, input.answer);
    const sources = mergeSources(existing.sources, input.sources ?? []);
    const result = await this.pool.query<QaPairRow>(
      `UPDATE qa_pairs
       SET answer = $2, sources = $3, feedback = $4, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, answer, JSON.stringify(sources), input.feedback],
    );
    if (result.rows.length === 0) return this.upsert(input);
    return rowToPair(result.rows[0]);
  }

  async findByQuestion(question: string): Promise<QaPair | null> {
    await this.ensureReady();
    const result = await this.pool.query<QaPairRow>(
      `SELECT * FROM qa_pairs WHERE question = $1`,
      [normalizeQuestion(question)],
    );
    return result.rows[0] ? rowToPair(result.rows[0]) : null;
  }

  async getById(id: string): Promise<QaPair | null> {
    await this.ensureReady();
    const result = await this.pool.query<QaPairRow>(`SELECT * FROM qa_pairs WHERE id = $1`, [id]);
    return result.rows[0] ? rowToPair(result.rows[0]) : null;
  }

  async setFeedback(id: string, feedback: FeedbackDirection): Promise<QaPair | null> {
    await this.ensureReady();
    const result = await this.pool.query<QaPairRow>(
      `UPDATE qa_pairs SET feedback = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, feedback],
    );
    return result.rows[0] ? rowToPair(result.rows[0]) : null;
  }

  async list(): Promise<QaPair[]> {
    await this.ensureReady();
    const result = await this.pool.query<QaPairRow>(`SELECT * FROM qa_pairs ORDER BY created_at`);
    return result.rows.map(rowToPair);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { ReviewReport } from "./review.js";
import type { KbCommunityQuality } from "./community-maintenance.js";
import type { KbRelinkReport } from "./relink/relink-service.js";

/** Which path triggered an audit run. */
export type KbAuditTrigger = "scheduled" | "manual";

/** Stage-2 outcome: graph-vs-disk repairs + report-only findings. */
export interface KbAuditFileCheck {
  repaired: number;
  details: string[];
}

/** Stage-3 outcome: the orphan refinement sweep's removal list. */
export interface KbAuditOrphanSweep {
  scannedDirs: number;
  removed: string[];
  kept: string[];
}

/**
 * One knowledge-base audit run (G4.S8.T15): the three-stage pipeline result.
 * EVERY run — scheduled or manual — persists one identical row via a
 * `KbAuditRunsStore` (`kb_audit_runs` in Postgres).
 */
export interface KbAuditRunRecord {
  id: string;
  trigger: KbAuditTrigger;
  /** ISO timestamp when the run started. */
  startedAt: string;
  durationMs: number;
  /** Stage 1 — review/confidence pass (existing reviewAll service). */
  review: ReviewReport;
  /** Stage 2 — WikiPage nodes vs disk md files (both directions). */
  fileCheck: KbAuditFileCheck;
  /** Stage 3 — orphan refinement sweep. */
  orphans: KbAuditOrphanSweep;
  /** G4.S9.T4 community-quality block. Present when the graph source was
   *  wired: a read-only snapshot for weekly audits, the full recompute report
   *  (with changedSinceLast etc.) for manual recompute rows. */
  communities?: KbCommunityQuality;
  /** G4.S10.T3 weekly full-graph re-link report ({trigger:"weekly"}). Present
   *  when the re-link service was wired; absent on skips/failures (a failing
   *  re-link degrades to a fileCheck.details line). */
  relink?: KbRelinkReport;
}

export interface KbAuditRunsStore {
  insert(record: KbAuditRunRecord): Promise<void>;
  /** The most recent run of ANY trigger, or null before the first run. */
  latest(): Promise<KbAuditRunRecord | null>;
  /** The most recent run with the given trigger, or null. */
  latestByTrigger(trigger: KbAuditTrigger): Promise<KbAuditRunRecord | null>;
  /** Recent runs, newest first. */
  list(limit?: number): Promise<KbAuditRunRecord[]>;
  close(): Promise<void>;
}

/** In-memory runs store (tests + non-Postgres deployments). */
export class MemoryKbAuditRunsStore implements KbAuditRunsStore {
  private readonly records: KbAuditRunRecord[] = [];

  async insert(record: KbAuditRunRecord): Promise<void> {
    this.records.push(record);
  }

  async latest(): Promise<KbAuditRunRecord | null> {
    return this.records.length > 0 ? this.records[this.records.length - 1] : null;
  }

  async latestByTrigger(trigger: KbAuditTrigger): Promise<KbAuditRunRecord | null> {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (this.records[i].trigger === trigger) return this.records[i];
    }
    return null;
  }

  async list(limit = 50): Promise<KbAuditRunRecord[]> {
    return [...this.records]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, Math.max(1, limit));
  }

  async close(): Promise<void> {}
}

export interface PostgresKbAuditRunsStoreOptions {
  pool?: pg.Pool;
  connectionString?: string;
}

const INSERT_SQL = `
  INSERT INTO kb_audit_runs
    (id, trigger, started_at, duration_ms, review, file_check, orphans, communities, relink)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

const SELECT_COLUMNS =
  "id, trigger, started_at, duration_ms, review, file_check, orphans, communities, relink";

function rowToRecord(row: { get(key: string): unknown }): KbAuditRunRecord {
  return {
    id: String(row.get("id")),
    trigger: row.get("trigger") === "manual" ? "manual" : "scheduled",
    startedAt: new Date(row.get("started_at") as string).toISOString(),
    durationMs: Number(row.get("duration_ms") ?? 0),
    review: row.get("review") as ReviewReport,
    fileCheck: row.get("file_check") as KbAuditFileCheck,
    orphans: row.get("orphans") as KbAuditOrphanSweep,
    ...(row.get("communities")
      ? { communities: row.get("communities") as KbCommunityQuality }
      : {}),
    ...(row.get("relink")
      ? { relink: row.get("relink") as KbRelinkReport }
      : {}),
  };
}

/**
 * Postgres-backed audit-run table: lazy CREATE TABLE on first use (the same
 * pattern as the Q&A / mapping stores). Serves BOTH report storage and the
 * scheduler's last-run persistence (restart mid-week never double-runs).
 */
export class PostgresKbAuditRunsStore implements KbAuditRunsStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(options: PostgresKbAuditRunsStoreOptions = {}) {
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
      CREATE TABLE IF NOT EXISTS kb_audit_runs (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
        started_at TIMESTAMPTZ NOT NULL,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        review JSONB NOT NULL DEFAULT '{}'::jsonb,
        file_check JSONB NOT NULL DEFAULT '{"repaired":0,"details":[]}'::jsonb,
        orphans JSONB NOT NULL DEFAULT '{"scannedDirs":0,"removed":[],"kept":[]}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // G4.S9.T4 migration for tables created before the community block existed.
    await this.pool.query(
      `ALTER TABLE kb_audit_runs ADD COLUMN IF NOT EXISTS communities JSONB`,
    );
    // G4.S10.T3 migration: the weekly full-graph re-link report block.
    await this.pool.query(
      `ALTER TABLE kb_audit_runs ADD COLUMN IF NOT EXISTS relink JSONB`,
    );
  }

  async insert(record: KbAuditRunRecord): Promise<void> {
    await this.ensureReady();
    await this.pool.query(INSERT_SQL, [
      record.id ?? randomUUID(),
      record.trigger,
      record.startedAt,
      record.durationMs,
      JSON.stringify(record.review),
      JSON.stringify(record.fileCheck),
      JSON.stringify(record.orphans),
      record.communities ? JSON.stringify(record.communities) : null,
      record.relink ? JSON.stringify(record.relink) : null,
    ]);
  }

  async latest(): Promise<KbAuditRunRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM kb_audit_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? rowToRecord(row as unknown as { get(key: string): unknown }) : null;
  }

  async latestByTrigger(trigger: KbAuditTrigger): Promise<KbAuditRunRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM kb_audit_runs WHERE trigger = $1 ORDER BY started_at DESC LIMIT 1`,
      [trigger],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row as unknown as { get(key: string): unknown }) : null;
  }

  async list(limit = 50): Promise<KbAuditRunRecord[]> {
    await this.ensureReady();
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM kb_audit_runs ORDER BY started_at DESC LIMIT $1`,
      [Math.max(1, limit)],
    );
    return result.rows.map((row) =>
      rowToRecord(row as unknown as { get(key: string): unknown }),
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Default runs store: Postgres when DATABASE_URL is set, else in-memory. */
export function defaultKbAuditRunsStore(): KbAuditRunsStore {
  const connectionString = process.env.DATABASE_URL;
  return connectionString
    ? new PostgresKbAuditRunsStore({ connectionString })
    : new MemoryKbAuditRunsStore();
}

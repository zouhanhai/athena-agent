/**
 * Custom semantic mappings (G4.S3.T6).
 *
 * A user-curated table of colloquial/company term → canonical mapping
 * (e.g. "C-Day" → "CALEO Day", "HW" → "Haushaltswaren"), stored in the DB and
 * applied at query time (`expandTerms`) so a colloquial term also matches the
 * canonical text in BM25/vector recall. Complements the Athena-extracted
 * bilingual aliases (G4.S2) with human-authored mappings.
 *
 * Implementations:
 *   - `MemorySemanticMappingStore`    — dev fallback / unit tests
 *   - `PostgresSemanticMappingStore`  — the real `semantic_mappings` table
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

export interface SemanticMapping {
  id: string;
  /** The colloquial/company term, e.g. "C-Day". */
  term: string;
  /** The canonical form the term expands to at query time, e.g. "CALEO Day". */
  canonical: string;
  created_at: string;
  updated_at: string;
}

export interface SemanticMappingInput {
  term: string;
  canonical: string;
}

export interface SemanticMappingStore {
  /** Insert a new mapping or update the canonical of an existing term. */
  upsert(input: SemanticMappingInput): Promise<SemanticMapping>;
  list(): Promise<SemanticMapping[]>;
  /** Delete a mapping by id. Returns true when a row was removed. */
  remove(id: string): Promise<boolean>;
  findByTerm(term: string): Promise<SemanticMapping | null>;
  /** Ensure the table exists (Postgres) / no-op (memory). Idempotent. */
  seed(): Promise<void>;
  close(): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeTerm(term: string): string {
  return term.trim();
}

/** Replace every colloquial term in `query` with its canonical form
 *  (case-insensitive, word-boundary). Unknown terms and the canonical forms
 *  themselves are left untouched, so repeated expansion is idempotent. */
export function expandTerms(query: string, mappings: SemanticMapping[]): string {
  let out = query;
  for (const mapping of mappings) {
    const term = mapping.term.trim();
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), mapping.canonical);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toMapping(value: unknown, id: string): SemanticMapping {
  const obj = isRecord(value) ? value : {};
  const timestamp = now();
  return {
    id,
    term: String(obj.term ?? ""),
    canonical: String(obj.canonical ?? ""),
    created_at: obj.created_at ? String(obj.created_at) : timestamp,
    updated_at: timestamp,
  };
}

/** In-memory semantic mapping registry — used by tests and as a dev fallback. */
export class MemorySemanticMappingStore implements SemanticMappingStore {
  private readonly byId = new Map<string, SemanticMapping>();
  private readonly byTerm = new Map<string, string>();

  private setRecord(input: SemanticMappingInput, existing?: SemanticMapping): SemanticMapping {
    const timestamp = now();
    const record: SemanticMapping = existing
      ? { ...existing, canonical: input.canonical, updated_at: timestamp }
      : {
          id: randomUUID(),
          term: normalizeTerm(input.term),
          canonical: input.canonical,
          created_at: timestamp,
          updated_at: timestamp,
        };
    this.byId.set(record.id, record);
    this.byTerm.set(normalizeTerm(record.term), record.id);
    return record;
  }

  async upsert(input: SemanticMappingInput): Promise<SemanticMapping> {
    const term = normalizeTerm(input.term);
    const existingId = this.byTerm.get(term);
    const existing = existingId ? this.byId.get(existingId) : undefined;
    return this.setRecord(input, existing);
  }

  async list(): Promise<SemanticMapping[]> {
    return [...this.byId.values()];
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.byId.get(id);
    if (!existing) return false;
    this.byId.delete(id);
    this.byTerm.delete(normalizeTerm(existing.term));
    return true;
  }

  async findByTerm(term: string): Promise<SemanticMapping | null> {
    const id = this.byTerm.get(normalizeTerm(term));
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async seed(): Promise<void> {
    // memory registry needs no table setup.
  }

  async close(): Promise<void> {
    this.byId.clear();
    this.byTerm.clear();
  }
}

export interface PostgresSemanticMappingStoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
}

interface SemanticMappingRow {
  id: string;
  term: string;
  canonical: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToMapping(row: SemanticMappingRow): SemanticMapping {
  return {
    id: row.id,
    term: row.term,
    canonical: row.canonical,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Postgres-backed semantic mapping table: lazy CREATE TABLE on first use. */
export class PostgresSemanticMappingStore implements SemanticMappingStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(options: PostgresSemanticMappingStoreOptions = {}) {
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
      CREATE TABLE IF NOT EXISTS semantic_mappings (
        id TEXT PRIMARY KEY,
        term TEXT UNIQUE NOT NULL,
        canonical TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async seed(): Promise<void> {
    await this.ensureReady();
  }

  async upsert(input: SemanticMappingInput): Promise<SemanticMapping> {
    await this.ensureReady();
    const result = await this.pool.query<SemanticMappingRow>(
      `INSERT INTO semantic_mappings (id, term, canonical)
       VALUES ($1, $2, $3)
       ON CONFLICT (term) DO UPDATE SET
         canonical = EXCLUDED.canonical,
         updated_at = now()
       RETURNING *`,
      [randomUUID(), normalizeTerm(input.term), input.canonical],
    );
    return rowToMapping(result.rows[0]!);
  }

  async list(): Promise<SemanticMapping[]> {
    await this.ensureReady();
    const result = await this.pool.query<SemanticMappingRow>(
      `SELECT * FROM semantic_mappings ORDER BY term`,
    );
    return result.rows.map(rowToMapping);
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureReady();
    const result = await this.pool.query(`DELETE FROM semantic_mappings WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async findByTerm(term: string): Promise<SemanticMapping | null> {
    await this.ensureReady();
    const result = await this.pool.query<SemanticMappingRow>(
      `SELECT * FROM semantic_mappings WHERE term = $1`,
      [normalizeTerm(term)],
    );
    return result.rows[0] ? rowToMapping(result.rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Convenience adapter: keep an arbitrary object list searchable by term. */
export function toMappingList(value: unknown): SemanticMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const obj = isRecord(entry) ? entry : {};
      return {
        id: String(obj.id ?? `mapping-${index}`),
        term: String(obj.term ?? ""),
        canonical: String(obj.canonical ?? ""),
        created_at: String(obj.created_at ?? ""),
        updated_at: String(obj.updated_at ?? ""),
      };
    })
    .filter((m) => m.term.trim().length > 0);
}

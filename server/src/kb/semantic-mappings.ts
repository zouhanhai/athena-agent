/**
 * Custom semantic mappings (G4.S3.T6).
 *
 * A user-curated table of colloquial/company term → canonical mapping
 * (e.g. "C-Day" → "CALEO Day", "HW" → "Haushaltswaren"), stored in the DB and
 * applied at query time (`expandTerms`) so a colloquial term also matches the
 * canonical text in BM25/vector recall. Complements the Athena-extracted
 * bilingual aliases (G4.S2) with human-authored mappings.
 *
 * One-to-many (added 2026-08-12): a term can map to MULTIPLE canonical forms
 * (e.g. `EDay` → `Expert Day`, `Principle Day`). The store keeps them as an
 * array (`semantic_mappings.canonical TEXT[]`) and `expandTerms` expands a
 * matched term into an OR alternative (`EDay` → `(Expert Day OR Principle Day)`)
 * so BM25/vector recall any of the canonicals. A single canonical still
 * expands plainly (backward-compatible).
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
  /** The canonical forms the term expands to at query time, e.g. ["CALEO Day"].
   *  One-to-many (G4.S3.T6): a term may expand to several canonicals. */
  canonicals: string[];
  created_at: string;
  updated_at: string;
}

export interface SemanticMappingInput {
  term: string;
  /** Backward-compatible single input: a canonical form, possibly comma- or
   *  `/`-separated (split into the canonicals array). Ignored when
   *  `canonicals` is provided. */
  canonical?: string;
  /** One-to-many input (G4.S3.T6): explicit canonical list. */
  canonicals?: string[];
}

export interface SemanticMappingStore {
  /** Insert a new mapping or update the canonicals of an existing term. */
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

/** Split a canonical input (comma- or `/`-separated) into a deduped list of
 *  canonical forms (G4.S3.T6 one-to-many). */
export function parseCanonicals(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(/[,/]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Normalize a mapping record's canonical field (TEXT[] in the store) into a
 *  string list, tolerating a legacy single-string value. */
function toCanonicals(value: { canonical?: unknown; canonicals?: unknown }): string[] {
  const raw =
    Array.isArray(value.canonicals) && (value.canonicals as unknown[]).length > 0
      ? (value.canonicals as unknown[])
      : value.canonical;
  if (Array.isArray(raw)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw) {
      const trimmed = String(entry ?? "").trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  }
  return parseCanonicals(String(raw ?? ""));
}

function resolveCanonicals(input: SemanticMappingInput): string[] {
  const source =
    Array.isArray(input.canonicals) && input.canonicals.length > 0
      ? input.canonicals.join(",")
      : (input.canonical ?? "");
  return parseCanonicals(source);
}

/** Replace every colloquial term in `query` with its canonical form(s)
 *  (case-insensitive, word-boundary). A term mapping to several canonicals
 *  expands to an OR alternative — `EDay` → `(Expert Day OR Principle Day)` —
 *  so BM25/vector recall any of them; a single canonical expands plainly
 *  (backward-compatible). Unknown terms and the canonical forms themselves are
 *  left untouched, so repeated expansion is idempotent. */
export function expandTerms(query: string, mappings: SemanticMapping[]): string {
  let out = query;
  for (const mapping of mappings) {
    const term = mapping.term.trim();
    if (!term) continue;
    const canonicals = toCanonicals(mapping);
    if (canonicals.length === 0) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replacement =
      canonicals.length === 1 ? canonicals[0]! : `(${canonicals.join(" OR ")})`;
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), replacement);
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
    canonicals: toCanonicals(obj),
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
      ? { ...existing, canonicals: resolveCanonicals(input), updated_at: timestamp }
      : {
          id: randomUUID(),
          term: normalizeTerm(input.term),
          canonicals: resolveCanonicals(input),
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
  canonical: string[] | string;
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
    canonicals: toCanonicals(row),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Postgres-backed semantic mapping table: lazy CREATE TABLE on first use.
 *  The canonical column is `TEXT[]` (one-to-many, G4.S3.T6); a legacy table
 *  created with a single `TEXT` canonical is migrated in place. */
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
        canonical TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.migrateLegacyColumn();
  }

  /** Best-effort migration for tables created before the one-to-many change
   *  (canonical was a single TEXT): widen it to TEXT[] so existing rows keep
   *  working and the new array writes succeed. */
  private async migrateLegacyColumn(): Promise<void> {
    try {
      const res = await this.pool.query<{ data_type: string; udt_name: string }>(
        `SELECT data_type, udt_name FROM information_schema.columns
         WHERE table_name = 'semantic_mappings' AND column_name = 'canonical'`,
      );
      const column = res.rows[0];
      if (column && column.data_type !== "ARRAY" && column.udt_name !== "_text") {
        await this.pool.query(
          `ALTER TABLE semantic_mappings ALTER COLUMN canonical TYPE TEXT[] USING ARRAY[canonical]`,
        );
      }
    } catch {
      // best-effort — a locked/missing table never blocks mapping CRUD.
    }
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
      [randomUUID(), normalizeTerm(input.term), resolveCanonicals(input)],
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
        canonicals: toCanonicals(obj),
        created_at: String(obj.created_at ?? ""),
        updated_at: String(obj.updated_at ?? ""),
      };
    })
    .filter((m) => m.term.trim().length > 0);
}

/**
 * DDIC (SAP Data Dictionary) table-structure parser (G4.S8.T9).
 *
 * SAP table structures are NOT prose: they arrive as a JSON array of table
 * descriptors (what an SAP-side MCP pull or RFC `DDIF_FIELDINFO_GET` produces).
 * This module validates + normalizes that JSON locally and deterministically —
 * no LLM, no docling. The platform never calls SAP; it only consumes the JSON.
 *
 * Chunking happens in the store façade (`store/ddic.ts`), mirroring the other
 * code channels: one header chunk per table + one chunk per ~20-field group.
 */
export interface DdicField {
  /** Field name, e.g. `MATNR`. */
  name: string;
  /** Key indicator (part of the table key). */
  key?: boolean;
  /** ABAP data type (CHAR / CLNT / DATS / DEC / UNIT / ...). */
  dataType?: string;
  /** Output length (informational). */
  length?: number;
  /** The data element (e.g. `MATNR`) — the semantic field reference. */
  dataElement?: string;
  /** The domain (e.g. `MATNR` / `DATUM`). */
  domain?: string;
  /** Field description (e.g. "Material Number"). */
  description?: string;
}

/** A foreign-key edge from one table to a checked table (e.g. MARA.MTART → T134). */
export interface DdicForeignKey {
  /** The local field carrying the foreign key (e.g. `MTART`). */
  field?: string;
  /** The checked/foreign table (e.g. `T134`). */
  table: string;
  description?: string;
}

/** A single DDIC table structure descriptor. */
export interface DdicTable {
  /** Table technical name, e.g. `MARA`. */
  name: string;
  /** Table description ("General Material Data"). Optional — `false`-ish tolerated. */
  description?: string;
  /** Fields in DD03L order. Unknown extra field attributes are ignored. */
  fields: DdicField[];
  /** Foreign-key checks to referenced tables. Optional. */
  foreignKeys?: DdicForeignKey[];
}

interface RawTable {
  name?: unknown;
  description?: unknown;
  fields?: unknown;
  foreignKeys?: unknown;
}

interface RawField {
  name?: unknown;
  key?: unknown;
  dataType?: unknown;
  length?: unknown;
  dataElement?: unknown;
  domain?: unknown;
  description?: unknown;
}

interface RawForeignKey {
  field?: unknown;
  table?: unknown;
  description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeField(raw: RawField): DdicField {
  const out: Partial<DdicField> = {};
  const name = asString(raw.name);
  const key = asBoolean(raw.key);
  const dataType = asString(raw.dataType);
  const length = asNumber(raw.length);
  const dataElement = asString(raw.dataElement);
  const domain = asString(raw.domain);
  const description = asString(raw.description);
  if (name) out.name = name;
  if (key !== undefined) out.key = key;
  if (dataType) out.dataType = dataType;
  if (length !== undefined) out.length = length;
  if (dataElement) out.dataElement = dataElement;
  if (domain) out.domain = domain;
  if (description) out.description = description;
  // `name` is validated non-empty by callers (normalizeTable throws on a
  // missing field name), so the narrowed object satisfies DdicField.
  return out as DdicField;
}

function normalizeForeignKey(raw: RawForeignKey): DdicForeignKey | undefined {
  const table = asString(raw.table);
  if (!table) return undefined;
  const out: DdicForeignKey = { table };
  const field = asString(raw.field);
  const description = asString(raw.description);
  if (field) out.field = field;
  if (description) out.description = description;
  return out;
}

function normalizeTable(raw: RawTable, index: number): DdicTable {
  const name = asString(raw.name);
  if (!name) {
    throw new Error(`DDIC table descriptor at index ${index} is missing its "name"`);
  }
  if (!Array.isArray(raw.fields)) {
    throw new Error(`DDIC table "${name}" (index ${index}) has no "fields" array`);
  }

  const fields: DdicField[] = [];
  for (const [fi, fieldRaw] of raw.fields.entries()) {
    if (!isRecord(fieldRaw)) {
      throw new Error(`DDIC table "${name}" (index ${index}) field #${fi} is not an object`);
    }
    const field = normalizeField(fieldRaw as RawField);
    if (!field.name) {
      throw new Error(`DDIC table "${name}" (index ${index}) field #${fi} is missing "name"`);
    }
    fields.push(field);
  }

  let foreignKeys: DdicForeignKey[] | undefined;
  if (raw.foreignKeys !== undefined) {
    if (!Array.isArray(raw.foreignKeys)) {
      throw new Error(`DDIC table "${name}" (index ${index}) "foreignKeys" must be an array`);
    }
    foreignKeys = [];
    for (const fkRaw of raw.foreignKeys) {
      const fk = isRecord(fkRaw) ? normalizeForeignKey(fkRaw as RawForeignKey) : undefined;
      if (fk) foreignKeys.push(fk);
    }
  }

  const out: DdicTable = { name, fields };
  const description = asString(raw.description);
  if (description) out.description = description;
  if (foreignKeys) out.foreignKeys = foreignKeys;
  return out;
}

/**
 * Validate + normalize the JSON array of DDIC table descriptors. Tolerant of
 * unknown extra attributes and missing descriptions; throws a clear error
 * naming the offending table/field on structurally malformed input.
 */
export function parseDdicTables(content: string): DdicTable[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`DDIC intake JSON is invalid: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("DDIC intake content must be a JSON array of table descriptors");
  }
  return parsed.map((raw, i) => {
    if (!isRecord(raw)) {
      throw new Error(`DDIC table descriptor at index ${i} is not an object`);
    }
    return normalizeTable(raw as RawTable, i);
  });
}
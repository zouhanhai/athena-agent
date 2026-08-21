/**
 * DDIC store façade for SAP table-structure intake (G4.S8.T9).
 *
 * SAP table structures are NOT prose — they arrive as a JSON array of table
 * descriptors whose semantic boundary is the table itself. Like the CDS/ABAP
 * code channels, there is NO document-to-markdown arrange: `storeDdicOutput`
 * writes the parsed tables in the SAME downstream shape the wiki/RAG/Neo4j
 * storage consumes — a `chunks.json` of `RefinementChunk`s plus a `markdown.md`
 * (rendered field documentation) — so storage and retrieval work unchanged.
 * No LLM, no docling: purely local and deterministic.
 *
 * Chunk `heading_path` is overloaded to carry the table identity:
 *   header chunk  → `<TABLE>/_header`
 *   field groups  → `<TABLE>/fields/<n>` (~20 fields per group)
 * which mirrors the other code-channel chunk shapes (RefinementChunk reuse).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DdicTable, DdicField } from "../codeparse/ddic.js";
import { codeTopic, defaultCodeOutputDir, type CodeProvenance, type CodeStoreOptions } from "./code.js";
import type { RefinementChunk, RefinementFrontmatter, RefinementEntity, RefinementRelation } from "../../agents/refine-document.js";
import type { RefineOutputRef } from "../../agents/refine-output.js";

/** A DDIC table rendered as a chunk, extending the standard RefinementChunk
 *  shape with the parsed table metadata so downstream enrichment/QA can use it.
 *  `heading_path` carries the table identity (`<TABLE>/_header` or
 *  `<TABLE>/fields/<n>`). */
export interface DdicCodeChunk extends RefinementChunk {
  /** The table's technical name, e.g. `MARA`. */
  tableName: string;
  /** Whether this is the table header chunk or a field-group chunk. */
  kind: "header" | "fields";
  /** The fields carried by this chunk (all fields on a header, the ~20-field
   *  group on a field chunk). */
  fields: DdicField[];
  /** 1-based field-group index (present on `kind === "fields"` chunks). */
  groupIndex?: number;
  /** Foreign keys to referenced tables (present on header chunks). */
  foreignKeys?: DdicTable["foreignKeys"];
}

export interface DdicStoreResult {
  /** RefineOutputRef-shaped ref consumed by the llm_wiki + Neo4j ingest stages. */
  ref: RefineOutputRef;
  /** Absolute path of the stored `chunks.json`. */
  chunks_ref: string;
  /** Absolute path of the stored `markdown.md`. */
  md_ref: string;
  /** Number of chunks stored (headers + field groups). */
  chunk_count: number;
  /** The chunks (header + ~20-field groups per table). */
  chunks: DdicCodeChunk[];
  /** Table technical names, in source order. */
  names: string[];
}

/** ~20 fields per field-group chunk (G4.S8.T9 chunk-splitting contract). */
const FIELD_GROUP_SIZE = 20;

/** SAP canonical uppercase form of an entity name — the same nameUpper MERGE
 *  rule as the other code channels (G4.S8.T8), so DDIC Table nodes join the
 *  bare CDS/ABAP `MARA` references already in the graph. */
function canonicalCodeName(name: string): string {
  return name.trim().toUpperCase();
}

/** Render parsed DDIC tables as RefinementChunk-shaped chunks: one header chunk
 *  per table (`path = <TABLE>/_header`, text = name + description + key-field
 *  list) + one chunk per ~20 fields (`path = <TABLE>/fields/<n>`). Pure. */
export function ddicTablesToChunks(tables: DdicTable[]): DdicCodeChunk[] {
  const chunks: DdicCodeChunk[] = [];
  let id = 1;
  for (const table of tables) {
    // --- header chunk: name + description + key-field list ---
    const keyFields = table.fields.filter((f) => f.key).map((f) => f.name);
    const headerLines = [`# ${table.name}`];
    if (table.description) headerLines.push(table.description);
    if (keyFields.length > 0) headerLines.push(`Key fields: ${keyFields.join(", ")}`);
    if (table.foreignKeys && table.foreignKeys.length > 0) {
      headerLines.push(
        `Foreign keys: ${table.foreignKeys.map((fk) => `${fk.field ?? "?"} → ${fk.table}`).join(", ")}`,
      );
    }
    chunks.push({
      id: `ddic-${id++}`,
      text: headerLines.join("\n\n"),
      heading_path: `${table.name}/_header`,
      tableName: table.name,
      kind: "header",
      fields: table.fields,
      ...(table.foreignKeys ? { foreignKeys: table.foreignKeys } : {}),
    });

    // --- field-group chunks: ~20 fields per chunk ---
    const groupCount = Math.ceil(table.fields.length / FIELD_GROUP_SIZE);
    for (let g = 0; g < groupCount; g += 1) {
      const groupFields = table.fields.slice(g * FIELD_GROUP_SIZE, (g + 1) * FIELD_GROUP_SIZE);
      chunks.push({
        id: `ddic-${id++}`,
        text: renderFieldGroupText(table.name, groupFields),
        heading_path: `${table.name}/fields/${g + 1}`,
        tableName: table.name,
        kind: "fields",
        fields: groupFields,
        groupIndex: g + 1,
      });
    }
  }
  return chunks;
}

/** Markdown list of fields within one field-group chunk. */
function renderFieldGroupText(tableName: string, fields: DdicField[]): string {
  const rows = fields.map((f) => {
    const parts = [`**${f.name}**`];
    if (f.key) parts.push("(key)");
    const type = f.dataType ? `${f.dataType}${f.length ? `(${f.length})` : ""}` : undefined;
    if (type) parts.push(`\`${type}\``);
    if (f.dataElement) parts.push(`data element \`${f.dataElement}\``);
    if (f.description) parts.push(`— ${f.description}`);
    return `- ${parts.join(" ")}`;
  });
  return `## ${tableName} fields\n\n${rows.join("\n")}`;
}

// --- DDIC knowledge-graph mapping (G4.S8.T9) ---------------------------------

interface DdicGraphAccumulator {
  entities: RefinementEntity[];
  relations: RefinementRelation[];
  entitySeen: Set<string>;
  relationSeen: Set<string>;
}

function newDdicGraph(): DdicGraphAccumulator {
  return { entities: [], relations: [], entitySeen: new Set(), relationSeen: new Set() };
}

/** Push a deduped entity (canonical-uppercase name so the global nameUpper MERGE
 *  finds the node). External FK targets MUST be emitted too — relation edges
 *  MATCH by nameUpper and are silently dropped when an endpoint is missing. */
function addDdicEntity(acc: DdicGraphAccumulator, name: string, type: string, description: string): void {
  const canonical = canonicalCodeName(name);
  if (!canonical || acc.entitySeen.has(canonical)) return;
  acc.entitySeen.add(canonical);
  acc.entities.push({ name: canonical, type, description });
}

/** Push a deduped relation whose endpoints match the emitted entities by their
 *  uppercase nameUpper; `keywords` carries the relationship keyword. */
function addDdicRelation(
  acc: DdicGraphAccumulator,
  source: string,
  target: string,
  keywords: string[],
  description: string,
): void {
  const src = canonicalCodeName(source);
  const tgt = canonicalCodeName(target);
  if (!src || !tgt) return;
  const key = `${src}|${keywords.join(",")}|${tgt}`;
  if (acc.relationSeen.has(key)) return;
  acc.relationSeen.add(key);
  acc.relations.push({ source: src, target: tgt, keywords, description });
}

/** The canonical lowercase `type` for table entities (G4.S8.T12 normalization:
 *  T9 emitted `Table` while T8 emitters use lowercase kinds — align on the T8
 *  lowercase set so the code browser groups every table under one type). */
export const TABLE_ENTITY_TYPE = "table";

/** Build the DDIC knowledge-graph slice: one `table` entity per submitted table
 *  + one per foreign-key target (external included), with `REFERENCES` edges.
 *  Local + deterministic; no LLM. */
export function ddicTablesToGraph(tables: DdicTable[]): { entities: RefinementEntity[]; relations: RefinementRelation[] } {
  const acc = newDdicGraph();
  for (const table of tables) {
    addDdicEntity(acc, table.name, TABLE_ENTITY_TYPE, `SAP table ${table.name}`);
    for (const fk of table.foreignKeys ?? []) {
      addDdicEntity(acc, fk.table, TABLE_ENTITY_TYPE, `SAP table ${fk.table}`);
      addDdicRelation(acc, table.name, fk.table, ["REFERENCES"], `${table.name} REFERENCES ${fk.table}`);
    }
  }
  return { entities: acc.entities, relations: acc.relations };
}

/** The wiki-page body for a DDIC source: per-table field documentation with
 *  provenance frontmatter so answers distinguish current/active tables. */
export function renderDdicMarkdown(tables: DdicTable[], provenance?: CodeProvenance): string {
  const meta: string[] = [
    "---",
    "type: code",
    `topic: ${codeTopic(provenance)}`,
    ...(provenance?.system ? [`system: ${provenance.system}`] : []),
    ...(provenance?.devclass ? [`devclass: ${provenance.devclass}`] : []),
    ...(provenance?.transport ? [`transport: ${provenance.transport}`] : []),
    "---",
  ];
  const sections = tables.map((t) => {
    const lines = [`## ${t.name}`];
    if (t.description) lines.push(t.description);
    lines.push("", "| Field | Key | Type | Data element | Domain | Description |", "| --- | --- | --- | --- | --- | --- |");
    for (const f of t.fields) {
      lines.push(
        `| ${f.name} | ${f.key ? "X" : ""} | ${f.dataType ?? ""}${f.length ? `(${f.length})` : ""} | ${f.dataElement ?? ""} | ${f.domain ?? ""} | ${f.description ?? ""} |`,
      );
    }
    if (t.foreignKeys && t.foreignKeys.length > 0) {
      lines.push("", "**Foreign keys**");
      for (const fk of t.foreignKeys) {
        lines.push(`- ${fk.field ?? "?"} → ${fk.table}${fk.description ? ` — ${fk.description}` : ""}`);
      }
    }
    return lines.join("\n");
  });
  return `${meta.join("\n")}\n\n# DDIC Tables\n\n${sections.join("\n\n")}\n`;
}

/**
 * Persist a parsed DDIC source: write one `chunks.json` (RefinementChunk[]
 * shape: one header chunk + ~20-field group chunks per table) and a `markdown.md`
 * holding the rendered table documentation as a durable artifact. Returns the
 * ref the wiki/Neo4j consumers read. Local, deterministic, no LLM.
 */
export async function storeDdicOutput(
  tables: DdicTable[],
  options: CodeStoreOptions = {},
): Promise<DdicStoreResult> {
  const chunks = ddicTablesToChunks(tables);
  const stem = (options.stem ?? tables[0]?.name ?? "ddic").replace(/[^A-Za-z0-9._-]+/g, "-");
  const storageDir = options.storageDir ?? (process.env.CODE_OUTPUT_DIR ?? defaultCodeOutputDir());
  const dir = join(storageDir, stem);
  const mdPath = join(dir, "markdown.md");
  const chunksPath = join(dir, "chunks.json");
  const mkdirImpl = options.mkdir ?? (async (path: string) => void (await mkdir(path, { recursive: true })));
  const writeFileImpl =
    options.writeFile ?? ((path: string, content: string) => writeFile(path, content, "utf8"));

  await mkdirImpl(dir);
  const markdown = renderDdicMarkdown(tables, options.provenance);
  await writeFileImpl(chunksPath, JSON.stringify(chunks, null, 2));
  await writeFileImpl(mdPath, markdown);

  const frontmatter: RefinementFrontmatter = { type: "code", topic: codeTopic(options.provenance) };
  const graph = ddicTablesToGraph(tables);
  const ref: RefineOutputRef = {
    md_ref: mdPath,
    rag_md_ref: mdPath,
    chunks_ref: chunksPath,
    preview: markdown.slice(0, 140),
    char_count: markdown.length,
    line_count: markdown.split("\n").length,
    header_count: tables.length,
    chunk_count: chunks.length,
    frontmatter,
    entities: graph.entities,
    relations: graph.relations,
    keywords: [],
    quality: { complete: chunks.length > 0, confidence: 1, issues: [], action: "auto_accept" },
    summary: `DDIC source with ${chunks.length} chunk(s) across ${tables.length} table(s): ${tables.map((t) => t.name).join(", ")}`,
    sections: [],
    mode: "single",
    section_paths: [],
  };

  return { ref, chunks_ref: chunksPath, md_ref: mdPath, chunk_count: chunks.length, chunks, names: tables.map((t) => t.name) };
}
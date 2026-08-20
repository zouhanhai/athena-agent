/**
 * Code-store façade for CDS-view intake (G4.S8.T3).
 *
 * SAP CDS views are NOT prose — they arrive as DDL source and their semantic
 * boundary is syntax-guaranteed (`define view ... }`). Unlike the docling path
 * there is NO document-to-markdown arrange: `parseCdsViews` locally splits the
 * source into one chunk per view and this module writes the result in the SAME
 * downstream shape the wiki/RAG/Neo4j storage consumes — a `chunks.json` of
 * `RefinementChunk`s plus a `markdown.md` — so storage and retrieval work
 * unchanged. No LLM, no docling: purely local and deterministic.
 *
 * Chunk `heading_path` is overloaded to carry the view identity —
 * `dataCategory/technicalName` (e.g. `Master Data/I_CnsldtnSubitem_2`) instead
 * of a markdown heading chain — which is exactly the "path" the ticket's
 * RefinementChunk reuse contract calls for.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CdsView } from "../codeparse/cds.js";
import type { AbapUnit, AbapObjectType, AbapDependency } from "../codeparse/abap.js";
import type { Ui5Unit, Ui5UnitKind, Ui5EntityRef } from "../codeparse/ui5.js";
import type { RefinementChunk, RefinementFrontmatter } from "../../agents/refine-document.js";
import type { RefineOutputRef } from "../../agents/refine-output.js";

/** Lineage of a code object: which SAP system / package / transport the code
 *  came from (mandatory for trust — the remote agent pulls it via MCP). */
export interface CodeProvenance {
  system?: string;
  devclass?: string;
  transport?: string;
}

/** A CDS view rendered as a chunk, extending the standard RefinementChunk shape
 *  with the parsed view metadata so downstream enrichment/QA can use it. */
export interface CdsCodeChunk extends RefinementChunk {
  /** The view's technical name, e.g. `I_CnsldtnSubitem_2`. */
  technicalName: string;
  /** Data category hint (Master Data / Transaction Data / Dimension / unknown). */
  dataCategory: string;
  /** Source table/entity references from `as select from`. */
  sourceTables: string[];
  /** Association clauses declared on the view. */
  associations: Array<{ name: string; target: string }>;
}

export interface CodeStoreOptions {
  /** Sub-directory name under the storage root (default: the first view's name). */
  stem?: string;
  /** Explicit storage root. Default: `defaultCodeOutputDir()`. */
  storageDir?: string;
  /** Code lineage carried into the wiki frontmatter (G4.S8.T3 provenance). */
  provenance?: CodeProvenance;
  /** Injectable mkdir for tests (default: fs mkdir recursive). */
  mkdir?: (path: string) => Promise<void>;
  /** Injectable writeFile for tests. */
  writeFile?: (path: string, content: string) => Promise<void>;
}

export interface CodeStoreResult {
  /** RefineOutputRef-shaped ref consumed by the llm_wiki + Neo4j ingest stages. */
  ref: RefineOutputRef;
  /** Absolute path of the stored `chunks.json`. */
  chunks_ref: string;
  /** Absolute path of the stored `markdown.md`. */
  md_ref: string;
  /** Number of view chunks stored. */
  chunk_count: number;
  /** The per-view chunks (one per `define view ... }`). */
  chunks: CdsCodeChunk[];
  /** View technical names, in source order. */
  names: string[];
}

/** Default code-intake storage root. Override with REFINEMENT_OUTPUT_DIR. */
export function defaultCodeOutputDir(): string {
  return process.env.REFINEMENT_OUTPUT_DIR ?? join(homedir(), "athena-data", "code");
}

/** Render parsed CDS views as RefinementChunk-shaped chunks (one per view), with
 *  heading_path = `dataCategory/technicalName`. Pure — no storage side effects. */
export function cdsViewsToChunks(views: CdsView[]): CdsCodeChunk[] {
  return views.map((v, i) => ({
    id: `cds-${i + 1}`,
    text: v.rawText,
    heading_path: `${v.dataCategory}/${v.technicalName}`,
    technicalName: v.technicalName,
    dataCategory: v.dataCategory,
    sourceTables: v.sourceTables,
    associations: v.associations,
  }));
}

/** The wiki-page body for a CDS source: per-view DDL sections with provenance
 *  frontmatter so answers can distinguish current/active objects. */
export function renderCodeMarkdown(views: CdsView[], provenance?: CodeProvenance): string {
  const meta: string[] = [
    "---",
    "type: code",
    "topic: cds",
    ...(provenance?.system ? [`system: ${provenance.system}`] : []),
    ...(provenance?.devclass ? [`devclass: ${provenance.devclass}`] : []),
    ...(provenance?.transport ? [`transport: ${provenance.transport}`] : []),
    "---",
  ];
  const body = views.map((v) => v.rawText.trim()).filter(Boolean).join("\n\n");
  return `${meta.join("\n")}\n\n# CDS Views\n\n${body}\n`;
}

/**
 * Persist a parsed CDS source: write one `chunks.json` (RefinementChunk[] shape,
 * one entry per view with path = dataCategory/technicalName) and a `markdown.md`
 * holding every view's DDL text as a durable artifact. Returns the ref the
 * wiki/Neo4j consumers read. Local, deterministic, no LLM.
 */
export async function storeCodeOutput(
  _source: string,
  views: CdsView[],
  options: CodeStoreOptions = {},
): Promise<CodeStoreResult> {
  const chunks = cdsViewsToChunks(views);
  const stem = (options.stem ?? views[0]?.technicalName ?? "cds").replace(/[^A-Za-z0-9._-]+/g, "-");
  const storageDir = options.storageDir ?? (process.env.CODE_OUTPUT_DIR ?? defaultCodeOutputDir());
  const dir = join(storageDir, stem);
  const mdPath = join(dir, "markdown.md");
  const chunksPath = join(dir, "chunks.json");
  const mkdirImpl = options.mkdir ?? (async (path: string) => void (await mkdir(path, { recursive: true })));
  const writeFileImpl =
    options.writeFile ?? ((path: string, content: string) => writeFile(path, content, "utf8"));

  await mkdirImpl(dir);
  const markdown = renderCodeMarkdown(views, options.provenance);
  await writeFileImpl(chunksPath, JSON.stringify(chunks, null, 2));
  await writeFileImpl(mdPath, markdown);

  const frontmatter: RefinementFrontmatter = { type: "code", topic: "cds" };
  const ref: RefineOutputRef = {
    md_ref: mdPath,
    rag_md_ref: mdPath,
    chunks_ref: chunksPath,
    preview: markdown.slice(0, 140),
    char_count: markdown.length,
    line_count: markdown.split("\n").length,
    header_count: views.length,
    chunk_count: chunks.length,
    frontmatter,
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: chunks.length > 0, confidence: 1, issues: [], action: "auto_accept" },
    summary: `CDS source with ${chunks.length} view(s): ${views.map((v) => v.technicalName).join(", ")}`,
    sections: [],
    mode: "single",
    section_paths: [],
  };

  return { ref, chunks_ref: chunksPath, md_ref: mdPath, chunk_count: chunks.length, chunks, names: views.map((v) => v.technicalName) };
}

// --- ABAP code intake (G4.S8.T4) ---------------------------------------------

/** An ABAP unit rendered as a chunk, extending the standard RefinementChunk
 *  shape with the parsed unit metadata so downstream enrichment/QA can use it.
 *  `heading_path` carries the unit path `<devclass>/<devName>[/<method>]`. */
export interface AbapCodeChunk extends RefinementChunk {
  /** The ABAP object type (class/report/function/include/form). */
  objectType: AbapObjectType;
  /** Object name, e.g. `zcl_fi_delivery`. */
  devName: string;
  /** Method/form/function name for a sub-chunk; null for top-level units. */
  method: string | null;
  /** The unit path `<devclass>/<devName>[/<method>]`. */
  modulePath: string;
  /** Locally-extracted dependency edges (feed the relations contract). */
  dependencies: AbapDependency[];
}

export interface AbapCodeStoreResult {
  ref: RefineOutputRef;
  chunks_ref: string;
  md_ref: string;
  chunk_count: number;
  chunks: AbapCodeChunk[];
  names: string[];
}

/** Render parsed ABAP units as RefinementChunk-shaped chunks (one per unit),
 *  with heading_path = `<devclass>/<devName>[/<method>]`. Pure. */
export function abapUnitsToChunks(units: AbapUnit[]): AbapCodeChunk[] {
  return units.map((u) => ({
    id: u.id,
    text: u.text,
    heading_path: u.path,
    objectType: u.objectType,
    devName: u.devName,
    method: u.method,
    modulePath: u.path,
    dependencies: u.dependencies,
  }));
}

/** The wiki-page body for an ABAP source: per-unit sections with provenance
 *  frontmatter so answers can distinguish current/active objects. */
export function renderAbapMarkdown(units: AbapUnit[], provenance?: CodeProvenance): string {
  const meta: string[] = [
    "---",
    "type: code",
    "topic: abap",
    ...(provenance?.system ? [`system: ${provenance.system}`] : []),
    ...(provenance?.devclass ? [`devclass: ${provenance.devclass}`] : []),
    ...(provenance?.transport ? [`transport: ${provenance.transport}`] : []),
    "---",
  ];
  const body = units.map((u) => u.text.trim()).filter(Boolean).join("\n\n");
  return `${meta.join("\n")}\n\n# ABAP Source\n\n${body}\n`;
}

/**
 * Persist a parsed ABAP source: write one `chunks.json` (RefinementChunk[]
 * shape, one entry per unit with path = `<devclass>/<devName>[/<method>]`) and a
 * `markdown.md` holding every unit's source as a durable artifact. Returns the
 * ref the wiki/Neo4j consumers read. Local, deterministic, no LLM.
 */
export async function storeAbapOutput(
  units: AbapUnit[],
  options: CodeStoreOptions = {},
): Promise<AbapCodeStoreResult> {
  const chunks = abapUnitsToChunks(units);
  const stem = (options.stem ?? units[0]?.devName ?? "abap").replace(/[^A-Za-z0-9._-]+/g, "-");
  const storageDir = options.storageDir ?? (process.env.CODE_OUTPUT_DIR ?? defaultCodeOutputDir());
  const dir = join(storageDir, stem);
  const mdPath = join(dir, "markdown.md");
  const chunksPath = join(dir, "chunks.json");
  const mkdirImpl = options.mkdir ?? (async (path: string) => void (await mkdir(path, { recursive: true })));
  const writeFileImpl =
    options.writeFile ?? ((path: string, content: string) => writeFile(path, content, "utf8"));

  await mkdirImpl(dir);
  const markdown = renderAbapMarkdown(units, options.provenance);
  await writeFileImpl(chunksPath, JSON.stringify(chunks, null, 2));
  await writeFileImpl(mdPath, markdown);

  const frontmatter: RefinementFrontmatter = { type: "code", topic: "abap" };
  const ref: RefineOutputRef = {
    md_ref: mdPath,
    rag_md_ref: mdPath,
    chunks_ref: chunksPath,
    preview: markdown.slice(0, 140),
    char_count: markdown.length,
    line_count: markdown.split("\n").length,
    header_count: units.length,
    chunk_count: chunks.length,
    frontmatter,
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: chunks.length > 0, confidence: 1, issues: [], action: "auto_accept" },
    summary: `ABAP source with ${chunks.length} unit(s): ${units.map((u) => u.devName).join(", ")}`,
    sections: [],
    mode: "single",
    section_paths: [],
  };

  return { ref, chunks_ref: chunksPath, md_ref: mdPath, chunk_count: chunks.length, chunks, names: units.map((u) => u.devName) };
}

// --- UI5 front-end code intake (G4.S8.T5) -----------------------------------

/** A UI5 business file rendered as a chunk, extending the standard RefinementChunk
 *  shape with the parsed unit metadata. `heading_path` carries the app location
 *  `<component>/<modulePath>[/<method>]`. */
export interface Ui5CodeChunk extends RefinementChunk {
  kind: Ui5UnitKind;
  /** File name without extension (controller/view/manifest name). */
  name: string;
  /** Relative app path of the source file, e.g. `webapp/controller/Report.controller.js`. */
  file: string;
  /** App component namespace, e.g. `com.caleo.consolidation`. */
  component: string;
  /** Method name for a sub-chunk; null for whole-file units. */
  method: string | null;
  /** OData / CDS / backend references extracted locally (feed relations). */
  references: Ui5EntityRef[];
}

export interface Ui5CodeStoreResult {
  ref: RefineOutputRef;
  chunks_ref: string;
  md_ref: string;
  chunk_count: number;
  chunks: Ui5CodeChunk[];
  names: string[];
}

/** Render parsed UI5 units as RefinementChunk-shaped chunks (one per unit),
 *  with heading_path = `<component>/<modulePath>[/<method>]`. Pure. */
export function ui5UnitsToChunks(units: Ui5Unit[]): Ui5CodeChunk[] {
  return units.map((u) => ({
    id: u.id,
    text: u.text,
    heading_path: u.path,
    kind: u.kind,
    name: u.name,
    file: u.file,
    component: u.component,
    method: u.method,
    references: u.references,
  }));
}

/** The wiki-page body for a UI5 source: per-file sections with provenance
 *  frontmatter so answers carry the app / source-version lineage. */
export function renderUi5Markdown(units: Ui5Unit[], provenance?: CodeProvenance): string {
  const meta: string[] = [
    "---",
    "type: code",
    "topic: ui5",
    ...(provenance?.system ? [`system: ${provenance.system}`] : []),
    ...(provenance?.devclass ? [`devclass: ${provenance.devclass}`] : []),
    ...(provenance?.transport ? [`transport: ${provenance.transport}`] : []),
    "---",
  ];
  const body = units.map((u) => `## ${u.file}\n\n${u.text.trim()}`).join("\n\n");
  return `${meta.join("\n")}\n\n# UI5 Source\n\n${body}\n`;
}

/**
 * Persist a parsed UI5 source: write one `chunks.json` (RefinementChunk[]
 * shape, one entry per unit with path = `<component>/<modulePath>[/<method>]`)
 * and a `markdown.md` holding every file's source as a durable artifact.
 * Returns the ref the wiki/Neo4j consumers read. Local, deterministic, no LLM.
 */
export async function storeUi5Output(
  units: Ui5Unit[],
  options: CodeStoreOptions = {},
): Promise<Ui5CodeStoreResult> {
  const chunks = ui5UnitsToChunks(units);
  const stem = (options.stem ?? units[0]?.name ?? "ui5").replace(/[^A-Za-z0-9._-]+/g, "-");
  const storageDir = options.storageDir ?? (process.env.CODE_OUTPUT_DIR ?? defaultCodeOutputDir());
  const dir = join(storageDir, stem);
  const mdPath = join(dir, "markdown.md");
  const chunksPath = join(dir, "chunks.json");
  const mkdirImpl = options.mkdir ?? (async (path: string) => void (await mkdir(path, { recursive: true })));
  const writeFileImpl =
    options.writeFile ?? ((path: string, content: string) => writeFile(path, content, "utf8"));

  await mkdirImpl(dir);
  const markdown = renderUi5Markdown(units, options.provenance);
  await writeFileImpl(chunksPath, JSON.stringify(chunks, null, 2));
  await writeFileImpl(mdPath, markdown);

  const frontmatter: RefinementFrontmatter = { type: "code", topic: "ui5" };
  const ref: RefineOutputRef = {
    md_ref: mdPath,
    rag_md_ref: mdPath,
    chunks_ref: chunksPath,
    preview: markdown.slice(0, 140),
    char_count: markdown.length,
    line_count: markdown.split("\n").length,
    header_count: units.length,
    chunk_count: chunks.length,
    frontmatter,
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: chunks.length > 0, confidence: 1, issues: [], action: "auto_accept" },
    summary: `UI5 source with ${chunks.length} unit(s): ${units.map((u) => u.name).join(", ")}`,
    sections: [],
    mode: "single",
    section_paths: [],
  };

  return { ref, chunks_ref: chunksPath, md_ref: mdPath, chunk_count: chunks.length, chunks, names: units.map((u) => u.name) };
}

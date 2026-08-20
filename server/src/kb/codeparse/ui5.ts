/**
 * UI5 front-end code parser (G4.S8.T5).
 *
 * UI5 business code lives in a frontend app's `webapp/` folder: controllers
 * (.js/.ts), XML views (view.xml), `.manifest.json`, and `.model.json`. It is
 * NOT prose — boundaries are syntax-guaranteed — so it is chunked locally and
 * deterministically (no docling, no LLM). Each business file becomes one or more
 * `Ui5Unit`s; a large controller (>400 lines) is split at method boundaries.
 *
 * Hard scope boundary: only business code under the app folder is ingested.
 * `node_modules/`, `dist/` and test/build output are explicitly EXCLUDED by the
 * directory walker, so third-party library code never reaches the KB.
 *
 * The output feeds the shared code-store façade which renders RefinementChunk
 * shaped chunks (`path` = `<component>/<modulePath>`) for the same wiki/Neo4j
 * ingest stages as CDS (T3) and ABAP (T4).
 */

export type Ui5UnitKind = "controller" | "view" | "manifest" | "model" | "component" | "js";

export interface Ui5ParseWarning {
  /** Short machine-readable code. */
  code: string;
  message: string;
}

/** A backend/OData reference a UI5 unit binds or calls — the local, deterministic
 *  hook for enrichment (G4.S8.T5). The graph later links UI5 chunk -> CDS view /
 *  ABAP method via these targets even before the target is indexed. */
export interface Ui5EntityRef {
  /** The OData service URI segment, e.g. `/reporting/` or `/odata/consolidation`. */
  service?: string;
  /** The bound entity set / CDS view / backend path, e.g. `CDS_VIEW`. */
  target: string;
  kind: "odata" | "cds" | "backend";
}

/** One chunkable unit of UI5 business source. */
export interface Ui5Unit {
  /** Stable, unique id within the parse (`c1`..). */
  id: string;
  kind: Ui5UnitKind;
  /** File name without extension, e.g. `Report.controller`, `Report.view`. */
  name: string;
  /** Relative app path of the source file, e.g. `webapp/controller/Report.controller.js`. */
  file: string;
  /** App component namespace, e.g. `com.caleo.consolidation`. */
  component: string;
  /** The unit source verbatim (method body incl. signature, or whole file). */
  text: string;
  /** `<component>/<modulePath>[/<method>]` — maps to RefinementChunk.path. */
  path: string;
  /** Method name for a sub-chunk; null for whole-file units. */
  method: string | null;
  /** Locally-extracted OData / CDS / backend references (feed relations). */
  references: Ui5EntityRef[];
  /** Non-fatal parse misses; the unit still emits with partial metadata. */
  warnings: Ui5ParseWarning[];
}

export interface Ui5ParseOptions {
  /** App component namespace (default: derived from manifest `sap.app.id` or "app"). */
  component?: string;
  /** Split controllers into one unit per method when a file exceeds this many lines. */
  largeFileLines?: number;
}

const DEFAULT_LARGE_FILE_LINES = 400;

const EXCLUDED_PART = /(^|\/)(node_modules|dist|coverage|test|tests|__tests__)(\/|$)/;
/** UI5 / JS source file extensions eligible for intake. */
const SOURCE_EXT = /\.(js|ts|jsx|tsx|xml|json)$/i;

/** Classify a file by its name/extension into a UI5 unit kind. */
export function ui5KindFor(filePath: string): Ui5UnitKind | null {
  const base = filePath.split("/").pop() ?? filePath;
  const lower = base.toLowerCase();
  if (/controller\.(js|ts)$/i.test(lower)) return "controller";
  if (/\.view\.xml$/i.test(lower)) return "view";
  if (/\.fragment\.xml$/i.test(lower)) return "view";
  if (lower === "manifest.json") return "manifest";
  if (/\.model\.json$/i.test(lower)) return "model";
  if (lower === "component.js" || lower === "component.ts") return "component";
  if (SOURCE_EXT.test(filePath)) return "js";
  return null;
}

/**
 * Split a controller's source text into one unit per top-level method. The
 * split happens at function/method-declaration boundaries (never mid-statement)
 * so the result is linguistically safe even for a model that is not code-aware.
 *
 * Recognized shapes (classic sap.ui.define controllers and ES classes):
 *   - `name: function (...) { ... },`        (object-literal method)
 *   - `name(...) { ... },`                    (ES shorthand method)
 *   - `name: (a, b) => { ... },`              (arrow)
 *   - `methodName(...) { ... }`               (class method)
 *
 * Each body is captured verbatim including its signature. Falls back to one
 * whole-file unit when no method boundary is found (never loses data).
 */
function splitControllerByMethod(text: string): Array<{ method: string; text: string }> {
  const lines = text.split(/\r?\n/);
  const methods: Array<{ method: string; text: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = METHOD_DECL_RE.exec(line);
    if (m !== null && m[1] !== undefined && m[1] !== "function" && !/^\s*if\b/.test(line)) {
      const methodName = m[1];
      // Confirm there is a `{` opening brace on this or a following line before
      // we treat it as a method body (skip call expressions like `oModel.setData(`).
      const openIdx = findBraceOpen(lines, i, m[0].length);
      if (openIdx !== -1) {
        const closeIdx = findBraceClose(lines, openIdx);
        if (closeIdx !== -1) {
          const body = lines.slice(i, closeIdx + 1).join("\n");
          methods.push({ method: methodName, text: body });
          i = closeIdx + 1;
          continue;
        }
      }
    }
    i += 1;
  }

  return methods;
}

/** A top-level method declaration line: `name: function`, `name(...)`, `name: (`. */
const METHOD_DECL_RE = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*(?:function|\([^)]*\)\s*=>|\([^)]*\)\s*\{)|\([^)]*\)\s*\{)/;

/** Find the index of the opening `{` for a declaration starting at lineIdx. */
function findBraceOpen(lines: string[], lineIdx: number, offset: number): number {
  const line = lines[lineIdx]!;
  const brace = line.indexOf("{", offset > 0 ? offset : 0);
  if (brace !== -1) return lineIdx;
  // `{` may be on the following line (multiline signature).
  let k = lineIdx + 1;
  while (k < lines.length && k < lineIdx + 8) {
    const idx = lines[k]!.indexOf("{");
    if (idx !== -1) return k;
    k += 1;
  }
  return -1;
}

/**
 * Find the index of the line whose `}` closes the brace opened at openLineIdx.
 * Returns -1 if the block never closes (no data is dropped — handled by caller).
 */
function findBraceClose(lines: string[], openLineIdx: number): number {
  let depth = 0;
  let i = openLineIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    i += 1;
  }
  return -1;
}

/** OData service URI references in code/manifest: `/odata/...`, `/reporting/...`,
 *  `serviceUrl: "/..."`, `"uri": "/..."`. */
const SERVICE_URI_RE = /["'`](\/(?:odata|sap|reporting|services?)[A-Za-z0-9_\-/.]*)\/?["'`]/gi;
/** Named UI5 model references: `getModel("reporting")` / `setModel(o, "name")`. */
const MODEL_NAME_RE = /getModel\(\s*["'`]([A-Za-z0-9_\-]+)["'`]\s*\)/gi;
/** Entity-set / CDS-view bindings: `"/CDS_VIEW"`, `"entitySet": "X"`, `path: "/Y"`. */
const ENTITY_SET_RE = /["'`]\/?([A-Z][A-Z0-9_]{2,})\/?["'`]/g;

/**
 * Locally extract OData service + model + entity-set / CDS-view references from a
 * unit's source. Deterministic (no LLM); feeds the relations contract so the
 * graph can link a UI5 chunk to the CDS view / OData entity it binds even before
 * the target is indexed. A unit with no recognizable reference yields [].
 */
export function extractUi5References(text: string): Ui5EntityRef[] {
  const refs: Ui5EntityRef[] = [];
  const seen = new Set<string>();

  // OData service URIs.
  let sm: RegExpExecArray | null;
  const serviceRe = new RegExp(SERVICE_URI_RE.source, "gi");
  while ((sm = serviceRe.exec(text)) !== null) {
    const service = sm[1]!.replace(/^\/|\/$/g, "");
    if (!service) continue;
    const key = `odata|${service}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: "odata", service: `/${service}`, target: service.split("/").pop()! });
  }

  // Named model references (the OData model a controller binds, e.g. "reporting").
  let mm: RegExpExecArray | null;
  const modelRe = new RegExp(MODEL_NAME_RE.source, "gi");
  while ((mm = modelRe.exec(text)) !== null) {
    const model = mm[1]!;
    const key = `odata|${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: "odata", service: `/${model}`, target: model });
  }

  // Entity-set / CDS-view names (uppercase identifier segments like CDS_VIEW).
  let em: RegExpExecArray | null;
  const entRe = new RegExp(ENTITY_SET_RE.source, "g");
  while ((em = entRe.exec(text)) !== null) {
    const ent = em[1]!;
    // Only uppercase/underscore identifiers likely to be entity sets / CDS views.
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(ent)) continue;
    const key = `ent|${ent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: "cds", target: ent });
  }

  return refs;
}

/**
 * Parse a map of UI5 app files (relative POSIX path -> source text) into
 * chunkable units. The directory walker is expected to supply only business
 * files (the caller excludes node_modules/dist) but this parser ALSO refuses
 * any path that is not a recognized business source, so third-party code can
 * never sneak through even if the walker is permissive.
 */
export function parseUi5Units(files: Record<string, string>, options: Ui5ParseOptions = {}): Ui5Unit[] {
  const component = options.component ?? "app";
  const largeLines = options.largeFileLines ?? DEFAULT_LARGE_FILE_LINES;
  const units: Ui5Unit[] = [];
  let idCounter = 0;

  const emit = (u: Omit<Ui5Unit, "id" | "warnings" | "references"> & { warnings?: Ui5ParseWarning[] }): void => {
    idCounter += 1;
    units.push({ id: `c${idCounter}`, warnings: [], references: extractUi5References(u.text), ...u });
  };

  for (const [relPath, content] of Object.entries(files)) {
    // Refuse third-party / generated output by path segment.
    if (EXCLUDED_PART.test(relPath)) continue;
    const kind = ui5KindFor(relPath);
    if (kind === null) continue;
    // Skip empty / whitespace-only files (nothing to ingest).
    if (content.trim().length === 0) continue;

    // modulePath = the file path relative to the app root (webapp/) without ext.
    const withoutWebapp = relPath.replace(/^webapp\//, "");
    const base = withoutWebapp.split("/").pop() ?? withoutWebapp;
    const noExt = base.replace(/\.(js|ts|jsx|tsx|xml|json)$/i, "");
    const name = noExt;
    const dirs = withoutWebapp.split("/").slice(0, -1).join("/");
    const modulePath = dirs ? `${dirs}/${name}` : name;

    const makePath = (m: string | null): string =>
      m ? `${component}/${modulePath}/${m}` : `${component}/${modulePath}`;

    if (kind === "controller") {
      const lineCount = content.split(/\r?\n/).length;
      if (lineCount > largeLines) {
        const split = splitControllerByMethod(content);
        if (split.length > 0) {
          for (const s of split) {
            emit({
              kind,
              name,
              file: relPath,
              component,
              text: s.text,
              path: makePath(s.method),
              method: s.method,
            });
          }
          continue;
        }
      }
      // Short controller, or no method boundary found — keep the whole file.
      emit({
        kind,
        name,
        file: relPath,
        component,
        text: content,
        path: makePath(null),
        method: null,
      });
      continue;
    }

    // view / manifest / model / component / generic js: one unit per file.
    emit({
      kind,
      name,
      file: relPath,
      component,
      text: content,
      path: makePath(null),
      method: null,
    });
  }

  return units;
}

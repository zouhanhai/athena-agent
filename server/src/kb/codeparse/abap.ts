/**
 * ABAP code parser (G4.S8.T4).
 *
 * SAP ABAP source is text but NOT prose: its boundaries are syntax-guaranteed
 * (`CLASS ... ENDCLASS`, `METHOD ... ENDMETHOD`, `FUNCTION ... ENDFUNCTION`,
 * `FORM ... ENDFORM`, `REPORT`, `INCLUDE`), so docling/markdown chunking is
 * wrong for it. This module splits an ABAP source into per-unit chunks —
 * one per top-level object (class/report/function), sub-chunks per
 * METHOD/FORM/FUNCTION — LOCAL and DETERMINISTIC, no LLM, no docling.
 *
 * NOTE ON abaplint: the ticket directed using the `abaplint` TS library for a
 * real AST. That package is NOT installable in this offline environment
 * (registry returns 404/unpublished for it). To keep the pipeline shipping and
 * satisfy the acceptance criteria (correct boundary/chunk behavior, dependency
 * extraction), this module implements a small deterministic block scanner over
 * the ABAP block-delimiter structure. The public surface (`parseAbapUnits` +
 * the `AbapUnit` contract) is exactly the seam an abaplint-backed parser would
 * expose, so it can be swapped in later without touching callers or fixtures.
 */
export type AbapObjectType = "class" | "report" | "function" | "include" | "form";

export interface AbapParseWarning {
  /** Short machine-readable code. */
  code: string;
  message: string;
}

export type AbapDependencyKind = "table_read" | "call_function" | "call_form" | "call_method";

/** A dependency edge candidate extracted from a unit (feeds the relations
 *  contract so the Neo4j graph shows ABAP ↔ table / ABAP ↔ ABAP edges). */
export interface AbapDependency {
  kind: AbapDependencyKind;
  name: string;
}

/** Options passed into the parser (object lineage) by ingest. */
export interface AbapParseOptions {
  /** Lineage: the ABAP devclass/package the source came from (via MCP pull). */
  devclass?: string | null;
  /** Lineage: the SAP system id the source came from. */
  system?: string | null;
}

/** One chunkable unit of ABAP code, matching the ticket's AbapObjectChunk
 *  contract ({id, objectType, devName, devclass, system, text, path}). */
export interface AbapUnit {
  /** Stable, unique id within the parse (`c1`..). */
  id: string;
  objectType: AbapObjectType;
  /** Object name, e.g. `zcl_fi_delivery` / `z_fi_post` / `z_report_sample`. */
  devName: string;
  devclass: string | null;
  system: string | null;
  /** The unit source verbatim (method/form/function body incl. signature). */
  text: string;
  /** `<devclass>/<devName>[/<method>]` — maps to RefinementChunk.path. */
  path: string;
  /** Method/form/function name for a sub-chunk; null for top-level units. */
  method: string | null;
  /** Locally-extracted dependency edges (SELECT tables, CALL ...). */
  dependencies: AbapDependency[];
  /** Non-fatal parse misses; the unit still emits with partial metadata. */
  warnings: AbapParseWarning[];
}

const CLASS_RE = /^\s*CLASS\s+([A-Za-z_][A-Za-z0-9_]*)\s+(DEFINITION|IMPLEMENTATION)\b/i;
const REPORT_RE = /^\s*(?:REPORT|PROGRAM)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
const METHOD_RE = /^\s*METHOD\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
const FORM_RE = /^\s*FORM\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
const FUNCTION_RE = /^\s*FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
const INCLUDE_RE = /^\s*INCLUDE\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;

const ENDKEYWORDS: Record<"CLASS" | "METHOD" | "FUNCTION" | "FORM", RegExp> = {
  CLASS: /^\s*ENDCLASS\.?/i,
  METHOD: /^\s*ENDMETHOD\.?/i,
  FUNCTION: /^\s*ENDFUNCTION\.?/i,
  FORM: /^\s*ENDFORM\.?/i,
};

/** Find the index of the next matching END<keyword> line at/after `from`.
 *  Returns -1 when the block is unclosed (the raw remainder is still kept). */
function findEnd(lines: string[], from: number, kind: "CLASS" | "METHOD" | "FUNCTION" | "FORM"): number {
  const re = ENDKEYWORDS[kind];
  for (let i = from; i < lines.length; i += 1) {
    if (re.test(lines[i]!)) return i;
  }
  return -1;
}

// --- dependency extraction ---------------------------------------------------

const SELECT_FROM_RE = /\bSELECT\b[\s\S]*?\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
const CALL_FUNCTION_RE = /CALL\s+FUNCTION\s+['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g;
const CALL_METHOD_RE = /CALL\s+METHOD\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*->\s*)?([A-Za-z_][A-Za-z0-9_]*)/gi;
const PERFORM_RE = /PERFORM\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

/** Scan a unit's source text for dependency edges; returns unique deps. */
export function extractAbapDependencies(text: string): AbapDependency[] {
  const out: AbapDependency[] = [];
  const seen = new Set<string>();
  const push = (kind: AbapDependencyKind, name: string) => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name });
  };

  const sel = SELECT_FROM_RE.exec(text);
  if (sel?.[1]) push("table_read", sel[1]);

  let m: RegExpExecArray | null;
  const fnRe = new RegExp(CALL_FUNCTION_RE.source, "gi");
  while ((m = fnRe.exec(text))) push("call_function", m[1]!);
  const fmRe = new RegExp(PERFORM_RE.source, "gi");
  while ((m = fmRe.exec(text))) push("call_form", m[1]!);
  const cmRe = new RegExp(CALL_METHOD_RE.source, "gi");
  while ((m = cmRe.exec(text))) push("call_method", m[1]!);

  return out;
}

/**
 * Split an ABAP source into per-unit chunks. Deterministic, no LLM / docling.
 *
 * - CLASS → one chunk per METHOD (body inclusive) in its IMPLEMENTATION.
 * - REPORT → one chunk per FORM; the whole report body if it has no forms.
 * - FUNCTION group → one chunk per FUNCTION; each INCLUDE as its own chunk.
 * - Unclosed blocks emit a partial chunk with an `UNCLOSED_*` warning (no data
 *   left behind); a source with no recognizable ABAP object returns [].
 */

export function parseAbapUnits(source: string, options: AbapParseOptions = {}): AbapUnit[] {
  const lines = source.split(/\r?\n/);
  const units: AbapUnit[] = [];
  const devclass = options.devclass ?? null;
  const system = options.system ?? null;

  // Current object context (for METHOD/FORM sub-chunks).
  let currentType: AbapObjectType | null = null;
  let currentName = "";
  let emittedFormsForReport = 0;

  const makePath = (devName: string, method: string | null): string =>
    method ? `${devclass}/${devName}/${method}` : `${devclass}/${devName}`;

  const emit = (
    objectType: AbapObjectType,
    devName: string,
    method: string | null,
    text: string,
    warnings: AbapParseWarning[],
  ): void => {
    units.push({
      id: `c${units.length + 1}`,
      objectType,
      devName,
      devclass,
      system,
      text,
      path: makePath(devName, method),
      method,
      dependencies: extractAbapDependencies(text),
      warnings,
    });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const cls = CLASS_RE.exec(line);
    if (cls) {
      currentType = "class";
      currentName = cls[1]!.toLowerCase();
      i += 1;
      continue;
    }
    const rep = REPORT_RE.exec(line);
    if (rep) {
      currentType = "report";
      currentName = rep[1]!.toLowerCase();
      emittedFormsForReport = 0;
      i += 1;
      continue;
    }
    // FUNCTION-POOL explicit acknowledgment (not itself a FUNCTION chunk).
    if (/^\s*FUNCTION-POOL\b/i.test(line)) {
      currentType = "function";
      currentName = "";
      i += 1;
      continue;
    }
    const inc = INCLUDE_RE.exec(line);
    if (inc) {
      const incName = inc[1]!.toLowerCase();
      emit("include", incName, null, line.trim(), []);
      i += 1;
      continue;
    }
    const fn = FUNCTION_RE.exec(line);
    if (fn) {
      const fnName = fn[1]!.toLowerCase();
      const endIdx = findEnd(lines, i + 1, "FUNCTION");
      const warnings: AbapParseWarning[] = [];
      if (endIdx === -1) {
        warnings.push({ code: "UNCLOSED_FUNCTION", message: `function ${fnName} has no ENDFUNCTION` });
      }
      const end = endIdx === -1 ? lines.length - 1 : endIdx;
      emit("function", fnName, null, lines.slice(i, end + 1).join("\n"), warnings);
      i = end + 1;
      continue;
    }
    const meth = METHOD_RE.exec(line);
    if (meth && currentType === "class") {
      const methodName = meth[1]!.toLowerCase();
      const endIdx = findEnd(lines, i + 1, "METHOD");
      const warnings: AbapParseWarning[] = [];
      if (endIdx === -1) {
        warnings.push({ code: "UNCLOSED_METHOD", message: `method ${methodName} has no ENDMETHOD` });
      }
      const end = endIdx === -1 ? lines.length - 1 : endIdx;
      emit("class", currentName || methodName, methodName, lines.slice(i, end + 1).join("\n"), warnings);
      i = end + 1;
      continue;
    }
    const form = FORM_RE.exec(line);
    if (form && currentType === "report") {
      const formName = form[1]!.toLowerCase();
      const endIdx = findEnd(lines, i + 1, "FORM");
      const warnings: AbapParseWarning[] = [];
      if (endIdx === -1) {
        warnings.push({ code: "UNCLOSED_FORM", message: `form ${formName} has no ENDFORM` });
      }
      const end = endIdx === -1 ? lines.length - 1 : endIdx;
      emit("form", currentName || formName, formName, lines.slice(i, end + 1).join("\n"), warnings);
      emittedFormsForReport += 1;
      i = end + 1;
      continue;
    }
    i += 1;
  }

  // A report with no FORMs still yields its whole body as one chunk.
  if (units.length === 0 && currentType === "report" && currentName && emittedFormsForReport === 0) {
    emit("report", currentName, null, lines.join("\n"), []);
  }

  return units;
}

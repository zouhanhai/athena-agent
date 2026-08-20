/**
 * CDS (Core Data Services) DDL parser (G4.S8.T3).
 *
 * SAP CDS views are NOT prose: they arrive as DDL source text (from an SAP system via
 * ADT/SAPRead, or pasted) and their semantic boundary is syntax-guaranteed
 * (`define view ... as select from ... { ... }`). This tiny rule-based parser walks a
 * source containing one-or-many CDS views and emits ONE chunk per view — local,
 * deterministic, no LLM, no docling. Each view's full raw text is ALWAYS retained even
 * when metadata parsing misses (never lose data); misses surface as warnings.
 */
export type CdsDataCategory = "Master Data" | "Transaction Data" | "Dimension" | "unknown";

export interface CdsAssociation {
  /** Association alias (e.g. `_SubitemText`). */
  name: string;
  /** The view/table being associated to (e.g. `I_CnsldtnSubitmTx`). */
  target: string;
}

export interface CdsParseWarning {
  /** Short machine-readable code. */
  code: string;
  message: string;
}

export interface CdsView {
  /** Technical view name, e.g. `I_CnsldtnSubitem_2`. */
  technicalName: string;
  /** 0-based order of the view in the source file. */
  order: number;
  /** The FULL view definition text (annotation header + define … select body … }) —
   *  always present, even when metadata parsing misses. Used as the chunk text. */
  rawText: string;
  /** Field/expression lines captured from the select body. */
  rawMembers: string[];
  /** Source table/entity name referenced by `as select from <...>`. */
  sourceEntityName?: string;
  /** Every source table/entity name referenced by `as select from` (association joins excluded). */
  sourceTables: string[];
  /** Annotation lines (`@...`) that precede the view's define. */
  annotations: string[];
  /** Association clauses declared on the view. */
  associations: CdsAssociation[];
  /** Data category hint (Master/Transaction/Dimension) — best-effort. */
  dataCategory: CdsDataCategory;
  /** Non-fatal parse misses; the view still emits with partial metadata. */
  warnings: CdsParseWarning[];
}

/** A block start boundary: the `define view [entity] <name>` marker. */
const DEFINE_VIEW_RE = /^define\s+view(?:\s+entity)?\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** Annotation header lines: `@AbapCatalog...: 'value'` or `@ObjectModel...: #M`. */
const ANNOTATION_LINE_RE = /^\s*@[A-Za-z0-9_.]+\s*:/;

/** `as select from <source>` — source may be `<table>` or `_entity` with `as <alias>`. */
const SELECT_FROM_RE = /as\s+select\s+from\s+([A-Za-z_][A-Za-z0-9_]*)/i;

const ASSOCIATION_RE = /association\s*\[[^\]]*\]\s*to\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

/** Recognize transaction-ish / master-ish views from their technical name. */
function guessDataCategory(name: string, annotations: string[], sourceTables: string[]): CdsDataCategory {
  const annotationsText = annotations.join(" ").toLowerCase();
  const sources = sourceTables.join(" ").toLowerCase();
  const nameU = name.toUpperCase();

  const transactionTokens = ["item", "posting", "document", "transaction", "amount", "balance", "journal"];
  const masterTokens = ["group", "company", "code", "hierarchy", "text", "master", "fsitem", "subitem", "entity"];

  if (transactionTokens.some((t) => nameU.includes(t.toUpperCase()))) return "Transaction Data";
  if (
    annotationsText.includes("#t") ||
    sources.includes("t") ||
    sources.includes("posting") ||
    sources.includes("item")
  ) {
    return "Transaction Data";
  }
  if (masterTokens.some((t) => nameU.includes(t.toUpperCase()))) return "Master Data";

  // Dimension: small reference/attribute tables (e.g. code lists) otherwise unknown.
  return "unknown";
}

/** Split source line-wise is replaced by a scan that preserves exact raw text spans. */
export function parseCdsViews(source: string): CdsView[] {
  const views: CdsView[] = [];
  const lines = source.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const match = DEFINE_VIEW_RE.exec(lines[i]!);
    if (!match) {
      i += 1;
      continue;
    }

    const technicalName = match[1]!;
    const startLine = i;

    // Find the matching closing brace for the view body. Start brace counting AFTER
    // the define line; the select body `{ ... }` delimits the view.
    let j = i;
    let depth = 0;
    let bodyOpened = false;
    let endLine = -1;
    let sawSemicolon = false;
    for (; j < lines.length; j += 1) {
      const line = lines[j]!;
      for (const ch of line) {
        if (ch === "{") {
          depth += 1;
          bodyOpened = true;
        } else if (ch === "}") {
          depth -= 1;
          if (bodyOpened && depth === 0) {
            endLine = j;
            // consume an optional trailing `;` on the same/next line
            const rest = line.slice(line.indexOf("}") + 1).trim();
            if (rest.startsWith(";")) sawSemicolon = true;
            break;
          }
        }
      }
      if (endLine !== -1) break;
    }

    if (endLine === -1) {
      // Unclosed block: emit the remainder as a view with a warning (no data left behind).
      const rawText = lines.slice(startLine).join("\n");
      const warnings = [{ code: "UNCLOSED_BRACE", message: `view ${technicalName} has no closing '}'` }];
      views.push(
        makeView({
          technicalName,
          order: views.length,
          startLine,
          annotStart: startLine,
          endLineIdx: lines.length - 1,
          lines,
          rawTextOverride: rawText,
          warnings,
        }),
      );
      i = lines.length;
      continue;
    }

    // Annotations documented above the define are part of the view block — count
    // them into the raw text so the chunk carries the full definition (annotations +
    // select + fields).
    const annotStart = annotationStartIndex(lines, startLine);
    const rawLines = lines.slice(annotStart, endLine + 1);
    const rawText = rawLines.join("\n") + (sawSemicolon ? ";" : "");

    views.push(
      makeView({
        technicalName,
        order: views.length,
        startLine,
        annotStart,
        endLineIdx: endLine,
        lines,
        rawTextOverride: rawText,
      }),
    );
    i = endLine + 1;
  }

  return views;
}

interface MakeViewInput {
  technicalName: string;
  order: number;
  startLine: number;
  /** Inclusive first line of the annotation header run (<= startLine). */
  annotStart: number;
  endLineIdx: number;
  lines: string[];
  rawTextOverride: string;
  warnings?: CdsParseWarning[];
}

/** First line index of the contiguous run of `@...` annotation lines above `startLine`. */
function annotationStartIndex(lines: string[], startLine: number): number {
  let k = startLine - 1;
  let first = startLine;
  for (; k >= 0; k -= 1) {
    const line = lines[k]!;
    if (ANNOTATION_LINE_RE.test(line)) {
      first = k;
    } else if (line.trim() === "") {
      continue;
    } else {
      break;
    }
  }
  return first;
}

function makeView(input: MakeViewInput): CdsView {
  const { technicalName, order, startLine, annotStart, endLineIdx, lines, rawTextOverride, warnings = [] } = input;

  const rawLines = lines.slice(startLine, endLineIdx + 1);

  // Annotations = the contiguous `@...` run above the define.
  const annotations: string[] = [];
  for (let k = annotStart; k < startLine; k += 1) {
    const line = lines[k]!;
    if (ANNOTATION_LINE_RE.test(line)) {
      annotations.push(line.trim());
    }
  }

  const bodyText = rawLines.join("\n");

  // Source tables: every distinct `as select from <X>` in the view body.
  const sourceTables: string[] = [];
  const allSelect = SELECT_FROM_RE.exec(bodyText);
  if (allSelect) {
    sourceTables.push(allSelect[1]!);
  }
  const sourceEntityName = allSelect?.[1];

  // Associations.
  const associations: CdsAssociation[] = [];
  let am: RegExpExecArray | null;
  const assocRe = new RegExp(ASSOCIATION_RE.source, "gi");
  while ((am = assocRe.exec(bodyText)) !== null) {
    associations.push({ target: am[1]!, name: am[2]! });
  }
  // Distinct by target+name (ASSOCIATION_RE may re-match overlapping spans).
  const seen = new Set<string>();
  const uniqueAssocs = associations.filter((a) => {
    const key = `${a.name}|${a.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // rawMembers: field/expression lines from the select body (between `{` and the
  // closing `}`), trimmed of braces.
  const rawMembers: string[] = [];
  let inBody = false;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      inBody = true;
      continue;
    }
    if (trimmed.startsWith("}")) {
      inBody = false;
      continue;
    }
    if (inBody && trimmed.length > 0 && !trimmed.startsWith("where")) {
      rawMembers.push(trimmed.replace(/[,;]+$/, ""));
    }
  }

  const dataCategory = guessDataCategory(technicalName, annotations, sourceTables);

  return {
    technicalName,
    order,
    rawText: rawTextOverride,
    rawMembers,
    ...(sourceEntityName ? { sourceEntityName } : {}),
    sourceTables,
    annotations,
    associations: uniqueAssocs,
    dataCategory,
    warnings,
  };
}

/**
 * G4.S10.T7 — header review gate: card model + deterministic markdown rewrite.
 *
 * During the post-parsing pause the reviewer curates the detected heading tree
 * as CARDS. Everything edits a DRAFT of ops (`HeaderEditOp`) against the card
 * model; nothing touches the markdown until approve. This module is the pure
 * core: parse + detect, validate + apply ops, preview, and the IDEMPOTENT
 * markdown rewrite that preserves all non-header content verbatim (heading
 * lines only ever become other heading lines or `**bold**` paragraphs; bodies
 * move whole, byte-for-byte).
 */
import { join } from "node:path";
import {
  DEFAULT_HEADER_GRADING_SOURCES,
  detectTocTree,
  gradeHeadersFromToc,
  type TocNode,
} from "../agents/header-toc.js";
import type { HeaderBlock } from "../agents/refine-output.js";

/** Hard cap for ANY LLM call from the assist surface (aligned with the
 *  66489b8/c7642ce single-read caps): oversized docs are sampled client-side
 *  and this caller refuses more (G4.S10.T7 safety). */
export const HEADER_REVIEW_ASSIST_MAX_CHARS = 48 * 1024;

/** Default minimum heading count before the gate engages (tiny-doc auto-skip). */
export const DEFAULT_HEADER_REVIEW_MIN_HEADERS = 32;

/** The default SAP template-field word list validated on the CDS Views doc. */
export const DEFAULT_HEADER_REVIEW_TEMPLATE_WORDS = [
  "Purpose",
  "Prerequisites",
  "Related Information",
  "More Information",
  "Additional Information",
  "Related Documents",
  "Related Links",
  "See also",
  "Technical Details",
];

/** Thrown when an edit op violates the payload contract (bad index / cycles). */
export class HeaderReviewOpError extends Error {}

/** Thrown when approve/skip is asked on a task not paused in header review. */
export class HeaderReviewNotPendingError extends Error {}

/** Thrown when an assist request exceeds the LLM char cap. */
export class HeaderReviewAssistTooLargeError extends Error {}

// --- card model ---

export interface HeaderReviewCard {
  /** Stable id (`h<index>`); the tree edges reference parents by id. */
  id: string;
  /** Original heading index (0-based) — the identity the md rewrite anchors on. */
  index: number;
  /** Heading text without the '# ' markers (verbatim from the parsed md). */
  text: string;
  /** Original heading level as parsed (1-6). */
  originalLevel: number;
  /** Sibling position at detection time (0-based) — the change baseline. */
  originalOrder: number;
  /** Parent at detection time — structural-change baseline. */
  originalParentId: string | null;
  /** Demoted-to-bold: the heading becomes a `**text**` paragraph in the md. */
  bold: boolean;
  /** Parent card id (null = root level of the document). */
  parentId: string | null;
  /** Ordinal among siblings (0-based, compact). */
  order: number;
  /** Derived tree depth: root children = 1, bold cards = 0. Computed. */
  level: number;
}

export interface HeaderBlockParse {
  /** Content before the first heading, verbatim (may include frontmatter). */
  preamble: string[];
  /** One block per heading line, verbatim (no trimming, fence-aware). */
  blocks: {
    index: number;
    level: number;
    text: string;
    heading: string;
    lines: string[];
  }[];
  /** The line ending style used by the source ("\n" or "\r\n"). */
  newline: string;
}

/** Split markdown into preamble + heading blocks, VERBATIM. Lines inside fenced
 *  code blocks (``` / ~~~) are never treated as headings. Bold-paragraph lines
 *  (`**Text**`) are detected as bold cards — the marker the rewrite emits — so
 *  re-detection after an approve recovers the exact card list (idempotency). */
export function parseHeaderBlocks(markdown: string): HeaderBlockParse {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const preamble: string[] = [];
  const blocks: HeaderBlockParse["blocks"] = [];
  let current: HeaderBlockParse["blocks"][number] | null = null;
  let fence: "```" | "~~~" | null = null;
  for (const line of lines) {
    const fm = /^\s*(```|~~~)/.exec(line);
    if (fm) {
      if (fence === null) fence = fm[1] as "```" | "~~~";
      else if (fence === fm[1]) fence = null;
    }
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    const bold = /^\*\*([^*]+)\*\*$/.exec(line);
    if (!fence && (m || bold)) {
      if (current) blocks.push(current);
      current = m
        ? { index: blocks.length, level: m[1]!.length, text: m[2]!.trim(), heading: line, lines: [] }
        : { index: blocks.length, level: 0, text: bold![1]!.trim(), heading: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) blocks.push(current);
  return { preamble, blocks, newline };
}

const CHIP_COLORS = ["#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca"];

export function levelChipColor(level: number): string {
  return CHIP_COLORS[Math.min(Math.max(level, 1), CHIP_COLORS.length) - 1] ?? CHIP_COLORS[0]!;
}

/** Build the card model from parsed heading blocks: a card's parent = nearest
 *  preceding heading with a LOWER level; ties share the parent (siblings). */
export function cardsFromBlocks(blocks: HeaderBlockParse["blocks"]): HeaderReviewCard[] {
  const stack: HeaderReviewCard[] = [];
  const cards: HeaderReviewCard[] = [];
  for (const block of blocks) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= block.level) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const order = parent
      ? cards.filter((c) => !c.bold && c.parentId === parent.id).length
      : cards.filter((c) => !c.bold && c.parentId === null).length;
    const card: HeaderReviewCard = {
      id: `h${block.index}`,
      index: block.index,
      text: block.text,
      originalLevel: block.level,
      originalOrder: order,
      originalParentId: parent ? parent.id : null,
      bold: block.level === 0,
      parentId: parent ? parent.id : null,
      order,
      // bold cards are not tree nodes — level 0; heading cards: depth.
      level: block.level === 0 ? 0 : parent ? parent.level + 1 : 1,
    };
    cards.push(card);
    // bold cards are never parents; only real headings join the stack
    if (block.level > 0) stack.push(card);
  }
  return cards;
}

/** Build the card model from raw markdown (fence-aware). */
export function cardsFromMarkdown(markdown: string): HeaderReviewCard[] {
  return cardsFromBlocks(parseHeaderBlocks(markdown).blocks);
}

/** Count headings the review would see (fence-aware, bold cards included). */
export function countHeadings(markdown: string): number {
  return parseHeaderBlocks(markdown).blocks.length;
}

/** Recompute level (tree depth) for every card + compact sibling order.
 *  Bold cards are NOT tree nodes: level 0, kept for layout only. */
export function withLevels(cards: HeaderReviewCard[]): HeaderReviewCard[] {
  const byId = new Map(cards.map((c) => [c.id, { ...c }]));
  const compute = (parentId: string | null, depth: number): void => {
    const children = [...byId.values()]
      .filter((c) => !c.bold && c.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.index - b.index);
    children.forEach((child, i) => {
      byId.set(child.id, { ...child, level: depth, order: i });
      compute(child.id, depth + 1);
    });
  };
  compute(null, 1);
  return [...byId.values()]
    .map((c) => (c.bold ? { ...c, level: 0 } : c))
    .sort((a, b) => a.index - b.index);
}

/** The preview tree: nested cards as the reviewer's live result renders
 *  (roots only). Bold cards appear as leaves with `bold: true`. */
export function previewTree(cards: HeaderReviewCard[]): PreviewNode[] {
  const leveled = withLevels(cards);
  const build = (parentId: string | null): PreviewNode[] =>
    leveled
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .map((c) => ({
        id: c.id,
        index: c.index,
        text: c.text,
        level: c.level,
        bold: c.bold,
        children: c.bold ? [] : build(c.id),
      }));
  return build(null);
}

export interface PreviewNode {
  id: string;
  index: number;
  text: string;
  level: number;
  bold: boolean;
  children: PreviewNode[];
}

/** The nested TocNode exported to the refiner on approve (T6 TOC-first grading
 *  treats the curated hierarchy as ground truth). Bold cards are excluded; their
 *  children graft onto the bold card's parent. */
export function cardsToTocNode(cards: HeaderReviewCard[]): TocNode {
  const leveled = withLevels(cards);
  const root: TocNode = { text: "", level: 0, children: [] };
  const byId = new Map<string, TocNode>();
  for (const card of leveled) {
    if (card.bold) continue;
    const node: TocNode = { text: card.text, level: card.level, children: [] };
    byId.set(card.id, node);
    const parentNode = card.parentId === null ? root : byId.get(card.parentId);
    const children = parentNode ? parentNode.children! : root.children!;
    children.push(node);
  }
  return root;
}

/** How many cards differ from their ORIGINAL detection — the "changes: N"
 *  badge. STRUCTURAL only (bold / level / parent): positional slides caused by
 *  another card's reorder are not counted (they are visible via the preview and
 *  undo stack; counting them would flood the badge on huge docs). */
export function countCardChanges(cards: HeaderReviewCard[]): number {
  return cards.filter(
    (c) => c.bold || c.level !== c.originalLevel || c.parentId !== c.originalParentId,
  ).length;
}

// --- draft ops ---

export type HeaderEditOp =
  /** Drag up/down (reorder) or drop ON a card (re-parent): move the card's
   *  SUBTREE under `parentId` at `position` among its children (clamped). */
  | { type: "move"; index: number; parentId: string | null; position: number }
  /** Drag left / outdent: one level up (sibling of its parent, right after it). */
  | { type: "promote"; index: number }
  /** Drag right / indent: one level down (last child of its previous sibling). */
  | { type: "demote"; index: number }
  /** Set an exact level (suggestion chips); clamped to 1..6. */
  | { type: "level"; index: number; level: number }
  /** Demote-to-bold toggle: the heading becomes a `**text**` paragraph. */
  | { type: "bold"; index: number };

function assertCard(cards: HeaderReviewCard[], index: number): HeaderReviewCard {
  const card = cards.find((c) => c.index === index);
  if (!card) {
    throw new HeaderReviewOpError(`no heading with index ${index} in the detected outline`);
  }
  return card;
}

function assertNotDescendant(cards: HeaderReviewCard[], cardId: string, targetId: string | null): void {
  if (targetId === null) return;
  if (targetId === cardId) {
    throw new HeaderReviewOpError("a card cannot be moved under itself");
  }
  let cursor: string | null = targetId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor)) throw new HeaderReviewOpError("cycle in parent chain");
    seen.add(cursor);
    const parent = cards.find((c) => c.id === cursor);
    if (!parent) break;
    if (parent.id === cardId) {
      throw new HeaderReviewOpError("a card cannot be moved under one of its own descendants");
    }
    cursor = parent.parentId;
  }
}

function childrenOf(cards: HeaderReviewCard[], parentId: string | null): HeaderReviewCard[] {
  return cards.filter((c) => !c.bold && c.parentId === parentId).sort((a, b) => a.order - b.order || a.index - b.index);
}

/** Compact every parent's sibling orders (bold cards keep their layout slot). */
function renumber(cards: HeaderReviewCard[]): HeaderReviewCard[] {
  const next = cards.map((c) => ({ ...c }));
  for (const parentId of new Set(next.map((c) => c.parentId))) {
    const siblings = childrenOf(next, parentId);
    const orderMap = new Map(siblings.map((c, i) => [c.id, i]));
    for (const c of next) {
      if (c.bold) continue;
      const o = orderMap.get(c.id);
      if (o !== undefined) c.order = o;
    }
  }
  return next.sort((a, b) => a.index - b.index);
}

/** Canonical single-op application. `applyOps` wraps this with validation. */
function applyOp(cards: HeaderReviewCard[], op: HeaderEditOp): HeaderReviewCard[] {
  switch (op.type) {
    case "move": {
      const card = assertCard(cards, op.index);
      assertNotDescendant(cards, card.id, op.parentId);
      if (op.parentId !== null && !cards.some((c) => c.id === op.parentId)) {
        throw new HeaderReviewOpError(`unknown parent card id "${op.parentId}"`);
      }
      const next = cards.map((c) => ({ ...c }));
      const moved = next.find((c) => c.id === card.id)!;
      const siblings = childrenOf(next, op.parentId).filter((c) => c.id !== moved.id);
      const position = Math.max(0, Math.min(Math.round(op.position), siblings.length));
      siblings.splice(position, 0, { ...moved, parentId: op.parentId });
      const orderMap = new Map(siblings.map((c, i) => [c.id, i]));
      return renumber(next.map((c) => {
        if (c.id === moved.id) return { ...c, parentId: op.parentId, order: orderMap.get(c.id) ?? 0 };
        if (c.bold || c.parentId !== op.parentId) return c;
        return { ...c, order: orderMap.get(c.id) ?? c.order };
      }));
    }
    case "promote": {
      const card = assertCard(cards, op.index);
      if (card.bold || card.parentId === null) return cards; // root / bold: no-op
      const parent = cards.find((c) => c.id === card.parentId)!;
      const parentSiblings = childrenOf(cards, parent.parentId);
      const position = Math.min(parentSiblings.findIndex((c) => c.id === parent.id) + 1, parentSiblings.length);
      return applyOp(cards, { type: "move", index: card.index, parentId: parent.parentId, position });
    }
    case "demote": {
      const card = assertCard(cards, op.index);
      if (card.bold) return cards;
      const siblings = childrenOf(cards, card.parentId);
      const pos = siblings.findIndex((c) => c.id === card.id);
      const previous = pos > 0 ? siblings[pos - 1] : undefined;
      if (!previous) return cards; // first child of its parent → cannot indent
      const prevChildren = childrenOf(cards, previous.id);
      return applyOp(cards, { type: "move", index: card.index, parentId: previous.id, position: prevChildren.length });
    }
    case "level": {
      const card = assertCard(cards, op.index);
      if (card.bold) return cards;
      const target = Math.min(6, Math.max(1, Math.round(op.level)));
      let next = cards;
      let guard = 0;
      while (guard++ < 12) {
        // levels are DERIVED from the tree — recompute after every step so the
        // walk can terminate once the target depth is reached.
        next = withLevels(next);
        const cur = next.find((c) => c.index === op.index)!;
        if (cur.level === target) break;
        const before = next.map((c) => c.parentId);
        next = cur.level < target
          ? applyOp(next, { type: "demote", index: op.index })
          : applyOp(next, { type: "promote", index: op.index });
        const unchanged = next.every((c, i) => c.parentId === before[i]);
        if (unchanged) break; // stuck (e.g. first child cannot indent further)
      }
      return next;
    }
    case "bold": {
      const card = assertCard(cards, op.index);
      let next = cards.map((c) => ({ ...c }));
      const target = next.find((c) => c.id === card.id)!;
      if (card.bold) {
        // un-bold: re-enter the tree at its old slot (grafted children stay put)
        next = next.map((c) => (c.id === card.id ? { ...c, bold: false } : c));
        return renumber(next);
      }
      // bold: children graft onto the bold card's parent; the bold card keeps
      // its sibling slot as a layout position marker
      const position = childrenOf(next, target.parentId).findIndex((c) => c.id === target.id);
      const out: HeaderReviewCard[] = [];
      for (const c of next) {
        if (c.parentId === target.id) out.push({ ...c, parentId: target.parentId });
        else if (c.id !== target.id) out.push(c);
      }
      out.push({ ...target, bold: true, order: position });
      return renumber(out);
    }
  }
}

/** Validate + apply a batch of ops against the card model. Throws
 *  `HeaderReviewOpError` on the first offending op. Levels + sibling orders are
 *  recomputed from the tree on return so callers always read derived state. */
export function applyOps(cards: HeaderReviewCard[], ops: HeaderEditOp[]): HeaderReviewCard[] {
  let next = cards;
  for (const op of ops) {
    next = applyOp(next, op);
  }
  return withLevels(next);
}

// --- deterministic markdown rewrite ---

export interface RewriteResult {
  markdown: string;
  changed: boolean;
}

/** Rewrite the parsed markdown to match the curated card model. IDEMPOTENT:
 *  only heading lines change (level → different '#' run, or `**text**` when
 *  bold); every body line moves with its heading VERBATIM; the preamble is
 *  preserved; bodies are never rewritten. */
export function rewriteMarkdown(markdown: string, cards: HeaderReviewCard[]): RewriteResult {
  const parsed = parseHeaderBlocks(markdown);
  const originalHeadings = new Map(parsed.blocks.map((b) => [b.index, b]));
  const leveled = withLevels(cards);
  const order: HeaderReviewCard[] = [];
  // Pre-order walk: each parent's children (bold + heading cards mixed, sorted
  // by their sibling slot) are emitted in order; bold cards are leaf-emitted.
  const emit = (parentId: string | null): void => {
    for (const card of leveled.filter((c) => c.parentId === parentId).sort((a, b) => a.order - b.order || a.index - b.index)) {
      order.push(card);
      if (!card.bold) emit(card.id);
    }
  };
  emit(null);

  let changed = false;
  const out: string[] = [...parsed.preamble];
  for (const card of order) {
    const block = originalHeadings.get(card.index);
    if (block) {
      if (card.bold) {
        const line = `**${card.text}**`;
        changed ||= block.heading !== line;
        out.push(line, ...block.lines);
      } else {
        const line = `${"#".repeat(card.level)} ${card.text}`;
        changed ||= block.heading !== line;
        out.push(line, ...block.lines);
      }
    } else {
      // bold card already flattened by a previous approve — re-emit marker only
      out.push(card.bold ? `**${card.text}**` : `${"#".repeat(card.level)} ${card.text}`);
    }
  }
  // The split on /\r?\n/ already encodes the input's trailing newline as a
  // phantom "" element in the last block's lines — no manual append here.
  const result = out.join(parsed.newline);
  return { markdown: result, changed };
}

// --- bulk template demotion ---

export interface BulkDemoteResult {
  cards: HeaderReviewCard[];
  applied: HeaderReviewCard[];
  /** Words that matched a card ALREADY demoted to bold (skipped). */
  matchedButAlreadyBold: HeaderReviewCard[];
}

/** Convert every header whose text exactly matches a template word into a bold
 *  paragraph (word list persisted per project). Match is exact, case-sensitive. */
export function applyBulkTemplateDemotion(
  cards: HeaderReviewCard[],
  words: string[],
): BulkDemoteResult {
  const applied: HeaderReviewCard[] = [];
  const matchedButAlreadyBold: HeaderReviewCard[] = [];
  let next = cards;
  for (const raw of words) {
    const word = raw.trim().replace(/\s+/g, " ");
    if (!word) continue;
    const card = next.find((c) => c.text === word && !c.bold);
    if (card) {
      next = applyOps(next, [{ type: "bold", index: card.index }]);
      applied.push(card);
      continue;
    }
    const already = next.find((c) => c.text === word && c.bold);
    if (already) matchedButAlreadyBold.push(already);
  }
  return { cards: next, applied, matchedButAlreadyBold };
}

// --- outline detection merging docling sidecar + T6 match info ---

export interface HeaderTocMatch {
  mode: "toc" | "none";
  source?: string;
  matched?: number;
  total?: number;
}

export interface HeaderReviewOutline {
  cards: HeaderReviewCard[];
  headingCount: number;
  toc?: HeaderTocMatch;
  /** Per-card T6 hint when a TOC was detected: heading index → suggested level.
   *  Offered as one-click chips ("apply TOC levels"), never auto-applied. */
  tocHints?: Record<number, { matched: boolean; suggestedLevel: number }>;
}

/** Detect the reviewable outline: cards from the md + (when present) the
 *  docling outline / TOC match info via the SAME header-toc detection chain
 *  the T6 refinement uses. Never throws — a broken outline just means no hints. */
export async function detectHeaderReviewOutline(
  markdown: string,
  outline: unknown,
): Promise<HeaderReviewOutline> {
  const cardList = cardsFromMarkdown(markdown);
  let toc: HeaderTocMatch | undefined;
  let tocHints: Record<number, { matched: boolean; suggestedLevel: number }> | undefined;
  try {
    const found = await detectTocTree({ markdown, outline }, DEFAULT_HEADER_GRADING_SOURCES);
    if (found) {
      const blocks: HeaderBlock[] = parseHeaderBlocks(markdown).blocks
        .filter((b) => b.level > 0)
        .map((b) => ({
          index: b.index,
          level: b.level,
          text: b.text,
          heading: b.heading,
          body: b.lines.join("\n"),
        }));
      const graded = gradeHeadersFromToc(blocks, found.tree);
      toc = { mode: "toc", source: found.source.name, matched: graded.matched, total: graded.total };
      tocHints = {};
      graded.blocks.forEach((b) => {
        const original = cardList[b.index];
        if (original && b.level !== original.originalLevel) {
          tocHints![b.index] = { matched: true, suggestedLevel: b.level };
        }
      });
      if (Object.keys(tocHints).length === 0) tocHints = undefined;
    }
  } catch {
    toc = undefined;
    tocHints = undefined;
  }
  return {
    cards: cardList,
    headingCount: cardList.length,
    ...(toc ? { toc } : {}),
    ...(tocHints ? { tocHints } : {}),
  };
}

export function defaultHeaderReviewDraftDir(): string {
  return process.env.HEADER_REVIEW_DRAFT_DIR
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", "athena-data", "header-review");
}

// --- Athena assist: bounded prompt + suggestion schema (never auto-applied) ---

export interface AssistHeadingRow {
  index: number;
  text: string;
  level: number;
}

export interface AssistSample {
  headingId: string;
  text: string;
}

/** Extract ≤`maxChars` verbatim body samples for the requested heading indexes
 *  from the parsed markdown (G4.S10.T7 assist — the client never holds bodies,
 *  so the server samples suspicious sections). Collapses whitespace. */
export function sampleSectionsFromMarkdown(
  markdown: string,
  indexes: number[],
  maxChars = 200,
  maxSamples = 60,
): AssistSample[] {
  const { blocks } = parseHeaderBlocks(markdown);
  const byIndex = new Map(blocks.map((b) => [b.index, b]));
  const out: AssistSample[] = [];
  for (const index of indexes) {
    if (out.length >= maxSamples) break;
    const block = byIndex.get(index);
    if (!block) continue;
    const body = block.lines.join("\n").replace(/\s+/g, " ").trim().slice(0, maxChars);
    if (body) out.push({ headingId: String(index), text: body });
  }
  return out;
}

export interface HeaderAssistSuggestion {
  kind: "demote-to-bold" | "set-level" | "reparent";
  targetIds: string[];
  level?: number;
  parentId?: string | null;
  reason: string;
}

/**
 * Build the bounded user content for the assist LLM call: the current heading
 * outline (compact rows) + per-heading text samples, TOTAL never exceeding
 * HEADER_REVIEW_ASSIST_MAX_CHARS (a 600K-token doc is sampled client-side,
 * never shipped whole). Callers refuse requests above the cap.
 */
export function buildAssistPrompt(
  headings: AssistHeadingRow[],
  samples: AssistSample[] = [],
  cap = HEADER_REVIEW_ASSIST_MAX_CHARS,
): { userContent: string; headingsChars: number; samplesChars: number; truncatedSamples: boolean } {
  const lines = [
    "You are a markdown header-curation expert. Suggest concrete edits for the detected heading outline:",
    '- "demote-to-bold": template fields / boilerplate headings (Purpose, Prerequisites, Related Information) that should be bold paragraphs.',
    '- "set-level": headings at the wrong level (misleveled, level jumps, garbage hierarchy).',
    '- "reparent": headings under the wrong parent (moved under the wrong section).',
    "Return STRICT JSON: {\"suggestions\": [{\"kind\": \"demote-to-bold\"|\"set-level\"|\"reparent\", \"targetIds\": [\"<index as string>\"], \"level\": <1-6>, \"parentId\": \"<card id|null>\", \"reason\": \"<why>\"}]}.",
    "",
    "OUTLINE (index, current # level, title):",
    ...headings.map((h) => `${h.index}\t${"#".repeat(Math.max(1, Math.min(6, h.level)))}\t${h.text}`),
  ];
  const outlineBlock = lines.join("\n");
  let samplesBlock = samples.length > 0
    ? `\n\nTEXT SAMPLES (first chars of each section):\n${samples.map((s) => `[${s.headingId}] ${s.text}`).join("\n")}`
    : "";
  let truncatedSamples = false;
  const total = outlineBlock.length + samplesBlock.length;
  if (total > cap) {
    const overflow = total - cap;
    if (samplesBlock.length > overflow) {
      samplesBlock = samplesBlock.slice(0, samplesBlock.length - overflow);
      truncatedSamples = true;
    } else {
      samplesBlock = "";
      truncatedSamples = true;
    }
  }
  return {
    userContent: `${outlineBlock}${samplesBlock}`.slice(0, cap),
    headingsChars: outlineBlock.length,
    samplesChars: samplesBlock.length,
    truncatedSamples,
  };
}

/** The json-schema the assist LLM must emit (refinement judge conventions). */
export const ASSIST_SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["demote-to-bold", "set-level", "reparent"] },
          targetIds: { type: "array", items: { type: "string" } },
          level: { type: "number" },
          parentId: { type: ["string", "null"] },
          reason: { type: "string" },
        },
        required: ["kind", "targetIds", "reason"],
      },
    },
  },
  required: ["suggestions"],
};

/** Parse + validate the assistant's raw JSON into suggestions. Targets must be
 *  real card indexes (unknown/out-of-range targets are dropped). */
export function parseAssistSuggestions(raw: unknown, cardCount: number, cardIndexes: Set<number>): HeaderAssistSuggestion[] {
  if (raw === null || typeof raw !== "object") return [];
  const list = (raw as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return [];
  const isId = (v: unknown): v is string =>
    typeof v === "string" && Number.isInteger(Number(v)) && cardIndexes.has(Number(v));
  const out: HeaderAssistSuggestion[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.kind !== "string" || !["demote-to-bold", "set-level", "reparent"].includes(s.kind)) continue;
    const targetIds = Array.isArray(s.targetIds) ? s.targetIds.filter(isId) : [];
    if (targetIds.length === 0) continue;
    out.push({
      kind: s.kind as HeaderAssistSuggestion["kind"],
      targetIds,
      ...(typeof s.level === "number" && Number.isFinite(s.level)
        ? { level: Math.max(1, Math.min(6, Math.round(s.level))) }
        : {}),
      ...(s.parentId === null || typeof s.parentId === "string" ? { parentId: s.parentId as string | null } : {}),
      reason: typeof s.reason === "string" ? s.reason.slice(0, 200) : "",
    });
  }
  return out;
}

/** Map one suggestion to concrete draft ops (one APPLY chip = one op batch). */
export function suggestionToOps(s: HeaderAssistSuggestion): HeaderEditOp[] {
  switch (s.kind) {
    case "demote-to-bold":
      return s.targetIds.map((id) => ({ type: "bold", index: Number(id) }));
    case "set-level":
      return s.targetIds.map((id) => ({ type: "level", index: Number(id), level: s.level ?? 2 }));
    case "reparent":
      return s.targetIds.map((id) => ({
        type: "move",
        index: Number(id),
        parentId: s.parentId ?? null,
        position: 999999, // clamped to the end of the children list server-side
      }));
  }
}
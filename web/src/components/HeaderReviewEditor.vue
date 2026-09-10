<script setup lang="ts">
/**
 * G4.S10.T7 — header review CARD editor.
 *
 * One card per detected heading: level chip (#/##/###, colored by depth), title,
 * children count, subtree collapse. Gestures (all also available via keyboard +
 * buttons):
 *   - drag vertically (middle zone)  → reorder among siblings
 *   - drop ON a card (right strip)   → re-parent subtree under it
 *   - drag left (left strip)         → promote (outdent) before the target
 * Everything edits a DRAFT (ops) synced to the server; the md is untouched
 * until Approve. Virtualized list (2000+ cards), undo stack, live tree preview,
 * search, Athena assist chips (never auto-applied) and bulk template demotion.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  approveHeaderReview,
  assistHeaderReview,
  getHeaderReviewOutline,
  getHeaderReviewSettings,
  putHeaderReviewDraft,
  putHeaderReviewSettings,
  skipHeaderReview,
  type HeaderAssistSuggestion,
  type HeaderEditOp,
  type HeaderReviewCard,
} from "@/api/kb";

const props = defineProps<{ taskId: string; source: string }>();
const emit = defineEmits<{ close: []; resolved: [kind: "approve" | "skip"] }>();

const ROW_HEIGHT = 36;
const UNDO_CAP = 100;

const outline = ref<Awaited<ReturnType<typeof getHeaderReviewOutline>> | null>(null);
const cards = ref<HeaderReviewCard[]>([]);
const ops = ref<HeaderEditOp[]>([]);
const changes = ref(0);
const loading = ref(true);
const syncing = ref(false);
const error = ref("");
const busyError = ref("");
const isResolving = ref(false);

// --- virtualization ---
const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);

// --- selection / collapse / search ---
const selectedId = ref<string | null>(null);
const collapsed = ref<Set<string>>(new Set());
const query = ref("");
const activeMatch = ref(0);
const matchRows = ref<number[]>([]);

// --- preview / assist / bulk ---
const previewOpen = ref(false);
const assistOpen = ref(false);
const assistLoading = ref(false);
const suggestions = ref<HeaderAssistSuggestion[]>([]);
const appliedSuggestionIds = ref<Set<number>>(new Set());
const bulkOpen = ref(false);
const bulkWords = ref("");
const bulkMatches = ref<HeaderReviewCard[]>([]);
const bulkApplied = ref(0);
const wordsUpdated = ref(false);

// --- undo / redo ---
interface Snapshot {
  cards: HeaderReviewCard[];
  ops: HeaderEditOp[];
  changes: number;
}
const undoStack = ref<Snapshot[]>([]);
const redoStack = ref<Snapshot[]>([]);

// --- dbId of the last PUT we applied (drop stale in-flight responses) ---
let putSeq = 0;

const templateWords = computed(() =>
  bulkWords.value.split(/[\n,;]+/).map((w) => w.trim()).filter(Boolean),
);

/** Pre-order row list (collapsed ancestors hide their subtrees). */
const rows = computed<{ card: HeaderReviewCard; depth: number; index: number }[]>(() => {
  const byId = new Map(cards.value.map((c) => [c.id, c]));
  const hidden = new Set<string>();
  for (const id of collapsed.value) {
    let cursor = byId.get(id);
    while (cursor) {
      for (const c of cards.value) {
        if (c.parentId === cursor.id) hidden.add(c.id);
      }
      const parent = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      cursor = parent;
    }
  }
  const out: { card: HeaderReviewCard; depth: number; index: number }[] = [];
  const q = query.value.trim().toLowerCase();
  const dirt = (c: HeaderReviewCard): boolean =>
    c.bold || c.level !== c.originalLevel || c.parentId !== c.originalParentId;
  let index = 0;
  const visit = (parentId: string | null, depth: number): void => {
    for (const c of [...cards.value]
      .filter((x) => x.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.index - b.index)) {
      if (!hidden.has(c.id) && (!q || c.text.toLowerCase().includes(q) || dirt(c))) {
        out.push({ card: c, depth, index: index++ });
      }
      if (!collapsed.value.has(c.id)) visit(c.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
});

const totalHeight = computed(() => rows.value.length * ROW_HEIGHT);
const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - 12));
const visibleCount = computed(() => Math.ceil((viewport.value?.clientHeight ?? 600) / ROW_HEIGHT) + 24);
const visibleRows = computed(() => rows.value.slice(startIndex.value, startIndex.value + visibleCount.value));

function onScroll(): void {
  scrollTop.value = viewport.value?.scrollTop ?? 0;
}

function scrollToRow(rowIndex: number): void {
  if (!viewport.value) return;
  const target = Math.max(0, rowIndex * ROW_HEIGHT - 60);
  viewport.value.scrollTop = target;
  scrollTop.value = target;
}

/** One card row (for the preview panel). */
function childrenCount(card: HeaderReviewCard): number {
  return cards.value.filter((c) => c.parentId === card.id).length;
}

function chipLabel(card: HeaderReviewCard): string {
  if (card.bold) return "¶";
  return "#".repeat(Math.max(1, Math.min(6, card.level)));
}

function chipColor(card: HeaderReviewCard): string {
  const palette = ["#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca"];
  if (card.bold) return "#9aa4af";
  return palette[Math.min(Math.max(card.level, 1), palette.length) - 1] ?? palette[0]!;
}

function depthColor(depth: number): string {
  const palette = ["", "#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca"];
  return palette[Math.min(Math.max(depth, 0), palette.length - 1)] ?? "";
}

// --- draft sync (server is authoritative) ---

function snapshot(): Snapshot {
  return { cards: cards.value, ops: [...ops.value], changes: changes.value };
}

async function pushOps(newOps: HeaderEditOp[], label: string): Promise<void> {
  if (newOps.length === 0) return;
  error.value = "";
  const undo = snapshot();
  const seq = ++putSeq;
  const all = [...ops.value, ...newOps];
  // optimistic
  ops.value = all;
  syncing.value = true;
  try {
    const result = await putHeaderReviewDraft(props.taskId, all);
    if (seq !== putSeq) return; // a newer PUT already landed
    cards.value = result.cards;
    ops.value = result.ops;
    changes.value = result.changes;
    undoStack.value.push(undo);
    if (undoStack.value.length > UNDO_CAP) undoStack.value.shift();
    redoStack.value = [];
    void label;
  } catch (err) {
    if (seq !== putSeq) return;
    // roll back to the last server-consistent state
    restoreSnapshot(undo);
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    syncing.value = false;
  }
}

function restoreSnapshot(s: Snapshot): void {
  cards.value = s.cards;
  ops.value = s.ops;
  changes.value = s.changes;
}

async function undo(): Promise<void> {
  const last = undoStack.value.pop();
  if (!last) return;
  redoStack.value.push(snapshot());
  restoreSnapshot(last);
  const seq = ++putSeq;
  syncing.value = true;
  try {
    if (last.ops.length > 0) {
      const result = await putHeaderReviewDraft(props.taskId, last.ops);
      if (seq === putSeq) {
        cards.value = result.cards;
        ops.value = result.ops;
        changes.value = result.changes;
      }
    } else {
      const cleared = await putHeaderReviewDraft(props.taskId, []);
      if (seq === putSeq) {
        cards.value = cleared.cards;
        ops.value = [];
        changes.value = cleared.changes;
      }
    }
  } catch (err) {
    if (seq === putSeq) error.value = err instanceof Error ? err.message : String(err);
  } finally {
    syncing.value = false;
  }
}

async function redo(): Promise<void> {
  const next = redoStack.value.pop();
  if (!next) return;
  undoStack.value.push(snapshot());
  restoreSnapshot(next);
  const seq = ++putSeq;
  syncing.value = true;
  try {
    const result = await putHeaderReviewDraft(props.taskId, next.ops);
    if (seq === putSeq) {
      cards.value = result.cards;
      ops.value = result.ops;
      changes.value = result.changes;
    }
  } catch (err) {
    if (seq === putSeq) error.value = err instanceof Error ? err.message : String(err);
  } finally {
    syncing.value = false;
  }
}

// --- editing gestures ---

function cardById(id: string): HeaderReviewCard | undefined {
  return cards.value.find((c) => c.id === id);
}

function siblingsOf(card: HeaderReviewCard): HeaderReviewCard[] {
  return cards.value
    .filter((c) => c.parentId === card.parentId && !c.bold)
    .sort((a, b) => a.order - b.order || a.index - b.index);
}

function moveAmongSiblings(card: HeaderReviewCard, delta: number): void {
  const siblings = siblingsOf(card);
  const pos = siblings.findIndex((c) => c.index === card.index);
  const target = siblings[pos + delta];
  if (!target) return;
  const position = delta < 0 ? target.order : target.order + 1;
  void pushOps([{ type: "move", index: card.index, parentId: card.parentId, position }], "reorder");
}

function promote(card: HeaderReviewCard): void {
  void pushOps([{ type: "promote", index: card.index }], "promote");
}

function demote(card: HeaderReviewCard): void {
  void pushOps([{ type: "demote", index: card.index }], "demote");
}

function toggleBold(card: HeaderReviewCard): void {
  void pushOps([{ type: "bold", index: card.index }], "bold");
}

function moveTo(card: HeaderReviewCard, parentId: string | null, position: number): void {
  void pushOps([{ type: "move", index: card.index, parentId, position }], "move");
}

// --- drag & drop (HTML5) ---

const dragIndex = ref<number | null>(null);
const dragZone = ref<"before" | "after" | "child" | "promote" | null>(null);
const dragTargetId = ref<string | null>(null);
const dropError = ref("");

function onDragStart(event: DragEvent): void {
  const el = (event.target as HTMLElement).closest("[data-card-id]") as HTMLElement | null;
  const id = el?.dataset.cardId;
  if (!id) return;
  dragIndex.value = Number(id);
  dragTargetId.value = null;
  dragZone.value = null;
  event.dataTransfer?.setData("text/plain", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd(): void {
  dragIndex.value = null;
  dragTargetId.value = null;
  dragZone.value = null;
}

function cardCoordsFromEvent(event: DragEvent): { id: string; zone: "before" | "after" | "child" | "promote" } | null {
  const el = (event.target as HTMLElement).closest("[data-card-id]") as HTMLElement | null;
  const id = el?.dataset.cardId;
  if (!id || dragIndex.value === null) return null;
  const rect = el!.getBoundingClientRect();
  const x = event.clientX - rect.left;
  if (x < rect.width * 0.2) return { id, zone: "promote" };
  if (x > rect.width * 0.8) return { id, zone: "child" };
  const y = event.clientY - rect.top;
  return { id, zone: y < rect.height / 2 ? "before" : "after" };
}

function onDragOver(event: DragEvent): void {
  if (dragIndex.value === null) return;
  const target = cardCoordsFromEvent(event);
  if (!target) return;
  if (target.id === String(dragIndex.value)) {
    dragTargetId.value = null;
    dragZone.value = null;
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dragTargetId.value = target.id;
  dragZone.value = target.zone;
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  const dragged = dragIndex.value;
  const targetId = dragTargetId.value;
  const zone = dragZone.value;
  dragIndex.value = null;
  dragTargetId.value = null;
  dragZone.value = null;
  if (dragged === null || !targetId || !zone) return;
  const card = cardById(String(dragged));
  const target = cardById(targetId);
  if (!card || !target) return;
  // self/descendant moves are rejected by the server (cycle guard)
  const isDescendant = (() => {
    let cursor = target.parentId;
    while (cursor !== null) {
      if (cursor === card.id) return true;
      cursor = cardById(cursor)?.parentId ?? null;
    }
    return false;
  })();
  if (isDescendant || target.id === card.id) {
    dropError.value = "A card cannot be moved under itself or its own subtree.";
    setTimeout(() => (dropError.value = ""), 2600);
    return;
  }
  switch (zone) {
    case "before":
      moveTo(card, target.parentId, target.order);
      break;
    case "after":
      moveTo(card, target.parentId, target.order + 1);
      break;
    case "child":
      moveTo(card, target.id, 999999); // clamped to the END of the target's children
      break;
    case "promote":
      moveTo(card, target.parentId, target.order); // sibling before the target (outdent)
      break;
  }
}

// --- keyboard shortcuts (accessible alternative to dragging) ---

function onKeydown(event: KeyboardEvent): void {
  const id = selectedId.value;
  const card = id ? cardById(id) : undefined;
  if (!card) return;
  if (event.altKey) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      moveAmongSiblings(card, event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      promote(card);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      demote(card);
    }
  } else if (event.key === "b" || event.key === "B") {
    if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      toggleBold(card);
    }
  }
}

function selectRow(id: string): void {
  selectedId.value = id;
}

// --- search ---

function runSearch(): void {
  matchRows.value = rows.value
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.card.text.toLowerCase().includes(query.value.trim().toLowerCase()))
    .map(({ i }) => i);
  activeMatch.value = 0;
  if (matchRows.value.length > 0) scrollToRow(matchRows.value[0]!);
}

function nextMatch(): void {
  if (matchRows.value.length === 0) return;
  activeMatch.value = (activeMatch.value + 1) % matchRows.value.length;
  scrollToRow(matchRows.value[activeMatch.value]!);
}

// --- Athena assist (suggestions = APPLY chips, never auto-applied) ---

function isSuspicious(card: HeaderReviewCard): boolean {
  if (card.bold || card.level !== card.originalLevel || card.parentId !== card.originalParentId) return true;
  return templateWords.value.includes(card.text);
}

async function runAssist(): Promise<void> {
  if (assistLoading.value) return;
  assistLoading.value = true;
  error.value = "";
  suggestions.value = [];
  appliedSuggestionIds.value = new Set();
  try {
    // client-side sampling: suspicious cards first, then the rest, ~40K budget
    // (the server enforces the 48K cap on the combined input)
    const titleCap = 40;
    const budget = 40_000;
    const suspicious: { index: number; text: string; level: number }[] = [];
    const rest: { index: number; text: string; level: number }[] = [];
    for (const c of cards.value) {
      const row = { index: c.index, text: c.text.slice(0, titleCap), level: c.level };
      (isSuspicious(c) ? suspicious : rest).push(row);
    }
    const rowsOut: { index: number; text: string; level: number }[] = [];
    let chars = 0;
    for (const row of [...suspicious, ...rest]) {
      const cost = row.text.length + 16;
      if (chars + cost > budget) break;
      rowsOut.push(row);
      chars += cost;
    }
    const sampleIndexes = cards.value.filter(isSuspicious).slice(0, 60).map((c) => c.index);
    const result = await assistHeaderReview(props.taskId, { rows: rowsOut, sampleIndexes });
    suggestions.value = result.suggestions;
    assistOpen.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    assistLoading.value = false;
  }
}

function suggestionOps(s: HeaderAssistSuggestion): HeaderEditOp[] {
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
        position: 999999,
      }));
  }
}

async function applySuggestion(i: number): Promise<void> {
  const s = suggestions.value[i];
  if (!s) return;
  await pushOps(suggestionOps(s), "assist-suggestion");
  const next = new Set(appliedSuggestionIds.value);
  next.add(i);
  appliedSuggestionIds.value = next;
}

// --- bulk template demotion (editable word list, persisted per project) ---

async function loadBulkWords(): Promise<void> {
  try {
    const settings = await getHeaderReviewSettings();
    bulkWords.value = settings.templateWords.join("\n");
  } catch {
    bulkWords.value = "Purpose\nPrerequisites\nRelated Information";
  }
}

function previewBulk(): void {
  const matched: HeaderReviewCard[] = [];
  for (const c of cards.value) {
    if (c.bold) continue;
    if (templateWords.value.some((w) => w === c.text)) matched.push(c);
  }
  bulkMatches.value = matched;
}

async function applyBulk(): Promise<void> {
  const ops: HeaderEditOp[] = bulkMatches.value.map((c) => ({ type: "bold", index: c.index }));
  if (ops.length === 0) return;
  const count = ops.length;
  await pushOps(ops, "bulk-demote");
  bulkMatches.value = [];
  bulkApplied.value = count;
  setTimeout(() => (bulkApplied.value = 0), 2400);
}

async function saveBulkWords(): Promise<void> {
  try {
    await putHeaderReviewSettings({ templateWords: templateWords.value });
    wordsUpdated.value = true;
    setTimeout(() => (wordsUpdated.value = false), 2400);
    previewBulk();
  } catch (err) {
    error.value = `Word list save failed (admin only?): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- resolve ---

function confirmingResolve(kind: "approve" | "skip"): void {
  if (isResolving.value || syncing.value) return;
  const changesText = kind === "approve" && changes.value > 0
    ? `\n\n${changes.value} change(s) will be written back to the parsed markdown (headers only; all bodies stay verbatim).`
    : "";
  const ok = window.confirm(
    kind === "approve"
      ? `Approve this header curation?${changesText}\n\nThe task is released into Athena refinement (TOC-first grading uses your curated hierarchy).`
      : "Skip header review?\n\nThe document continues with the original headers (straight to refinement, no changes).",
  );
  if (!ok) return;
  void resolve(kind);
}

async function resolve(kind: "approve" | "skip"): Promise<void> {
  isResolving.value = true;
  busyError.value = "";
  try {
    if (kind === "approve") {
      const who = window.prompt("Reviewer name (recorded in the header_review report)", "") ?? "";
      await approveHeaderReview(props.taskId, who.trim() || undefined);
    } else {
      await skipHeaderReview(props.taskId);
    }
    emit("resolved", kind);
    emit("close");
  } catch (err) {
    busyError.value = err instanceof Error ? err.message : String(err);
    isResolving.value = false;
  }
}

// --- init ---

onMounted(async () => {
  try {
    const view = await getHeaderReviewOutline(props.taskId);
    outline.value = view;
    cards.value = view.cards;
    ops.value = view.draft?.ops ?? [];
    changes.value = view.changes;
    void loadBulkWords();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

function toggleCollapse(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

/** Flip the main list into the live tree preview (same virtual rows, indented). */
function togglePreview(): void {
  previewOpen.value = !previewOpen.value;
}

function totalSubtree(card: HeaderReviewCard): number {
  let count = 0;
  const byId = new Map(cards.value.map((c) => [c.id, c]));
  const walk = (id: string): void => {
    for (const c of cards.value) {
      if (c.parentId === id) {
        count += 1;
        walk(c.id);
      }
    }
  };
  walk(card.id);
  void byId;
  return count;
}
</script>

<template>
  <div class="hr-editor" @drop.prevent="onDrop" @dragover.prevent="onDragOver">
    <header class="hr-head">
      <div class="hr-title-row">
        <span class="hr-title">Header review</span>
        <code class="hr-source">{{ source }}</code>
        <span class="hr-heading-count">{{ rows.length }} / {{ outline?.headingCount ?? 0 }} headings</span>
        <span class="hr-changes" data-testid="hr-changes" :class="{ dirty: changes > 0 }">
          changes: {{ changes }}
        </span>
        <span v-if="syncing" class="hr-syncing" data-testid="hr-syncing">syncing…</span>
      </div>
      <div class="hr-toolbar" data-testid="hr-toolbar">
        <input
          v-model="query"
          class="hr-search"
          type="search"
          placeholder="find heading…"
          data-testid="hr-search"
          @input="runSearch"
        />
        <button type="button" class="hr-btn" :disabled="matchRows.length === 0" @click="nextMatch">
          next ({{ matchRows.length ? activeMatch + 1 : 0 }}/{{ matchRows.length }})
        </button>
        <button type="button" class="hr-btn" data-testid="hr-preview-toggle" @click="togglePreview">
          {{ previewOpen ? "hide tree preview" : "tree preview" }}
        </button>
        <button type="button" class="hr-btn" :disabled="syncing" data-testid="hr-undo" @click="undo">undo</button>
        <button type="button" class="hr-btn" :disabled="syncing" data-testid="hr-redo" @click="redo">redo</button>
        <button type="button" class="hr-btn accent" :disabled="assistLoading || syncing" data-testid="hr-assist" @click="runAssist">
          {{ assistLoading ? "Athena thinking…" : "⚡ Athena assist" }}
        </button>
        <button type="button" class="hr-btn" data-testid="hr-bulk" @click="bulkOpen = !bulkOpen">demote templates…</button>
        <span class="hr-hint">drag: ⇅ reorder · ⟲ promote · ⟳ re-parent · Alt+←/→/↑/↓ · b = bold</span>
      </div>
      <p v-if="dropError" class="hr-err">{{ dropError }}</p>
      <p v-if="error" class="hr-err" data-testid="hr-error">{{ error }}</p>
    </header>

    <div
      ref="viewport"
      class="hr-viewport"
      data-testid="hr-viewport"
      tabindex="0"
      @scroll="onScroll"
      @keydown="onKeydown"
    >
      <div class="hr-spacer" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="row in visibleRows"
          :key="row.card.id"
          class="hr-row"
          :class="{
            selected: selectedId === row.card.id,
            collapsed: collapsed.has(row.card.id),
          }"
          :style="{
            transform: `translateY(${(startIndex + visibleRows.indexOf(row)) * ROW_HEIGHT}px)`,
            '--depth-color': depthColor(row.depth + (row.card.bold ? 0 : 1)),
          }"
          :data-card-id="String(row.card.index)"
          :data-testid="`hr-card-${row.card.index}`"
          @click="selectRow(row.card.id)"
          @keydown.enter="selectRow(row.card.id)"
          draggable="true"
          @dragstart="onDragStart"
          @dragend="onDragEnd"
        >
          <span
            v-if="row.card.level > 0 && childrenCount(row.card) > 0"
            class="hr-caret"
            role="button"
            tabindex="0"
            :aria-expanded="!collapsed.has(row.card.id)"
            @click.stop="toggleCollapse(row.card.id)"
            @keydown.enter.stop.prevent="toggleCollapse(row.card.id)"
          >{{ collapsed.has(row.card.id) ? "▸" : "▾" }}</span>
          <span v-else class="hr-caret-spacer">·</span>
          <span class="hr-level-chip" :style="{ background: chipColor(row.card) + '26', color: chipColor(row.card) }">
            {{ chipLabel(row.card) }}
          </span>
          <span class="hr-row-title" :class="{ bold: row.card.bold }" :title="row.card.text">{{ row.card.text }}</span>
          <span v-if="childrenCount(row.card) > 0" class="hr-children" data-testid="hr-children-count">
            {{ childrenCount(row.card) }}{{ totalSubtree(row.card) > childrenCount(row.card) ? ` / ${totalSubtree(row.card)}` : "" }}
          </span>
          <span class="hr-row-actions">
            <button type="button" class="hr-mini" title="demote (indent)" data-testid="hr-demote" @click.stop="demote(row.card)">+</button>
            <button type="button" class="hr-mini" title="promote (outdent)" data-testid="hr-promote" @click.stop="promote(row.card)">−</button>
            <button
              type="button"
              class="hr-mini"
              :class="{ on: row.card.bold }"
              title="demote to bold paragraph"
              data-testid="hr-bold"
              @click.stop="toggleBold(row.card)"
            >B</button>
          </span>
        </div>
      </div>
      <p v-if="totalHeight === 0 && !loading" class="hr-empty">No headings detected in this document.</p>
    </div>

    <div v-if="previewOpen" class="hr-preview" data-testid="hr-preview">
      <div class="hr-preview-head">
        <span class="hr-preview-title">Resulting tree (live preview)</span>
        <span class="hr-preview-note">nothing is written to the markdown until Approve</span>
      </div>
      <ul class="hr-preview-list">
        <li
          v-for="row in rows.slice(0, 400)"
          :key="row.card.id"
          class="hr-preview-row"
          :style="{ '--depth-color': depthColor(row.depth) }"
        >
          <span class="hr-preview-indent" :style="{ width: row.depth * 18 + 'px' }" />
          <span class="hr-level-chip" :style="{ background: chipColor(row.card) + '26', color: chipColor(row.card) }">
            {{ chipLabel(row.card) }}
          </span>
          <span class="hr-row-title" :class="{ bold: row.card.bold }">{{ row.card.text }}</span>
        </li>
        <li v-if="rows.length > 400" class="hr-preview-note">… {{ rows.length - 400 }} more (preview capped)</li>
      </ul>
    </div>

    <div v-if="assistOpen" class="hr-assist" data-testid="hr-assist-panel">
      <div class="hr-assist-head">
        <span class="hr-assist-title">Athena suggestions</span>
        <span class="hr-assist-note">chips only — nothing is applied automatically</span>
        <button type="button" class="hr-btn" @click="assistOpen = false">close</button>
      </div>
      <p v-if="suggestions.length === 0" class="hr-assist-empty">No concrete suggestions for this outline.</p>
      <ul class="hr-assist-list">
        <li v-for="(s, i) in suggestions" :key="i" class="hr-assist-chip" :class="{ applied: appliedSuggestionIds.has(i) }">
          <span class="hr-assist-kind">{{ s.kind }}</span>
          <span class="hr-assist-targets">#{{ s.targetIds.join(", #") }}</span>
          <span class="hr-assist-reason">{{ s.reason }}</span>
          <button
            type="button"
            class="hr-mini accent"
            data-testid="hr-apply-chip"
            :disabled="appliedSuggestionIds.has(i) || syncing"
            @click="applySuggestion(i)"
          >
            {{ appliedSuggestionIds.has(i) ? "applied" : "apply" }}
          </button>
        </li>
      </ul>
    </div>

    <div v-if="bulkOpen" class="hr-bulk" data-testid="hr-bulk-panel">
      <div class="hr-bulk-head">
        <span class="hr-bulk-title">Bulk template demotion</span>
        <span class="hr-bulk-note">matching headings → bold paragraphs (exact title match)</span>
        <button type="button" class="hr-btn" @click="bulkOpen = false">close</button>
      </div>
      <textarea
        v-model="bulkWords"
        class="hr-words"
        rows="5"
        placeholder="One template field per line, e.g.&#10;Purpose&#10;Prerequisites&#10;Related Information"
        data-testid="hr-words"
      />
      <div class="hr-bulk-actions">
        <button type="button" class="hr-btn" data-testid="hr-bulk-preview" @click="previewBulk">preview matches</button>
        <button type="button" class="hr-btn" data-testid="hr-bulk-save" @click="saveBulkWords">save list (project)</button>
        <button type="button" class="hr-btn accent" :disabled="bulkMatches.length === 0" data-testid="hr-bulk-apply" @click="applyBulk">
          apply {{ bulkMatches.length }} demotion{{ bulkMatches.length === 1 ? "" : "s" }}
        </button>
        <span v-if="bulkApplied" class="hr-ok">✓ {{ bulkApplied }} demoted</span>
        <span v-if="wordsUpdated" class="hr-ok">✓ word list saved</span>
      </div>
      <ul v-if="bulkMatches.length > 0" class="hr-bulk-matches">
        <li v-for="m in bulkMatches.slice(0, 40)" :key="m.id" class="hr-bulk-match">
          {{ "#".repeat(Math.min(6, m.level)) }} {{ m.text }}
        </li>
        <li v-if="bulkMatches.length > 40" class="hr-bulk-note">… {{ bulkMatches.length - 40 }} more</li>
      </ul>
    </div>

    <footer class="hr-foot">
      <span class="hr-foot-note">
        {{ outline?.toc ? `TOC detected (${outline.toc.source}) — matched ${outline.toc.matched}/${outline.toc.total}` : "no usable TOC — LLM grading would run" }}
      </span>
      <p v-if="busyError" class="hr-err" data-testid="hr-busy-error">{{ busyError }}</p>
      <button type="button" class="hr-btn" :disabled="isResolving" @click="emit('close')">cancel</button>
      <button type="button" class="hr-btn" :disabled="isResolving || syncing" data-testid="hr-skip" @click="confirmingResolve('skip')">skip</button>
      <button
        type="button"
        class="hr-btn accent"
        :disabled="isResolving || syncing"
        data-testid="hr-approve"
        @click="confirmingResolve('approve')"
      >approve</button>
    </footer>
  </div>
</template>

<style scoped>
.hr-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  padding: 12px;
}

.hr-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hr-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.hr-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--caleo-text);
}

.hr-source {
  font-size: 11px;
  color: var(--caleo-text-secondary);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hr-heading-count {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.hr-changes {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface-hover);
}

.hr-changes.dirty {
  color: var(--caleo-warning, #b5851d);
  background: rgba(217, 155, 32, 0.14);
}

.hr-syncing {
  font-size: 11px;
  color: var(--caleo-primary);
}

.hr-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.hr-search {
  padding: 4px 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text);
  font-size: 12px;
  min-width: 180px;
}

.hr-btn {
  padding: 4px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text);
  font-size: 12px;
  cursor: pointer;
}

.hr-btn:hover:not(:disabled) {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
}

.hr-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.hr-btn.accent {
  background: var(--caleo-primary);
  border-color: var(--caleo-primary);
  color: #fff;
}

.hr-hint {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.hr-err {
  margin: 0;
  font-size: 12px;
  color: var(--caleo-error);
}

.hr-ok {
  font-size: 12px;
  color: var(--caleo-success);
}

.hr-viewport {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface-hover);
  position: relative;
  outline: none;
}

.hr-spacer {
  position: relative;
}

.hr-row {
  position: absolute;
  left: 0;
  right: 0;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(127, 127, 127, 0.08);
  cursor: grab;
}

.hr-row.selected {
  background: var(--caleo-sidebar-active, rgba(91, 143, 249, 0.12));
}

.hr-row:hover {
  background: rgba(127, 127, 127, 0.06);
}

.hr-caret,
.hr-caret-spacer {
  width: 14px;
  text-align: center;
  font-size: 11px;
  color: var(--caleo-text-secondary);
  cursor: pointer;
  user-select: none;
}

.hr-level-chip {
  flex-shrink: 0;
  min-width: 34px;
  text-align: center;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.4px;
}

.hr-row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--caleo-text);
}

.hr-row-title.bold {
  font-weight: 700;
  color: var(--caleo-text-secondary);
  text-decoration: line-through;
  text-decoration-color: rgba(127, 127, 127, 0.4);
}

.hr-children {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface-hover);
  border: 1px solid var(--caleo-border);
  border-radius: 4px;
  padding: 0 5px;
}

.hr-row-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0.45;
}

.hr-row:hover .hr-row-actions,
.hr-row.selected .hr-row-actions {
  opacity: 1;
}

.hr-mini {
  width: 22px;
  height: 20px;
  border: 1px solid var(--caleo-border);
  border-radius: 4px;
  background: var(--caleo-surface);
  color: var(--caleo-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.hr-mini.on {
  color: var(--caleo-warning, #b5851d);
  border-color: rgba(217, 155, 32, 0.5);
}

.hr-mini.accent {
  color: var(--caleo-primary);
  border-color: rgba(91, 143, 249, 0.5);
}

.hr-empty {
  padding: 20px;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.hr-preview {
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface-hover);
  max-height: 240px;
  overflow-y: auto;
  padding: 8px;
}

.hr-preview-head,
.hr-assist-head,
.hr-bulk-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hr-preview-title,
.hr-assist-title,
.hr-bulk-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--caleo-text);
}

.hr-preview-note,
.hr-assist-note,
.hr-bulk-note {
  flex: 1;
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.hr-preview-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}

.hr-preview-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  font-size: 12px;
  color: var(--caleo-text);
}

.hr-preview-indent {
  flex-shrink: 0;
  height: 100%;
}

.hr-assist,
.hr-bulk {
  border: 1px solid rgba(91, 143, 249, 0.4);
  border-radius: 6px;
  background: rgba(91, 143, 249, 0.06);
  padding: 8px;
}

.hr-assist-empty {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.hr-assist-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hr-assist-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface);
  font-size: 12px;
}

.hr-assist-chip.applied {
  opacity: 0.55;
}

.hr-assist-kind {
  font-weight: 600;
  color: var(--caleo-primary);
}

.hr-assist-targets {
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

.hr-assist-reason {
  flex: 1;
  min-width: 0;
  color: var(--caleo-text-secondary);
}

.hr-words {
  width: 100%;
  margin-top: 6px;
  padding: 6px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text);
  font-size: 12px;
  font-family: inherit;
  box-sizing: border-box;
}

.hr-bulk-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.hr-bulk-matches {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.hr-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}

.hr-foot-note {
  flex: 1;
  font-size: 11px;
  color: var(--caleo-text-secondary);
}
</style>
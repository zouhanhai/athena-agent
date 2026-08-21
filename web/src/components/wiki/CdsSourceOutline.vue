<template>
  <div class="wiki-cds" data-testid="cds-source-outline">
    <div v-if="chips.length" class="wiki-cds-chips">
      <span class="wiki-cds-chips-title">Sources</span>
      <button
        v-for="(chip, i) in chips"
        :key="`${chip.label}-${i}`"
        type="button"
        class="wiki-chip"
        data-testid="cds-chip"
        @click="onCodeLink(chip.target)"
      >
        {{ chip.label }}
      </button>
    </div>

    <article
      v-for="(view, vi) in views"
      :key="view.chunkIndex"
      class="wiki-cds-view"
      :data-testid="`cds-view-${vi}`"
    >
      <header class="wiki-cds-view-header">
        <h2 :id="outlineAnchor(view)" class="wiki-cds-view-title">
          {{ view.technicalName }}
        </h2>
        <span v-if="view.dataCategory" class="wiki-cds-view-category">{{ view.dataCategory }}</span>
      </header>

      <div class="wiki-cds-outline">
        <nav class="wiki-hana-outline" aria-label="Source outline">
          <div class="wiki-hana-group" data-testid="cds-elements">
            <span class="wiki-hana-group-title">Elements</span>
            <button
              v-for="(m, mi) in view.members"
              :key="`el-${mi}`"
              type="button"
              class="wiki-hana-item"
              :title="m"
              @click="scrollToAnchor(`cds-el-${view.chunkIndex}-${mi}`)"
            >
              {{ m }}
            </button>
            <span v-if="view.members.length === 0" class="wiki-hana-empty">no elements parsed</span>
          </div>
          <div class="wiki-hana-group" data-testid="cds-associations">
            <span class="wiki-hana-group-title">Associations</span>
            <button
              v-for="(a, ai) in view.associations"
              :key="`assoc-${ai}`"
              type="button"
              class="wiki-hana-item"
              :title="`${a.name} → ${a.target}`"
              @click="scrollToAnchor(`cds-assoc-${view.chunkIndex}-${ai}`)"
            >
              <span class="wiki-hana-assoc-name">{{ a.name }}</span>
              <span class="wiki-hana-assoc-arrow">→ {{ a.target }}</span>
            </button>
            <span v-if="view.associations.length === 0" class="wiki-hana-empty">none</span>
          </div>
          <div class="wiki-hana-group" data-testid="cds-sources">
            <span class="wiki-hana-group-title">Source tables</span>
            <button
              v-for="(st, si) in view.sourceTables"
              :key="`src-${si}`"
              type="button"
              class="wiki-hana-item"
              @click="onCodeLink(st)"
            >
              {{ st }}
            </button>
            <span v-if="view.sourceTables.length === 0" class="wiki-hana-empty">none</span>
          </div>
        </nav>

        <pre class="wiki-cds-ddl"><code><span
          v-for="(line, li) in ddlLines(view)"
          :key="`dl-${li}`"
          :id="dddAnchor(view, li)"
          class="wiki-cds-ddl-line"
          v-html="highlightLine(line.text)"
        /></code></pre>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import hljs from "highlight.js";
import type { WikiCodeMeta } from "@/api/kb";
import { codeAnchor, resolveCodeLinkAction } from "@/kb/code-links";

const props = defineProps<{
  meta: WikiCodeMeta;
  system?: string;
  existingPaths: string[];
}>();

const emit = defineEmits<{
  (e: "navigate", path: string): void;
  (e: "search", target: string): void;
}>();

interface CdsViewOut {
  chunkIndex: number;
  technicalName: string;
  dataCategory: string;
  sourceTables: string[];
  associations: Array<{ name: string; target: string }>;
  members: string[];
  text: string;
}

const views = computed<CdsViewOut[]>(() =>
  props.meta.chunks.map((c, i) => ({
    chunkIndex: i,
    technicalName:
      typeof c.metadata.technicalName === "string"
        ? (c.metadata.technicalName as string)
        : (c.path.split("/").pop() ?? c.id),
    dataCategory:
      typeof c.metadata.dataCategory === "string" ? (c.metadata.dataCategory as string) : "",
    sourceTables: Array.isArray(c.metadata.sourceTables)
      ? (c.metadata.sourceTables as string[])
      : [],
    associations: Array.isArray(c.metadata.associations)
      ? (c.metadata.associations as Array<{ name: string; target: string }>)
      : [],
    members: Array.isArray(c.metadata.members) ? (c.metadata.members as string[]) : [],
    text: c.text ?? "",
  })),
);

/** Deduped chips across all views (source tables + association targets). */
const chips = computed(() => {
  const seen = new Set<string>();
  const out: Array<{ label: string; target: string }> = [];
  for (const view of views.value) {
    for (const t of view.sourceTables) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({ label: t, target: t });
    }
    for (const a of view.associations) {
      const t = a.target;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({ label: t, target: t });
    }
  }
  return out;
});

interface DdlLine {
  text: string;
  lineIndex: number;
}

/** Split a view's DDL into lines, mapping each member/assoc/source to the line
 *  that starts it so an outline click scrolls to the matching DDL position. */
function ddlLines(view: CdsViewOut): DdlLine[] {
  return view.text.split("\n").map((text, lineIndex) => ({ text, lineIndex }));
}

function dddAnchor(view: CdsViewOut, lineIndex: number): string | undefined {
  const line = view.text.split("\n")[lineIndex];
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  const memberIndex = view.members.findIndex((m) => {
    const mt = m.trim();
    return trimmed === mt || trimmed.startsWith(mt);
  });
  if (memberIndex !== -1) return `cds-el-${view.chunkIndex}-${memberIndex}`;
  const assocIndex = view.associations.findIndex((a) => trimmed.toLowerCase().includes(a.name.toLowerCase()));
  if (assocIndex !== -1) return `cds-assoc-${view.chunkIndex}-${assocIndex}`;
  if (view.sourceTables.length > 0 && /select\s+from/i.test(trimmed)) return `cds-src-${view.chunkIndex}`;
  return undefined;
}

function outlineAnchor(view: CdsViewOut): string {
  return codeAnchor(view.technicalName);
}

function scrollToAnchor(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function highlightLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "&nbsp;";
  try {
    return hljs.highlight(line, { language: "sql", ignoreIllegals: true }).value;
  } catch {
    return line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

function onCodeLink(target: string): void {
  const action = resolveCodeLinkAction(props.existingPaths, props.system, target);
  if (action.kind === "navigate") emit("navigate", action.path);
  else emit("search", action.target);
}
</script>

<style scoped>
.wiki-cds {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.wiki-cds-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  background: var(--caleo-surface-hover);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
}

.wiki-cds-chips-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--caleo-text-secondary);
}

.wiki-chip {
  padding: 2px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 999px;
  background: var(--caleo-surface);
  color: var(--caleo-sky);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  cursor: pointer;
}

.wiki-chip:hover {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
}

.wiki-cds-view {
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  padding: 12px;
}

.wiki-cds-view-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.wiki-cds-view-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--caleo-text);
}

.wiki-cds-view-category {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text-secondary);
}

.wiki-cds-outline {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.wiki-hana-outline {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 480px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
}

.wiki-hana-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wiki-hana-group-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--caleo-text-secondary);
  margin-bottom: 2px;
}

.wiki-hana-item {
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--caleo-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.wiki-hana-item:hover {
  background: var(--caleo-surface-hover);
  color: var(--caleo-primary);
}

.wiki-hana-assoc-name {
  color: var(--caleo-sky);
}

.wiki-hana-assoc-arrow {
  color: var(--caleo-text-secondary);
}

.wiki-hana-empty {
  font-size: 12px;
  color: var(--caleo-text-secondary);
  font-style: italic;
}

.wiki-cds-ddl {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  background: var(--caleo-body-bg);
  border: 1px solid var(--caleo-border);
  max-height: 480px;
  overflow-y: auto;
}

.wiki-cds-ddl code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--caleo-text);
  background: transparent;
  padding: 0;
}

.wiki-cds-ddl-line {
  display: block;
  white-space: pre;
}

.wiki-cds-ddl-line:target {
  background: color-mix(in srgb, var(--caleo-primary) 18%, transparent);
}
</style>
<template>
  <div class="wiki-ddic" data-testid="ddic-schema-view">
    <section
      v-for="(table, ti) in tables"
      :key="table.name"
      :id="codeAnchor(table.name)"
      class="wiki-ddic-table"
      :data-testid="`ddic-table-${ti}`"
    >
      <header class="wiki-ddic-table-header">
        <h3 class="wiki-ddic-table-title">
          <span v-if="table.foreignKeys.length > 0" class="wiki-key-glyph">🔑</span>
          {{ table.name }}
        </h3>
        <span v-if="table.description" class="wiki-ddic-table-desc">{{ table.description }}</span>
        <input
          v-model="filter[table.name]"
          type="search"
          class="wiki-ddic-search"
          :placeholder="`Filter ${table.name} fields…`"
          aria-label="Filter fields"
          data-testid="ddic-search"
        />
      </header>

      <table class="wiki-ddic-grid">
        <thead>
          <tr>
            <th class="wiki-ddic-col-key"></th>
            <th
              class="wiki-ddic-sortable"
              data-testid="ddic-sort-field"
              @click="toggleSort(table.name, 'name')"
            >
              Field<span class="wiki-ddic-sort-mark">{{ sortMark(table.name, "name") }}</span>
            </th>
            <th
              class="wiki-ddic-sortable"
              data-testid="ddic-sort-type"
              @click="toggleSort(table.name, 'dataType')"
            >
              Type<span class="wiki-ddic-sort-mark">{{ sortMark(table.name, "dataType") }}</span>
            </th>
            <th class="wiki-ddic-sortable" @click="toggleSort(table.name, 'description')">
              Description<span class="wiki-ddic-sort-mark">{{ sortMark(table.name, "description") }}</span>
            </th>
            <th>FK</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in visibleFields(table)" :key="field.name">
            <td class="wiki-ddic-col-key">
              <span v-if="field.key" title="Key field" class="wiki-key-glyph">🔑</span>
            </td>
            <td class="wiki-ddic-cell-name">
              <code>{{ field.name }}</code>
              <span v-if="field.dataElement" class="wiki-ddic-de">({{ field.dataElement }})</span>
            </td>
            <td class="wiki-ddic-cell-type">
              <code v-if="field.dataType">
                {{ field.dataType }}{{ field.length ? `(${field.length})` : "" }}
              </code>
              <span v-if="field.domain" class="wiki-ddic-domain">{{ field.domain }}</span>
            </td>
            <td>{{ field.description ?? "" }}</td>
            <td class="wiki-ddic-cell-fk">
              <button
                v-for="fk in foreignKeysFor(table, field.name)"
                :key="fk.table"
                type="button"
                class="wiki-fk-link"
                data-testid="ddic-fk-link"
                :title="fk.description ?? ''"
                @click="onCodeLink(fk.table)"
              >
                {{ fk.table }}
              </button>
            </td>
          </tr>
          <tr v-if="visibleFields(table).length === 0">
            <td colspan="5" class="wiki-ddic-empty">No fields match the filter.</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";
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

interface DdicField {
  name: string;
  key?: boolean;
  dataType?: string;
  length?: number;
  dataElement?: string;
  domain?: string;
  description?: string;
}

interface DdicFk {
  field?: string;
  table: string;
  description?: string;
}

interface DdicTableOut {
  name: string;
  description?: string;
  fields: DdicField[];
  foreignKeys: DdicFk[];
}

const tables = computed<DdicTableOut[]>(() => {
  const map = new Map<string, DdicTableOut>();
  for (const chunk of props.meta.chunks) {
    const m = chunk.metadata;
    if (typeof m?.tableName !== "string") continue;
    let table = map.get(m.tableName);
    if (!table) {
      table = { name: m.tableName as string, fields: [], foreignKeys: [] };
      if (typeof m.description === "string") table.description = m.description;
      map.set(m.tableName as string, table);
    }
    if (Array.isArray(m.fields)) {
      for (const raw of m.fields as unknown[]) {
        if (typeof raw !== "object" || raw === null) continue;
        const f = raw as DdicField;
        if (typeof f.name !== "string") continue;
        if (!table.fields.some((x) => x.name === f.name)) table.fields.push(f);
      }
    }
    if (Array.isArray(m.foreignKeys)) {
      for (const raw of m.foreignKeys as unknown[]) {
        if (typeof raw !== "object" || raw === null) continue;
        const fk = raw as DdicFk;
        if (typeof fk.table !== "string") continue;
        if (!table.foreignKeys.some((x) => x.table === fk.table)) table.foreignKeys.push(fk);
      }
    }
  }
  return [...map.values()];
});

const filter = reactive<Record<string, string>>({});
const sortKey = reactive<Record<string, string>>({});
const sortDir = reactive<Record<string, "asc" | "desc">>({});

type SortableKey = "name" | "dataType" | "description";

function sortMark(tableName: string, key: SortableKey): string {
  if (sortKey[tableName] !== key) return "";
  return sortDir[tableName] === "desc" ? " ↓" : " ↑";
}

function toggleSort(tableName: string, key: SortableKey): void {
  if (sortKey[tableName] === key) {
    sortDir[tableName] = sortDir[tableName] === "asc" ? "desc" : "asc";
  } else {
    sortKey[tableName] = key;
    sortDir[tableName] = "asc";
  }
}

function matches(text: string | undefined, needle: string): boolean {
  return (text ?? "").toLowerCase().includes(needle);
}

function visibleFields(table: DdicTableOut): DdicField[] {
  const needle = (filter[table.name] ?? "").trim().toLowerCase();
  let out = table.fields;
  if (needle) {
    out = table.fields.filter(
      (f) =>
        matches(f.name, needle) ||
        matches(f.description, needle) ||
        matches(f.dataType, needle) ||
        matches(f.dataElement, needle) ||
        matches(f.domain, needle),
    );
  }
  const key = (sortKey[table.name] as SortableKey | undefined) ?? "name";
  const dir = sortDir[table.name] === "desc" ? -1 : 1;
  return [...out].sort((a, b) => {
    const av = (a[key] ?? "").toString().toLowerCase();
    const bv = (b[key] ?? "").toString().toLowerCase();
    return av.localeCompare(bv) * dir;
  });
}

function foreignKeysFor(table: DdicTableOut, fieldName: string): DdicFk[] {
  return table.foreignKeys.filter((fk) => !fk.field || fk.field === fieldName);
}

function onCodeLink(target: string): void {
  const action = resolveCodeLinkAction(props.existingPaths, props.system, target);
  if (action.kind === "navigate") emit("navigate", action.path);
  else emit("search", action.target);
}
</script>

<style scoped>
.wiki-ddic {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.wiki-ddic-table {
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  padding: 12px;
}

.wiki-ddic-table-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.wiki-ddic-table-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--caleo-text);
}

.wiki-ddic-table-desc {
  color: var(--caleo-text-secondary);
  font-size: 13px;
}

.wiki-ddic-search {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-body-bg);
  color: var(--caleo-text);
  font-size: 13px;
  min-width: 200px;
}

.wiki-ddic-search:focus {
  outline: none;
  border-color: var(--caleo-primary);
}

.wiki-key-glyph {
  font-size: 13px;
}

.wiki-ddic-grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.wiki-ddic-grid th,
.wiki-ddic-grid td {
  padding: 5px 8px;
  border: 1px solid var(--caleo-border);
  text-align: left;
  vertical-align: top;
}

.wiki-ddic-grid th {
  background: var(--caleo-surface-hover);
  font-weight: 600;
  color: var(--caleo-text);
}

.wiki-ddic-col-key {
  width: 28px;
  text-align: center;
}

.wiki-ddic-sortable {
  cursor: pointer;
  user-select: none;
}

.wiki-ddic-sortable:hover {
  color: var(--caleo-primary);
}

.wiki-ddic-sort-mark {
  color: var(--caleo-primary);
  font-size: 11px;
}

.wiki-ddic-cell-name code {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-primary);
}

.wiki-ddic-de {
  color: var(--caleo-text-secondary);
  font-size: 11px;
}

.wiki-ddic-cell-type code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.wiki-ddic-domain {
  margin-left: 4px;
  color: var(--caleo-text-secondary);
  font-size: 11px;
}

.wiki-fk-link {
  padding: 1px 8px;
  margin: 1px;
  border: 1px solid var(--caleo-border);
  border-radius: 999px;
  background: var(--caleo-surface);
  color: var(--caleo-sky);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  cursor: pointer;
}

.wiki-fk-link:hover {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
}

.wiki-ddic-empty {
  color: var(--caleo-text-secondary);
  font-style: italic;
  text-align: center;
}
</style>
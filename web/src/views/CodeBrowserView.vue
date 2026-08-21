<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  getCodeObject,
  listCodeObjects,
  type CodeObjectDetail,
  type CodeObjectEntity,
  type CodeObjectRelation,
} from "@/api/kb";

/** The code-object kinds the browser groups the left list by (G4.S8.T12).
 *  Keys are the canonical lowercase Entity.type values used across emitters. */
const TYPE_GROUPS: Array<{ key: string; label: string }> = [
  { key: "abap_unit", label: "ABAP Unit" },
  { key: "cds_view", label: "CDS View" },
  { key: "table", label: "Table" },
  { key: "ui5_component", label: "UI5 Component" },
  { key: "odata_service", label: "OData Service" },
];

const router = useRouter();

const loading = ref(true);
const error = ref("");
const entities = ref<CodeObjectEntity[]>([]);
const query = ref("");
const expandedTypes = ref<Set<string>>(new Set(TYPE_GROUPS.map((g) => g.key)));

const detail = ref<CodeObjectDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const selectedName = ref("");

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/** Entities grouped by type, in the canonical TYPE_GROUPS order. Types with no
 *  entities are omitted. */
const grouped = computed(() => {
  const byType = new Map<string, CodeObjectEntity[]>();
  for (const e of entities.value) {
    const key = e.type ?? "other";
    const list = byType.get(key) ?? [];
    list.push(e);
    byType.set(key, list);
  }
  return TYPE_GROUPS.map((g) => ({ ...g, items: byType.get(g.key) ?? [] })).filter(
    (g) => g.items.length > 0,
  );
});

/** A relation entry is deep-linkable when at least one wiki page resolved. */
function firstWikiPath(rel: CodeObjectRelation): string | undefined {
  return rel.wikiPaths?.find((p) => p.length > 0);
}

function toggleType(key: string): void {
  const next = new Set(expandedTypes.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedTypes.value = next;
}

async function loadList(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    entities.value = await listCodeObjects({
      ...(query.value.trim() ? { q: query.value.trim() } : {}),
      limit: 200,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    entities.value = [];
  } finally {
    loading.value = false;
  }
}

function onSearchInput(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void loadList(), 250);
}

async function select(name: string): Promise<void> {
  selectedName.value = name;
  detail.value = null;
  detailError.value = "";
  detailLoading.value = true;
  try {
    detail.value = await getCodeObject(name);
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
}

/** Open a relation entry's wiki page (deep link into the Wiki view). */
function openWiki(wikiPath: string): void {
  void router.push({ path: "/wiki", query: { path: wikiPath } });
}

onMounted(() => void loadList());

watch(query, (q) => {
  // A changed search re-collapses nothing; just re-run the debounced load.
  void q;
});
</script>

<template>
  <section class="cb-panel">
    <header class="cb-header">
      <h2 class="cb-title">Code Browser</h2>
      <span class="cb-subtitle">SE80-style where-used across ingested objects</span>
    </header>

    <div class="cb-body">
      <aside class="cb-list-pane">
        <div class="cb-search">
          <t-input
            v-model="query"
            placeholder="Search objects…"
            clearable
            data-testid="cb-search"
            @input="onSearchInput"
          />
        </div>
        <p v-if="error" class="cb-error">{{ error }}</p>
        <p v-else-if="loading" class="cb-status">Loading objects…</p>
        <div v-else-if="grouped.length === 0" class="cb-empty" data-testid="cb-empty-state">
          <h3>No code objects yet</h3>
          <p>
            Nothing to browse — either the Neo4j graph store is not configured, or no
            code objects have been ingested yet. Ingest CDS / ABAP / UI5 / DDIC sources
            to populate the graph.
          </p>
        </div>
        <div v-else class="cb-groups">
          <div v-for="group in grouped" :key="group.key" class="cb-group">
            <button
              type="button"
              class="cb-group-header"
              :aria-expanded="expandedTypes.has(group.key)"
              :data-testid="`cb-group-${group.key}`"
              @click="toggleType(group.key)"
            >
              <span class="cb-group-caret">{{ expandedTypes.has(group.key) ? "▾" : "▸" }}</span>
              <span class="cb-group-label">{{ group.label }}</span>
              <span class="cb-group-count">{{ group.items.length }}</span>
            </button>
            <ul v-if="expandedTypes.has(group.key)" class="cb-group-items">
              <li v-for="item in group.items" :key="item.name">
                <button
                  type="button"
                  class="cb-entity"
                  :class="{ 'is-active': selectedName === item.name }"
                  data-testid="cb-entity"
                  @click="select(item.name)"
                >
                  <span class="cb-entity-name">{{ item.name }}</span>
                  <span v-if="item.description" class="cb-entity-desc">{{ item.description }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </aside>

      <div class="cb-detail-pane">
        <p v-if="detailError" class="cb-error">{{ detailError }}</p>
        <p v-else-if="detailLoading" class="cb-status">Loading object…</p>
        <p v-else-if="!selectedName" class="cb-status cb-empty-hint">
          Select a code object on the left to see what it uses and what uses it.
        </p>
        <div v-else-if="detail" class="cb-detail" data-testid="cb-detail">
          <div class="cb-detail-header">
            <span class="cb-detail-type">{{ detail.type }}</span>
            <h3 class="cb-detail-name">{{ detail.name }}</h3>
            <p v-if="detail.description" class="cb-detail-desc">{{ detail.description }}</p>
          </div>

          <div class="cb-sections">
            <section class="cb-section" data-testid="cb-uses">
              <h4 class="cb-section-title">Uses <span class="cb-section-count">{{ detail.outgoing.length }}</span></h4>
              <ul v-if="detail.outgoing.length" class="cb-links">
                <li v-for="(rel, i) in detail.outgoing" :key="i" class="cb-link-row">
                  <span class="cb-keyword">{{ rel.keywords.join(", ") }}</span>
                  <a
                    v-if="firstWikiPath(rel)"
                    class="cb-link"
                    data-testid="cb-link"
                    @click.prevent="openWiki(firstWikiPath(rel)!)"
                  >
                    {{ rel.entity }}
                  </a>
                  <span v-else class="cb-link-plain" data-testid="cb-link-plain">{{ rel.entity }}</span>
                </li>
              </ul>
              <p v-else class="cb-none">Nothing.</p>
            </section>

            <section class="cb-section" data-testid="cb-used-by">
              <h4 class="cb-section-title">
                Used by <span class="cb-section-count">{{ detail.incoming.length }}</span>
              </h4>
              <ul v-if="detail.incoming.length" class="cb-links">
                <li v-for="(rel, i) in detail.incoming" :key="i" class="cb-link-row">
                  <span class="cb-keyword">{{ rel.keywords.join(", ") }}</span>
                  <a
                    v-if="firstWikiPath(rel)"
                    class="cb-link"
                    data-testid="cb-link"
                    @click.prevent="openWiki(firstWikiPath(rel)!)"
                  >
                    {{ rel.entity }}
                  </a>
                  <span v-else class="cb-link-plain" data-testid="cb-link-plain">{{ rel.entity }}</span>
                </li>
              </ul>
              <p v-else class="cb-none">Nothing.</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cb-panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  height: calc(100dvh - 48px);
  padding: 24px;
}

.cb-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.cb-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.cb-subtitle {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.cb-body {
  flex: 1;
  display: flex;
  gap: 16px;
  min-height: 0;
}

.cb-list-pane {
  width: 300px;
  flex-shrink: 0;
  padding: 12px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  overflow-y: auto;
}

.cb-search {
  margin-bottom: 12px;
}

.cb-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cb-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cb-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
  text-align: left;
}

.cb-group-header:hover {
  background: var(--caleo-surface-hover);
  border-radius: 6px;
}

.cb-group-caret {
  width: 12px;
  color: var(--caleo-text-secondary);
}

.cb-group-count {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text-secondary);
  font-size: 11px;
}

.cb-group-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cb-entity {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}

.cb-entity:hover {
  background: var(--caleo-surface-hover);
}

.cb-entity.is-active {
  background: var(--caleo-sidebar-active);
  color: var(--caleo-primary);
}

.cb-entity-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  color: inherit;
}

.cb-entity-desc {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.cb-detail-pane {
  flex: 1;
  min-width: 0;
  padding: 20px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  overflow-y: auto;
}

.cb-error {
  margin: 0;
  padding: 16px;
  color: var(--caleo-error);
  font-size: 13px;
}

.cb-status {
  margin: 0;
  padding: 16px;
  color: var(--caleo-text-secondary);
  font-size: 13px;
}

.cb-empty-hint {
  text-align: center;
}

.cb-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--caleo-text-secondary);
}

.cb-empty h3 {
  margin: 0 0 8px;
  color: var(--caleo-text);
  font-size: 15px;
}

.cb-empty p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}

.cb-detail-header {
  margin-bottom: 20px;
}

.cb-detail-type {
  display: inline-block;
  margin-bottom: 6px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-primary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.cb-detail-name {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 20px;
  color: var(--caleo-text);
}

.cb-detail-desc {
  margin: 6px 0 0;
  color: var(--caleo-text-secondary);
  font-size: 13px;
}

.cb-sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.cb-section-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--caleo-text);
  border-bottom: 1px solid var(--caleo-border);
  padding-bottom: 6px;
}

.cb-section-count {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text-secondary);
  font-size: 11px;
}

.cb-links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cb-link-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-body-bg);
}

.cb-keyword {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.cb-link {
  color: var(--caleo-sky);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  cursor: pointer;
  text-decoration: none;
}

.cb-link:hover {
  text-decoration: underline;
  color: var(--caleo-primary);
}

.cb-link-plain {
  color: var(--caleo-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
}

.cb-none {
  margin: 0;
  color: var(--caleo-text-secondary);
  font-size: 13px;
}
</style>

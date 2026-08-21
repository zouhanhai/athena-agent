<template>
  <div id="ui5-source" class="wiki-ui5" data-testid="ui5-structure-view">
    <section
      v-for="component in components"
      :key="component.name"
      class="wiki-ui5-component"
    >
      <h3 class="wiki-ui5-component-title">
        <code>{{ component.name }}</code>
        <span class="wiki-ui5-component-count">{{ component.files.length }} file(s)</span>
      </h3>

      <div
        v-for="group in component.groups"
        :key="group.kind"
        class="wiki-ui5-group"
      >
        <span class="wiki-ui5-group-title">{{ group.kind }}</span>
        <ul class="wiki-ui5-files">
          <li v-for="file in group.files" :key="file.key">
            <button
              type="button"
              class="wiki-ui5-file"
              :data-testid="`ui5-file-${group.kind}`"
              @click="scrollToAnchor(fileAnchor(file.file))"
            >
              {{ file.file }}
            </button>
            <ul v-if="file.methods.length" class="wiki-ui5-methods">
              <li v-for="m in file.methods" :key="m">
                <button
                  type="button"
                  class="wiki-ui5-method"
                  @click="scrollToAnchor(fileMethodAnchor(file.file, m))"
                >
                  {{ m }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <div
        v-for="file in component.files"
        :id="fileAnchor(file.file)"
        class="wiki-ui5-code"
      >
        <pre><code>{{ file.text }}</code></pre>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { WikiCodeMeta } from "@/api/kb";
import { codeAnchor } from "@/kb/code-links";

const props = defineProps<{ meta: WikiCodeMeta }>();

interface Ui5FileOut {
  key: string;
  kind: string;
  file: string;
  name: string;
  methods: string[];
  text: string;
}

interface Ui5GroupOut {
  kind: string;
  files: Ui5FileOut[];
}

const KIND_LABELS: Record<string, string> = {
  controller: "Controllers",
  view: "Views",
  manifest: "Manifest",
  model: "Models",
  component: "Component",
  js: "JS",
};

const components = computed(() => {
  const compMap = new Map<
    string,
    { name: string; files: Ui5FileOut[]; groups: Ui5GroupOut[] }
  >();
  for (const chunk of props.meta.chunks) {
    const m = chunk.metadata;
    const file = typeof m.file === "string" ? (m.file as string) : chunk.path;
    const componentName =
      typeof m.component === "string" ? (m.component as string) : "app";
    const kind = typeof m.kind === "string" ? (m.kind as string) : "js";
    let comp = compMap.get(componentName);
    if (!comp) {
      comp = { name: componentName, files: [], groups: [] };
      compMap.set(componentName, comp);
    }
    const methods = typeof m.method === "string" ? [m.method as string] : [];
    comp.files.push({
      key: chunk.id || `${componentName}-${file}`,
      kind,
      file,
      name: typeof m.name === "string" ? (m.name as string) : file,
      methods,
      text: chunk.text ?? "",
    });
  }

  const out: Array<{ name: string; files: Ui5FileOut[]; groups: Ui5GroupOut[] }> = [];
  for (const comp of compMap.values()) {
    const groups = new Map<string, Ui5FileOut[]>();
    for (const file of comp.files) {
      const list = groups.get(file.kind) ?? [];
      list.push(file);
      groups.set(file.kind, list);
    }
    comp.groups = [...groups.entries()].map(([kind, files]) => ({
      kind: KIND_LABELS[kind] ?? kind,
      files,
    }));
    out.push(comp);
  }
  return out;
});

function fileAnchor(file: string): string {
  return codeAnchor(file);
}

function fileMethodAnchor(file: string, method: string): string {
  return `${codeAnchor(file)}-${codeAnchor(method)}`;
}

function scrollToAnchor(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>

<style scoped>
.wiki-ui5 {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.wiki-ui5-component {
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  padding: 12px;
}

.wiki-ui5-component-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--caleo-text);
}

.wiki-ui5-component-title code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--caleo-primary);
  background: transparent;
  padding: 0;
}

.wiki-ui5-component-count {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.wiki-ui5-group {
  margin-bottom: 10px;
}

.wiki-ui5-group-title {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--caleo-text-secondary);
  margin-bottom: 4px;
}

.wiki-ui5-files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wiki-ui5-file,
.wiki-ui5-method {
  border: none;
  background: none;
  text-align: left;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--caleo-text);
}

.wiki-ui5-file:hover,
.wiki-ui5-method:hover {
  background: var(--caleo-surface-hover);
  color: var(--caleo-primary);
}

.wiki-ui5-file {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.wiki-ui5-methods {
  list-style: none;
  margin: 2px 0 0 18px;
  padding: 0;
}

.wiki-ui5-method {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.wiki-ui5-code pre {
  margin: 6px 0 0;
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  background: var(--caleo-body-bg);
  border: 1px solid var(--caleo-border);
}

.wiki-ui5-code pre code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--caleo-text);
  background: transparent;
  padding: 0;
}

.wiki-ui5-code:target {
  outline: 2px solid color-mix(in srgb, var(--caleo-primary) 40%, transparent);
  border-radius: 6px;
}
</style>
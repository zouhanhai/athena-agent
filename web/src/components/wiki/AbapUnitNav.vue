<template>
  <div id="abap-source" class="wiki-abap" data-testid="abap-unit-nav">
    <section v-for="obj in objects" :key="obj.devName" class="wiki-abap-object">
      <h3 class="wiki-abap-object-title">
        <span class="wiki-abap-object-type">{{ obj.objectType }}</span>
        <code>{{ obj.devName }}</code>
        <span v-if="obj.methods.length" class="wiki-abap-object-count">{{ obj.methods.length }} method(s)</span>
      </h3>
      <ul class="wiki-abap-methods">
        <li v-for="unit in obj.methods" :key="unit.key">
          <button
            type="button"
            class="wiki-abap-method"
            :data-testid="`abap-method-${obj.devName}`"
            @click="scrollToAnchor(sectionId(unit))"
          >
            <span v-if="unit.method" class="wiki-abap-method-name">{{ unit.method }}</span>
            <span v-else class="wiki-abap-method-name">{{ unit.devName }} <em>(body)</em></span>
            <span v-if="unit.dependencies.length" class="wiki-abap-deps">
              reads {{ unit.dependencies.map((d) => d.name).join(", ") }}
            </span>
          </button>
        </li>
      </ul>
      <div
        v-for="unit in obj.methods"
        :id="sectionId(unit)"
        class="wiki-abap-code"
        :data-testid="`abap-code-${unit.devName}`"
      >
        <pre><code>{{ unit.text }}</code></pre>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { WikiCodeMeta } from "@/api/kb";
import { codeAnchor } from "@/kb/code-links";

const props = defineProps<{ meta: WikiCodeMeta }>();

interface AbapUnitOut {
  key: string;
  objectType: string;
  devName: string;
  method: string | null;
  dependencies: Array<{ kind: string; name: string }>;
  text: string;
}

const objects = computed(() => {
  const map = new Map<
    string,
    { devName: string; objectType: string; methods: AbapUnitOut[] }
  >();
  for (const chunk of props.meta.chunks) {
    const m = chunk.metadata;
    if (typeof m.devName !== "string") continue;
    const unit: AbapUnitOut = {
      key: chunk.id || `${m.devName}-${m.method ?? "body"}`,
      objectType: typeof m.objectType === "string" ? (m.objectType as string) : "",
      devName: m.devName as string,
      method: typeof m.method === "string" ? (m.method as string) : null,
      dependencies: Array.isArray(m.dependencies)
        ? (m.dependencies as Array<{ kind: string; name: string }>)
        : [],
      text: chunk.text ?? "",
    };
    let obj = map.get(unit.devName);
    if (!obj) {
      obj = { devName: unit.devName, objectType: unit.objectType, methods: [] };
      map.set(unit.devName, obj);
    }
    if (!obj.objectType) obj.objectType = unit.objectType;
    obj.methods.push(unit);
  }
  return [...map.values()];
});

function sectionId(unit: AbapUnitOut): string {
  if (unit.method) return `${codeAnchor(unit.devName)}-${codeAnchor(unit.method)}`;
  return codeAnchor(unit.devName);
}

function scrollToAnchor(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>

<style scoped>
.wiki-abap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.wiki-abap-object {
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  padding: 12px;
}

.wiki-abap-object-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--caleo-text);
}

.wiki-abap-object-type {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  text-transform: uppercase;
  background: var(--caleo-surface-hover);
  color: var(--caleo-text-secondary);
}

.wiki-abap-object-title code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--caleo-primary);
  background: transparent;
  padding: 0;
}

.wiki-abap-object-count {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.wiki-abap-methods {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wiki-abap-method {
  padding: 3px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 999px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
  font-size: 12px;
  cursor: pointer;
}

.wiki-abap-method:hover {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
}

.wiki-abap-method-name em {
  color: var(--caleo-text-secondary);
  font-size: 11px;
}

.wiki-abap-deps {
  margin-left: 6px;
  color: var(--caleo-text-secondary);
  font-size: 11px;
}

.wiki-abap-code pre {
  margin: 4px 0;
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  background: var(--caleo-body-bg);
  border: 1px solid var(--caleo-border);
}

.wiki-abap-code pre code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--caleo-text);
  background: transparent;
  padding: 0;
}

.wiki-abap-code:target {
  outline: 2px solid color-mix(in srgb, var(--caleo-primary) 40%, transparent);
  border-radius: 6px;
}
</style>
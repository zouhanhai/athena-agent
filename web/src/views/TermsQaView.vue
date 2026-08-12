<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  listSemanticMappings,
  addSemanticMapping,
  deleteSemanticMapping,
  addManualQa,
  deleteQaPair,
} from "@/api/kb";
import { listQaPairs } from "@/api/feedback";
import type { SemanticMapping } from "@/api/kb";
import type { QaPair } from "@/api/feedback";
import type { ManualQaMode } from "@/api/kb";

const mappings = ref<SemanticMapping[]>([]);
const pairs = ref<QaPair[]>([]);
const loading = ref(false);
const error = ref("");

const termInput = ref("");
const canonicalInput = ref("");
const addingMapping = ref(false);
const mappingError = ref("");

const questionInput = ref("");
const answerInput = ref("");
const addingQa = ref(false);
const qaError = ref("");

const decisionVisible = ref(false);
const decisionSimilar = ref<{ id: string; question: string; score: number } | null>(null);
const deciding = ref(false);
const decisionError = ref("");
const pendingAdd = ref<{ question: string; answer: string } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [m, p] = await Promise.all([listSemanticMappings(), listQaPairs()]);
    mappings.value = m;
    pairs.value = p;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function submitMapping(): Promise<void> {
  const term = termInput.value.trim();
  const canonical = canonicalInput.value.trim();
  if (!term || !canonical) return;
  addingMapping.value = true;
  mappingError.value = "";
  try {
    await addSemanticMapping(term, canonical);
    termInput.value = "";
    canonicalInput.value = "";
    await load();
  } catch (err) {
    mappingError.value = err instanceof Error ? err.message : String(err);
  } finally {
    addingMapping.value = false;
  }
}

async function removeMapping(id: string): Promise<void> {
  mappingError.value = "";
  try {
    await deleteSemanticMapping(id);
    await load();
  } catch (err) {
    mappingError.value = err instanceof Error ? err.message : String(err);
  }
}

async function submitQa(): Promise<void> {
  const question = questionInput.value.trim();
  const answer = answerInput.value.trim();
  if (!question || !answer) return;
  addingQa.value = true;
  qaError.value = "";
  try {
    const result = await addManualQa({ question, answer });
    if (result.action === "needs_decision" && result.similar) {
      decisionSimilar.value = result.similar;
      pendingAdd.value = { question, answer };
      decisionVisible.value = true;
      return;
    }
    questionInput.value = "";
    answerInput.value = "";
    await load();
  } catch (err) {
    qaError.value = err instanceof Error ? err.message : String(err);
  } finally {
    addingQa.value = false;
  }
}

async function resolveDecision(mode: ManualQaMode): Promise<void> {
  if (!pendingAdd.value || !decisionSimilar.value) return;
  deciding.value = true;
  decisionError.value = "";
  try {
    await addManualQa({ ...pendingAdd.value, mode });
    decisionVisible.value = false;
    pendingAdd.value = null;
    decisionSimilar.value = null;
    questionInput.value = "";
    answerInput.value = "";
    await load();
  } catch (err) {
    decisionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    deciding.value = false;
  }
}

async function removePair(id: string): Promise<void> {
  qaError.value = "";
  try {
    await deleteQaPair(id);
    await load();
  } catch (err) {
    qaError.value = err instanceof Error ? err.message : String(err);
  }
}

const mappingCount = computed(() => mappings.value.length);
const pairCount = computed(() => pairs.value.length);

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="terms-qa-view">
    <header class="terms-qa-header">
      <h2 class="terms-qa-title">Terms &amp; QA</h2>
      <span class="terms-qa-meta">
        Semantic mappings + stored Q&amp;A pairs (live query against the DB)
      </span>
      <div class="terms-qa-controls">
        <t-button size="small" variant="outline" :loading="loading" @click="load">
          Refresh
        </t-button>
      </div>
    </header>

    <p v-if="error" class="terms-qa-error">{{ error }}</p>

    <div class="terms-qa-grid">
      <section class="terms-qa-card">
        <h3 class="card-title">
          Semantic Mappings
          <span class="card-count">{{ mappingCount }}</span>
        </h3>
        <p class="card-hint">
          Map a colloquial / company term to its canonical form (e.g. "C-Day" →
          "CALEO Day"). Applied at search time as query expansion.
        </p>

        <div class="mapping-form">
          <t-input
            v-model="termInput"
            size="small"
            placeholder="Colloquial term, e.g. C-Day"
          />
          <t-input
            v-model="canonicalInput"
            size="small"
            placeholder="Canonical form, e.g. CALEO Day"
            @enter="submitMapping"
          />
          <t-button
            size="small"
            variant="outline"
            :loading="addingMapping"
            :disabled="!termInput.trim() || !canonicalInput.trim()"
            @click="submitMapping"
          >
            Add mapping
          </t-button>
        </div>
        <p v-if="mappingError" class="card-error">{{ mappingError }}</p>

        <div class="mapping-list">
          <p v-if="mappings.length === 0" class="list-empty">No mappings yet.</p>
          <div v-for="mapping in mappings" :key="mapping.id" class="mapping-row">
            <span class="mapping-term">{{ mapping.term }}</span>
            <span class="mapping-arrow">→</span>
            <span class="mapping-canonical">{{ mapping.canonical }}</span>
            <t-button
              size="small"
              variant="text"
              theme="danger"
              @click="removeMapping(mapping.id)"
            >
              Delete
            </t-button>
          </div>
        </div>
      </section>

      <section class="terms-qa-card">
        <h3 class="card-title">
          Q&amp;A Pairs
          <span class="card-count">{{ pairCount }}</span>
        </h3>
        <p class="card-hint">
          Stored questions &amp; answers from the feedback loop and manual entry.
        </p>

        <div class="qa-form">
          <t-input
            v-model="questionInput"
            size="small"
            placeholder="Question"
          />
          <t-textarea
            v-model="answerInput"
            size="small"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="Answer"
          />
          <t-button
            size="small"
            variant="outline"
            :loading="addingQa"
            :disabled="!questionInput.trim() || !answerInput.trim()"
            @click="submitQa"
          >
            Add Q&amp;A
          </t-button>
        </div>
        <p v-if="qaError" class="card-error">{{ qaError }}</p>

        <div class="qa-list">
          <p v-if="pairs.length === 0" class="list-empty">No Q&amp;A pairs yet.</p>
          <div v-for="pair in pairs" :key="pair.id" class="qa-row">
            <div class="qa-row-head">
              <span class="qa-question">{{ pair.question }}</span>
              <t-button
                size="small"
                variant="text"
                theme="danger"
                @click="removePair(pair.id)"
              >
                Delete
              </t-button>
            </div>
            <p class="qa-answer">{{ pair.answer }}</p>
            <p v-if="pair.sources.length" class="qa-sources">
              Sources: {{ pair.sources.map((s) => s.title ?? s.path ?? s.wikiPath ?? "").filter(Boolean).join(", ") }}
            </p>
          </div>
        </div>
      </section>
    </div>

    <t-dialog
      v-model:visible="decisionVisible"
      header="Similar Q&amp;A already exists"
      :confirm-btn="{ content: 'Merge answers', theme: 'primary' }"
      :cancel-btn="{ content: 'Cancel' }"
      :confirm-loading="deciding"
      @confirm="resolveDecision('merge')"
    >
      <template #body>
        <p class="decision-hint">
          A stored question is very similar to the one you typed. How should the
          new answer be added?
        </p>
        <p class="decision-similar">
          <strong>{{ decisionSimilar?.question }}</strong>
          <span v-if="decisionSimilar" class="decision-score">
            similarity {{ (decisionSimilar.score * 100).toFixed(0) }}%
          </span>
        </p>
        <div class="decision-actions">
          <t-button size="small" variant="outline" @click="resolveDecision('overwrite')">
            Overwrite existing
          </t-button>
          <t-button size="small" variant="outline" @click="resolveDecision('add-anyway')">
            Add anyway
          </t-button>
        </div>
        <p v-if="decisionError" class="card-error">{{ decisionError }}</p>
      </template>
    </t-dialog>
  </section>
</template>

<style scoped>
.terms-qa-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  height: calc(100dvh - 48px);
  padding: 24px;
  gap: 16px;
  overflow-y: auto;
}

.terms-qa-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.terms-qa-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.terms-qa-meta {
  flex: 1;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.terms-qa-controls {
  display: flex;
  gap: 8px;
}

.terms-qa-error {
  margin: 0;
  padding: 8px 12px;
  color: var(--caleo-error);
  background: color-mix(in srgb, var(--caleo-error) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--caleo-error) 40%, transparent);
  border-radius: 6px;
  font-size: 13px;
}

.terms-qa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  flex: 1;
  align-items: start;
}

.terms-qa-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--caleo-text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-count {
  font-size: 12px;
  font-weight: 500;
  color: var(--caleo-primary);
  background: color-mix(in srgb, var(--caleo-primary) 12%, transparent);
  padding: 1px 8px;
  border-radius: 10px;
}

.card-hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--caleo-text-secondary);
  line-height: 1.5;
}

.mapping-form,
.qa-form {
  display: flex;
  gap: 8px;
  align-items: center;
}

.qa-form {
  flex-direction: column;
  align-items: stretch;
}

.card-error {
  margin: 0;
  color: var(--caleo-error);
  font-size: 12.5px;
}

.mapping-list,
.qa-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.list-empty {
  margin: 0;
  color: var(--caleo-text-secondary);
  font-size: 13px;
}

.mapping-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
}

.mapping-term {
  font-weight: 600;
  color: var(--caleo-text);
  font-size: 13px;
}

.mapping-arrow {
  color: var(--caleo-text-secondary);
}

.mapping-canonical {
  flex: 1;
  color: var(--caleo-primary);
  font-size: 13px;
}

.qa-row {
  padding: 8px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.qa-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.qa-question {
  font-weight: 600;
  font-size: 13px;
  color: var(--caleo-text);
}

.qa-answer {
  margin: 0;
  font-size: 12.5px;
  color: var(--caleo-text);
  white-space: pre-wrap;
  line-height: 1.5;
}

.qa-sources {
  margin: 0;
  font-size: 11.5px;
  color: var(--caleo-text-secondary);
}

.decision-hint {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--caleo-text);
}

.decision-similar {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.decision-score {
  color: var(--caleo-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.decision-actions {
  display: flex;
  gap: 8px;
}
</style>

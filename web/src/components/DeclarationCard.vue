<script setup lang="ts">
import { computed, ref } from "vue";
import {
  registerDeclaration,
  type PendingAgentDeclaration,
  type LogoRecord,
} from "@/api/agents";

const props = defineProps<{
  declaration: PendingAgentDeclaration;
  logos: LogoRecord[];
}>();

const emit = defineEmits<{ registered: [id: string] }>();

const DEFAULT_LOGO = "/athena-logo-ai.png";

const alias = ref("");
const owner = ref("employee");
const logoUrl = ref(DEFAULT_LOGO);
const submitting = ref(false);
const error = ref("");

const logoOptions = computed(() => [
  { url: DEFAULT_LOGO, label: "Owl", animal: "owl", color: "athena" },
  ...props.logos.map((logo) => ({
    url: logo.url,
    label: logo.name,
    animal: logo.animal ?? "",
    color: logo.color ?? "",
  })),
]);

function selectLogo(url: string) {
  logoUrl.value = url;
}

async function confirm() {
  if (!alias.value.trim()) {
    error.value = "Alias is required";
    return;
  }
  if (!owner.value.trim()) {
    error.value = "Owner is required";
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    await registerDeclaration(props.declaration.id, {
      alias: alias.value.trim(),
      owner_employee_id: owner.value.trim(),
      logo_url: logoUrl.value,
    });
    emit("registered", props.declaration.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <article class="declaration-card">
    <header class="decl-header">
      <div class="decl-id">
        <span class="decl-agent-id">{{ declaration.agent_id }}</span>
        <span class="decl-runtime">runtime: {{ declaration.runtime || "unknown" }}</span>
      </div>
      <span class="decl-system">{{ declaration.capabilities.system }}</span>
    </header>

    <section class="decl-capabilities">
      <div v-if="declaration.capabilities.specialty" class="decl-specialty">
        specialty: {{ declaration.capabilities.specialty }}
      </div>
      <div v-if="declaration.capabilities.description" class="decl-description">
        {{ declaration.capabilities.description }}
      </div>
      <ul class="decl-caps-list">
        <li v-for="item in declaration.capabilities.mcp" :key="`mcp-${item}`">
          <span class="caps-label">mcp</span><span>{{ item }}</span>
        </li>
        <li v-for="item in declaration.capabilities.tools" :key="`tool-${item}`">
          <span class="caps-label">tool</span><span>{{ item }}</span>
        </li>
        <li v-for="item in declaration.capabilities.skills" :key="`skill-${item}`">
          <span class="caps-label">skill</span><span>{{ item }}</span>
        </li>
      </ul>
    </section>

    <section class="decl-form">
      <div class="decl-field">
        <label for="decl-alias">Alias</label>
        <input id="decl-alias" class="decl-alias" v-model="alias" placeholder="e.g. Hermes" />
      </div>
      <div class="decl-field">
        <label for="decl-owner">Owner</label>
        <input id="decl-owner" class="decl-owner" v-model="owner" />
      </div>
      <div class="decl-field">
        <span class="decl-field-label">Logo</span>
        <div class="decl-logos">
          <button
            v-for="logo in logoOptions"
            :key="logo.url"
            type="button"
            class="logo-option"
            :class="{ 'is-selected': logoUrl === logo.url }"
            :data-url="logo.url"
            :title="`${logo.animal} ${logo.color}`"
            @click="selectLogo(logo.url)"
          >
            <img :src="logo.url" :alt="logo.label" />
          </button>
        </div>
      </div>
      <p v-if="error" class="decl-error">{{ error }}</p>
      <button type="button" class="decl-confirm" :disabled="submitting" @click="confirm">
        {{ submitting ? "Registering…" : "Confirm registration" }}
      </button>
    </section>
  </article>
</template>

<style scoped>
.declaration-card {
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  background: var(--caleo-card-bg, #fff);
}

.decl-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.decl-id {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.decl-agent-id {
  font-weight: 600;
}

.decl-runtime {
  font-size: 12px;
  opacity: 0.7;
}

.decl-system {
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 12px;
}

.decl-specialty,
.decl-description {
  font-size: 13px;
  margin-bottom: 6px;
}

.decl-caps-list {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.decl-caps-list li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 12px;
}

.caps-label {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  opacity: 0.6;
}

.decl-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.decl-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.decl-field label,
.decl-field-label {
  font-size: 13px;
  font-weight: 600;
}

.decl-alias,
.decl-owner {
  padding: 8px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  font-size: 14px;
}

.decl-logos {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.logo-option {
  border: 2px solid transparent;
  border-radius: 8px;
  padding: 4px;
  cursor: pointer;
  background: transparent;
}

.logo-option img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.logo-option.is-selected {
  border-color: var(--caleo-primary, #ff6633);
}

.decl-error {
  color: #d54941;
  font-size: 13px;
}

.decl-confirm {
  align-self: flex-start;
  padding: 8px 16px;
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.decl-confirm:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

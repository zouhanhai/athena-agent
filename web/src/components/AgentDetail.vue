<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  confirmAgent,
  registerDeclaration,
  updateAgent,
  type AgentRecord,
  type AgentCapabilities,
  type LogoRecord,
  type PendingAgentDeclaration,
} from "@/api/agents";
import { useAuthStore } from "@/stores/auth";

const props = defineProps<{
  /** A registered agent (review + confirm + edit). Mutually exclusive with `declaration`. */
  agent?: AgentRecord | null;
  /** A pending self-declaration awaiting an owner review (assign alias + logo). */
  declaration?: PendingAgentDeclaration | null;
  logos: LogoRecord[];
}>();

const emit = defineEmits<{ close: []; updated: [] }>();

const auth = useAuthStore();

const DEFAULT_LOGO = "/athena-logo-ai.png";

const isDeclaration = computed(() => !!props.declaration);

const STATUS_LABEL: Record<AgentRecord["status"], string> = {
  unknown: "unknown",
  invited: "invited",
  registered: "registered",
  reachable: "reachable",
};

// ----- logo picker (reuses the owl + generated/uploaded logo set) -----
const logoOptions = computed(() => {
  const urls = new Set<string>([DEFAULT_LOGO]);
  const current =
    props.agent?.logo_url || (isDeclaration.value ? DEFAULT_LOGO : "") || "";
  if (current) {
    urls.add(current);
  }
  for (const logo of props.logos) {
    urls.add(logo.url);
  }
  const options = [{ url: DEFAULT_LOGO, label: "Owl", animal: "owl", color: "athena" }];
  for (const logo of props.logos) {
    if (urls.has(logo.url)) {
      options.push({
        url: logo.url,
        label: logo.name,
        animal: logo.animal ?? "",
        color: logo.color ?? "",
      });
    }
  }
  return options;
});

function selectLogo(url: string) {
  logoUrl.value = url;
}

// ----- declaration review (merged DeclarationCard surface) -----
const declAlias = ref("");
const declOwner = ref("");
const declSubmitting = ref(false);
const declError = ref("");

// G4.S7.T9: when the declaring agent was invited first, prefill alias + owner
// email from the invite-time values (suggested_*), falling back to the signed-in
// user's email when the declaration has no invite info.
watch(
  () => props.declaration,
  (declaration) => {
    if (declaration) {
      declAlias.value = declaration.suggested_alias ?? "";
      declOwner.value = declaration.suggested_owner_email ?? auth.employee?.email ?? "";
      logoUrl.value = DEFAULT_LOGO;
    }
  },
  { immediate: true },
);

async function confirmDeclaration() {
  if (!props.declaration) {
    return;
  }
  if (!declAlias.value.trim()) {
    declError.value = "Alias is required";
    return;
  }
  if (!declOwner.value.trim()) {
    declError.value = "Owner is required";
    return;
  }
  declSubmitting.value = true;
  declError.value = "";
  try {
    await registerDeclaration(props.declaration.id, {
      alias: declAlias.value.trim(),
      owner_employee_id: declOwner.value.trim(),
      logo_url: logoUrl.value,
    });
    emit("updated");
  } catch (err) {
    declError.value = err instanceof Error ? err.message : String(err);
  } finally {
    declSubmitting.value = false;
  }
}

// ----- agent review + confirm -----
const confirming = ref(false);
const confirmError = ref("");

async function confirmCapabilities() {
  const agent = props.agent;
  if (!agent || !auth.sessionToken) {
    confirmError.value = "You must be signed in to confirm an agent";
    return;
  }
  confirming.value = true;
  confirmError.value = "";
  try {
    await confirmAgent(agent.agent_id, auth.sessionToken);
    emit("updated");
  } catch (err) {
    confirmError.value = err instanceof Error ? err.message : String(err);
  } finally {
    confirming.value = false;
  }
}

// ----- agent edit (alias + logo + capabilities) -----
const alias = ref("");
const logoUrl = ref(DEFAULT_LOGO);
const capsSystem = ref("");
const capsSpecialty = ref("");
const capsDescription = ref("");
const capsMcp = ref("");
const capsTools = ref("");
const capsSkills = ref("");
const capsTags = ref("");
const capsExamples = ref("");
const editing = ref(false);
const saving = ref(false);
const saveError = ref("");

function serializeCapabilities(caps: AgentCapabilities): void {
  capsSystem.value = caps.system;
  capsSpecialty.value = caps.specialty;
  capsDescription.value = caps.description ?? "";
  capsMcp.value = caps.mcp.join(", ");
  capsTools.value = caps.tools.join(", ");
  capsSkills.value = caps.skills.join(", ");
  capsTags.value = (caps.tags ?? []).join(", ");
  capsExamples.value = (caps.examples ?? []).join("\n");
}

function resetEditState(): void {
  const agent = props.agent;
  if (agent) {
    alias.value = agent.alias;
    logoUrl.value = agent.logo_url || DEFAULT_LOGO;
    serializeCapabilities(agent.capabilities);
  } else {
    alias.value = "";
    logoUrl.value = DEFAULT_LOGO;
  }
}

watch(() => props.agent, resetEditState, { immediate: true });

function splitCsv(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function splitLines(text: string): string[] {
  return text.split("\n").map((item) => item.trim()).filter(Boolean);
}

function buildCapabilities(): AgentCapabilities {
  const caps: AgentCapabilities = {
    system: capsSystem.value.trim(),
    mcp: splitCsv(capsMcp.value),
    tools: splitCsv(capsTools.value),
    skills: splitCsv(capsSkills.value),
    specialty: capsSpecialty.value.trim(),
  };
  const description = capsDescription.value.trim();
  if (description) {
    caps.description = description;
  }
  const tags = splitCsv(capsTags.value);
  if (tags.length) {
    caps.tags = tags;
  }
  const examples = splitLines(capsExamples.value);
  if (examples.length) {
    caps.examples = examples;
  }
  return caps;
}

async function saveEdit() {
  const agent = props.agent;
  if (!agent) {
    return;
  }
  if (!alias.value.trim()) {
    saveError.value = "Alias is required";
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    const patch: { alias?: string; logo_url?: string; capabilities?: AgentCapabilities } = {};
    if (alias.value.trim() !== agent.alias) {
      patch.alias = alias.value.trim();
    }
    if (logoUrl.value !== (agent.logo_url || DEFAULT_LOGO)) {
      patch.logo_url = logoUrl.value;
    }
    const caps = buildCapabilities();
    if (JSON.stringify(caps) !== JSON.stringify(agent.capabilities)) {
      // A capability change re-opens pending review; the owner must re-confirm.
      patch.capabilities = caps;
    }
    if (Object.keys(patch).length === 0) {
      editing.value = false;
      return;
    }
    await updateAgent(agent.alias, patch);
    emit("updated");
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="agent-detail">
    <header class="detail-header">
      <h4 class="detail-title">
        {{ isDeclaration ? "Review agent declaration" : "Agent details" }}
      </h4>
      <button type="button" class="detail-close" @click="emit('close')">Close</button>
    </header>

    <!-- Registered agent: identity + capabilities + reachability + review -->
    <template v-if="agent">
      <div class="detail-identity">
        <img class="detail-logo" :src="agent.logo_url || DEFAULT_LOGO" :alt="agent.alias" />
        <div class="detail-headline">
          <div class="detail-name-row">
            <span class="detail-name">{{ agent.alias }}</span>
            <span class="status-badge" :class="`status-${agent.status}`">
              {{ STATUS_LABEL[agent.status] }}
            </span>
            <span v-if="agent.connected" class="detail-connected" title="Live reverse-WS tunnel">
              connected
            </span>
          </div>
          <span class="detail-id">{{ agent.agent_id }}</span>
        </div>
      </div>

      <dl class="detail-meta">
        <div class="detail-meta-row">
          <dt>Owner</dt>
          <dd>{{ agent.owner_email || agent.owner_employee_id }}</dd>
        </div>
        <div class="detail-meta-row">
          <dt>Runtime</dt>
          <dd>{{ agent.runtime || "—" }}</dd>
        </div>
        <div class="detail-meta-row">
          <dt>Reachability</dt>
          <dd>
            <span v-if="agent.api_url" class="detail-url">{{ agent.api_url }}</span>
            <span v-else>—</span>
            <span v-if="agent.status === 'reachable'" class="detail-reach-note">
              (connected within the reachability window)
            </span>
          </dd>
        </div>
      </dl>

      <div class="detail-capabilities">
        <h5 class="detail-section-title">Declared capabilities</h5>
        <div class="cap-group">
          <span class="caps-label">system</span>
          <span class="cap-chip cap-chip-accent">{{ agent.capabilities.system }}</span>
        </div>
        <div class="cap-group">
          <span class="caps-label">specialty</span>
          <span class="cap-chip">{{ agent.capabilities.specialty }}</span>
        </div>
        <p v-if="agent.capabilities.description" class="cap-description">
          {{ agent.capabilities.description }}
        </p>
        <div v-for="(group, key) in [
          { key: 'mcp', label: 'mcp', items: agent.capabilities.mcp },
          { key: 'tools', label: 'tools', items: agent.capabilities.tools },
          { key: 'skills', label: 'skills', items: agent.capabilities.skills },
          { key: 'tags', label: 'tags', items: agent.capabilities.tags ?? [] },
          { key: 'examples', label: 'examples', items: agent.capabilities.examples ?? [] },
        ]" :key="key" class="cap-group">
          <span class="caps-label">{{ group.label }}</span>
          <span v-if="group.items.length === 0" class="cap-empty">—</span>
          <ul v-else class="cap-chip-list">
            <li v-for="item in group.items" :key="item" class="cap-chip">{{ item }}</li>
          </ul>
        </div>
      </div>

      <div class="detail-review" :class="{ 'is-pending': agent.capabilities_pending_review }">
        <template v-if="agent.capabilities_pending_review">
          <p class="review-note">
            Capabilities changed — review and confirm to approve the agent.
          </p>
          <button type="button" class="detail-confirm" :disabled="confirming" @click="confirmCapabilities">
            {{ confirming ? "Confirming…" : "Confirm capabilities" }}
          </button>
        </template>
        <template v-else>
          <p class="review-note review-ok">
            Capabilities approved. Editing the capabilities will require a re-confirmation.
          </p>
        </template>
        <p v-if="confirmError" class="detail-error">{{ confirmError }}</p>
      </div>

      <div class="detail-edit">
        <button type="button" class="detail-edit-toggle" @click="editing = !editing">
          {{ editing ? "Cancel editing" : "Edit alias, logo or capabilities" }}
        </button>

        <div v-if="editing" class="detail-edit-form">
          <div class="detail-field">
            <label for="detail-alias">Alias</label>
            <input id="detail-alias" class="detail-alias" v-model="alias" />
          </div>

          <div class="detail-field">
            <span class="detail-field-label">Logo</span>
            <div class="detail-logos">
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

          <div class="detail-field">
            <label for="detail-caps-system">System</label>
            <input id="detail-caps-system" class="caps-system" v-model="capsSystem" />
          </div>
          <div class="detail-field">
            <label for="detail-caps-specialty">Specialty</label>
            <input id="detail-caps-specialty" class="caps-specialty" v-model="capsSpecialty" />
          </div>
          <div class="detail-field">
            <label for="detail-caps-description">Description</label>
            <input id="detail-caps-description" class="caps-description" v-model="capsDescription" />
          </div>
          <div class="detail-field">
            <label for="detail-caps-mcp">MCP servers (comma-separated)</label>
            <input id="detail-caps-mcp" class="caps-mcp" v-model="capsMcp" />
          </div>
          <div class="detail-field">
            <label for="detail-caps-tools">Tools (comma-separated)</label>
            <input id="detail-caps-tools" class="caps-tools" v-model="capsTools" />
          </div>
          <div class="detail-field">
            <label for="detail-caps-skills">Skills (comma-separated)</label>
            <input id="detail-caps-skills" class="caps-skills" v-model="capsSkills" />
          </div>
          <div class="detail-field">
            <label for="detail-caps-tags">Tags (comma-separated)</label>
            <input id="detail-caps-tags" class="caps-tags" v-model="capsTags" />
          </div>
          <div class="detail-field">
            <label for="detail-caps-examples">Examples (one per line)</label>
            <textarea id="detail-caps-examples" class="caps-examples" v-model="capsExamples" rows="2"></textarea>
          </div>

          <p v-if="saveError" class="detail-error">{{ saveError }}</p>
          <button type="button" class="detail-save" :disabled="saving" @click="saveEdit">
            {{ saving ? "Saving…" : "Save changes" }}
          </button>
          <p class="detail-edit-note">
            Saving a capability change puts the agent back into pending review — you must
            confirm it again before it is approved.
          </p>
        </div>
      </div>
    </template>

    <!-- Pending declaration: review declared capabilities, then assign alias + logo -->
    <template v-else-if="declaration">
      <div class="detail-declaration">
        <div class="detail-identity">
          <div class="detail-headline">
            <div class="detail-name-row">
              <span class="detail-name">{{ declaration.agent_id }}</span>
              <span class="status-badge status-invited">pending</span>
            </div>
            <span class="detail-id">runtime: {{ declaration.runtime || "unknown" }}</span>
          </div>
        </div>

        <div class="detail-capabilities">
          <h5 class="detail-section-title">Declared capabilities</h5>
          <div class="cap-group">
            <span class="caps-label">system</span>
            <span class="cap-chip cap-chip-accent">{{ declaration.capabilities.system }}</span>
          </div>
          <div class="cap-group">
            <span class="caps-label">specialty</span>
            <span class="cap-chip">{{ declaration.capabilities.specialty }}</span>
          </div>
          <p v-if="declaration.capabilities.description" class="cap-description">
            {{ declaration.capabilities.description }}
          </p>
          <div v-for="(group, key) in [
            { key: 'mcp', label: 'mcp', items: declaration.capabilities.mcp },
            { key: 'tools', label: 'tools', items: declaration.capabilities.tools },
            { key: 'skills', label: 'skills', items: declaration.capabilities.skills },
            { key: 'tags', label: 'tags', items: declaration.capabilities.tags ?? [] },
            { key: 'examples', label: 'examples', items: declaration.capabilities.examples ?? [] },
          ]" :key="key" class="cap-group">
            <span class="caps-label">{{ group.label }}</span>
            <span v-if="group.items.length === 0" class="cap-empty">—</span>
            <ul v-else class="cap-chip-list">
              <li v-for="item in group.items" :key="item" class="cap-chip">{{ item }}</li>
            </ul>
          </div>
        </div>

        <div class="detail-decl-form">
          <div class="detail-field">
            <label for="decl-alias">Alias</label>
            <input id="decl-alias" class="decl-alias" v-model="declAlias" placeholder="e.g. Hermes" />
          </div>
          <div class="detail-field">
            <label for="decl-owner">Owner (email)</label>
            <input id="decl-owner" class="decl-owner" v-model="declOwner" placeholder="zouha108@caleo.com" autocomplete="email" />
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Logo</span>
            <div class="detail-logos">
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
          <p v-if="declError" class="detail-error">{{ declError }}</p>
          <button type="button" class="detail-register" :disabled="declSubmitting" @click="confirmDeclaration">
            {{ declSubmitting ? "Registering…" : "Confirm registration" }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.agent-detail {
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 8px;
  padding: 16px;
  background: var(--caleo-card-bg);
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.detail-title {
  margin: 0;
  font-size: 15px;
  color: var(--caleo-text);
}

.detail-close {
  padding: 4px 10px;
  background: transparent;
  color: var(--caleo-text);
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.detail-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.detail-logo {
  width: 48px;
  height: 48px;
  object-fit: contain;
  flex-shrink: 0;
}

.detail-headline {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.detail-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-name {
  font-weight: 600;
  font-size: 16px;
}

.detail-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  opacity: 0.7;
  word-break: break-all;
}

.detail-connected {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #166534;
  background: #dcfce7;
  border-radius: 999px;
  padding: 1px 8px;
}

.status-badge {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  border-radius: 999px;
  padding: 1px 8px;
}

.status-reachable {
  color: #166534;
  background: #dcfce7;
}

.status-registered {
  color: #1e40af;
  background: #dbeafe;
}

.status-invited {
  color: #92400e;
  background: #fef3c7;
}

.status-unknown {
  color: var(--caleo-text-secondary);
  background: rgba(128, 128, 128, 0.15);
}

.detail-meta {
  margin: 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-meta-row {
  display: flex;
  gap: 8px;
  font-size: 13px;
}

.detail-meta-row dt {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 11px;
  opacity: 0.6;
  min-width: 90px;
}

.detail-meta-row dd {
  margin: 0;
  word-break: break-all;
}

.detail-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.detail-reach-note {
  opacity: 0.7;
}

.detail-capabilities {
  margin-bottom: 12px;
}

.detail-section-title {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--caleo-text);
}

.cap-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 13px;
}

.caps-label {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  opacity: 0.6;
  min-width: 60px;
}

.cap-chip-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cap-chip {
  display: inline-block;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 12px;
}

.cap-chip-accent {
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border-color: transparent;
}

.cap-empty {
  opacity: 0.5;
}

.cap-description {
  font-size: 13px;
  margin: 0 0 6px;
}

.detail-review {
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
  background: rgba(0, 0, 0, 0.03);
}

.detail-review.is-pending {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.08);
}

.review-note {
  margin: 0 0 8px;
  font-size: 13px;
}

.review-ok {
  color: #166534;
  margin: 0;
}

.detail-confirm,
.detail-register,
.detail-save {
  padding: 8px 16px;
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.detail-confirm:disabled,
.detail-register:disabled,
.detail-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.detail-edit {
  border-top: 1px solid var(--caleo-border, #ddd);
  padding-top: 12px;
}

.detail-edit-toggle {
  padding: 6px 12px;
  background: var(--caleo-surface, #fff);
  color: var(--caleo-text);
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.detail-edit-form,
.detail-decl-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.detail-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-field label,
.detail-field-label {
  font-size: 13px;
  font-weight: 600;
}

.detail-field input,
.detail-field textarea {
  padding: 8px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
}

.detail-logos {
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

.detail-error {
  color: var(--caleo-error);
  font-size: 13px;
  margin: 0;
}

.detail-edit-note {
  font-size: 12px;
  opacity: 0.7;
  margin: 0;
}
</style>
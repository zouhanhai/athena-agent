<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  createAgent,
  deleteAgent,
  inviteAgent,
  listAgents,
  listDeclarations,
  listLogos,
  type AgentInvite,
  type AgentRecord,
  type LogoRecord,
  type PendingAgentDeclaration,
} from "@/api/agents";
import DeclarationCard from "@/components/DeclarationCard.vue";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const isAdmin = computed(() => auth.employee?.role === "admin");
const currentUserId = computed(() => auth.employee?.id ?? "");

const declarations = ref<PendingAgentDeclaration[]>([]);
const agents = ref<AgentRecord[]>([]);
const logos = ref<LogoRecord[]>([]);
const loading = ref(false);
const error = ref("");

// Settings shows only the agents the current user owns/registered (their own
// agents). The Admin page (AdminView) shows all agents grouped per employee.
// The platform default agent (owner_employee_id === "system", e.g. Athena) is
// never shown here. Register + Invite stay available so a user can provision
// their own agents.
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [decls, agentList, logoList] = await Promise.all([
      listDeclarations(),
      listAgents(),
      listLogos({ excludeInUse: true }),
    ]);
    declarations.value = decls;
    agents.value = agentList.filter(
      (a) => a.owner_employee_id !== "system" && a.owner_employee_id === currentUserId.value,
    );
    logos.value = logoList;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function onRegistered(id: string) {
  declarations.value = declarations.value.filter((d) => d.id !== id);
  load();
}

async function onDeleteAgent(agent: AgentRecord) {
  if (!auth.sessionToken) {
    error.value = "You must be signed in to delete an agent";
    return;
  }
  if (!window.confirm(`Delete agent "${agent.alias}"? This cancels its invitation / removes it.`)) {
    return;
  }
  try {
    await deleteAgent(agent.agent_id, auth.sessionToken);
    agents.value = agents.value.filter((a) => a.agent_id !== agent.agent_id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const STATUS_LABEL: Record<AgentRecord["status"], string> = {
  unknown: "unknown",
  invited: "invited",
  registered: "registered",
  reachable: "reachable",
};

// Manual register (POST /api/agents, G3.S2.T9 reborn with G4.S7.T2 remote fields)
const manualOpen = ref(false);
const manual = ref({ alias: "", owner: "employee", apiUrl: "", system: "remote", specialty: "general", runtime: "" });
const manualError = ref("");
const manualSubmitting = ref(false);

async function submitManual() {
  if (!manual.value.alias.trim()) {
    manualError.value = "Alias is required";
    return;
  }
  if (!manual.value.owner.trim()) {
    manualError.value = "Owner is required";
    return;
  }
  manualSubmitting.value = true;
  manualError.value = "";
  try {
    await createAgent({
      alias: manual.value.alias.trim(),
      owner_employee_id: manual.value.owner.trim(),
      api_url: manual.value.apiUrl.trim() || undefined,
      runtime: manual.value.runtime.trim() || undefined,
      capabilities: {
        system: manual.value.system.trim() || "remote",
        mcp: [],
        tools: [],
        skills: [],
        specialty: manual.value.specialty.trim() || "general",
      },
    });
    manual.value = { alias: "", owner: "employee", apiUrl: "", system: "remote", specialty: "general", runtime: "" };
    manualOpen.value = false;
    await load();
  } catch (err) {
    manualError.value = err instanceof Error ? err.message : String(err);
  } finally {
    manualSubmitting.value = false;
  }
}

// Invitation (POST /api/agents/invite → {agent_id, api_url, token})
const inviteOpen = ref(false);
const invite = ref({ alias: "", owner: "" });
const inviteResult = ref<AgentInvite | null>(null);
const inviteError = ref("");
const inviteSubmitting = ref(false);

async function submitInvite() {
  if (!invite.value.alias.trim()) {
    inviteError.value = "Alias is required";
    return;
  }
  if (!invite.value.owner.trim()) {
    inviteError.value = "Owner email is required";
    return;
  }
  if (!auth.sessionToken) {
    inviteError.value = "You must be signed in to invite an agent";
    return;
  }
  inviteSubmitting.value = true;
  inviteError.value = "";
  inviteResult.value = null;
  try {
    const result = await inviteAgent(auth.sessionToken, {
      alias: invite.value.alias.trim(),
      owner_employee_id: invite.value.owner.trim(),
    });
    inviteResult.value = result.invite;
    invite.value = { alias: "", owner: "" };
    inviteOpen.value = false;
    await load();
  } catch (err) {
    inviteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    inviteSubmitting.value = false;
  }
}

function copyInviteToken() {
  if (inviteResult.value) {
    navigator.clipboard?.writeText(inviteResult.value.token);
  }
}

onMounted(load);
</script>

<template>
  <div class="agent-management">
    <p class="am-intro">
      Connected agents auto-declare their capabilities. Review each declaration,
      then assign an alias and logo to register the agent.
    </p>
    <p v-if="error" class="am-error">{{ error }}</p>
    <p v-if="loading" class="am-loading">Loading agents…</p>

    <section v-if="agents.length > 0" class="am-section">
      <h4 class="am-section-title">Registered agents</h4>
      <ul class="agent-status-list">
        <li v-for="agent in agents" :key="agent.id" class="agent-status-row">
          <img class="agent-status-logo" :src="agent.logo_url || '/athena-logo-ai.png'" :alt="agent.alias" />
          <div class="agent-status-body">
            <div class="agent-status-head">
              <span class="agent-status-name">{{ agent.alias }}</span>
              <span class="status-badge" :class="`status-${agent.status}`">
                {{ STATUS_LABEL[agent.status] }}
              </span>
            </div>
            <div class="agent-status-meta">
              <span class="agent-status-id">{{ agent.agent_id }}</span>
              <span v-if="agent.api_url" class="agent-status-url">{{ agent.api_url }}</span>
            </div>
            <p v-if="agent.capabilities.specialty || agent.capabilities.system" class="agent-status-caps">
              {{ agent.capabilities.system }} · {{ agent.capabilities.specialty }}
            </p>
          </div>
          <button type="button" class="am-delete" title="Delete agent" @click="onDeleteAgent(agent)">
            Delete
          </button>
        </li>
      </ul>
    </section>

    <div v-if="isAdmin" class="am-admin">
      <div class="am-admin-actions">
        <button type="button" class="am-action" @click="manualOpen = !manualOpen">
          {{ manualOpen ? "Cancel register" : "Register agent" }}
        </button>
        <button type="button" class="am-action" @click="inviteOpen = !inviteOpen">
          {{ inviteOpen ? "Cancel invite" : "Invite agent" }}
        </button>
      </div>

      <form v-if="manualOpen" class="am-form" @submit.prevent="submitManual">
        <h5 class="am-form-title">Register agent manually</h5>
        <div class="am-field">
          <label for="manual-alias">Alias</label>
          <input id="manual-alias" class="am-input" v-model="manual.alias" placeholder="e.g. Hermes" />
        </div>
        <div class="am-field">
          <label for="manual-owner">Owner</label>
          <input id="manual-owner" class="am-input" v-model="manual.owner" placeholder="employee id" />
        </div>
        <div class="am-field">
          <label for="manual-api-url">API URL (reachability)</label>
          <input id="manual-api-url" class="am-input" v-model="manual.apiUrl" placeholder="http://hermes.local:3001" />
        </div>
        <div class="am-field">
          <label for="manual-system">Capability system</label>
          <input id="manual-system" class="am-input" v-model="manual.system" placeholder="e.g. hermes" />
        </div>
        <div class="am-field">
          <label for="manual-specialty">Capability specialty</label>
          <input id="manual-specialty" class="am-input" v-model="manual.specialty" placeholder="e.g. integration" />
        </div>
        <div class="am-field">
          <label for="manual-runtime">Runtime (optional)</label>
          <input id="manual-runtime" class="am-input" v-model="manual.runtime" placeholder="e.g. local" />
        </div>
        <p v-if="manualError" class="am-error">{{ manualError }}</p>
        <button type="submit" class="am-submit" :disabled="manualSubmitting">
          {{ manualSubmitting ? "Registering…" : "Register agent" }}
        </button>
      </form>

      <form v-if="inviteOpen" class="am-form" @submit.prevent="submitInvite">
        <h5 class="am-form-title">Invite a remote agent</h5>
        <div class="am-field">
          <label for="invite-alias">Alias</label>
          <input id="invite-alias" class="am-input" v-model="invite.alias" placeholder="e.g. wts" />
        </div>
        <div class="am-field">
          <label for="invite-owner">Owner email</label>
          <input id="invite-owner" class="am-input" v-model="invite.owner" placeholder="owner@caleo.com" />
        </div>
        <p v-if="inviteError" class="am-error">{{ inviteError }}</p>
        <button type="submit" class="am-submit" :disabled="inviteSubmitting">
          {{ inviteSubmitting ? "Generating…" : "Generate invitation" }}
        </button>
      </form>

      <div v-if="inviteResult" class="invite-result">
        <h5 class="am-form-title">Hand this invitation to the remote agent</h5>
        <p class="invite-note">
          The token below is shown once — the platform stores only its hash. The agent
          registers auth'd via <code>POST /api/agents/register</code> with
          <code>{agent_id, api_url, token}</code>.
        </p>
        <dl class="invite-fields">
          <div class="invite-row">
            <dt>agent_id</dt>
            <dd class="invite-code">{{ inviteResult.agent_id }}</dd>
          </div>
          <div class="invite-row">
            <dt>api_url</dt>
            <dd class="invite-code">{{ inviteResult.api_url || "(set at registration)" }}</dd>
          </div>
          <div class="invite-row">
            <dt>token</dt>
            <dd class="invite-code">{{ inviteResult.token }}</dd>
          </div>
        </dl>
        <button type="button" class="am-action" @click="copyInviteToken">Copy token</button>
      </div>
    </div>

    <p
      v-if="!loading && !error && declarations.length === 0 && agents.length === 0"
      class="am-empty"
    >
      No agents yet. Agents connect and self-declare via POST /api/agents/self-declare,
      or an admin invites / registers one.
    </p>

    <DeclarationCard
      v-for="decl in declarations"
      :key="decl.id"
      :declaration="decl"
      :logos="logos"
      @registered="onRegistered"
    />
  </div>
</template>

<style scoped>
.am-intro {
  margin: 0 0 12px;
  font-size: 13px;
  opacity: 0.8;
}

.am-error {
  color: var(--caleo-error);
}

.am-empty,
.am-loading {
  opacity: 0.7;
}

.am-section {
  margin-bottom: 16px;
}

.am-section-title,
.am-form-title {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--caleo-text);
}

.agent-status-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-status-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 8px;
  background: var(--caleo-card-bg);
}

.agent-status-logo {
  width: 36px;
  height: 36px;
  object-fit: contain;
  flex-shrink: 0;
}

.agent-status-body {
  flex: 1;
  min-width: 0;
}

.agent-status-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-status-name {
  font-weight: 600;
  font-size: 14px;
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

.agent-status-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 12px;
  opacity: 0.75;
}

.agent-status-caps {
  margin: 2px 0 0;
  font-size: 12px;
  opacity: 0.75;
}

.am-delete {
  flex-shrink: 0;
  padding: 4px 10px;
  background: transparent;
  color: var(--caleo-error, #b91c1c);
  border: 1px solid currentColor;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.am-delete:hover {
  background: color-mix(in srgb, var(--caleo-error, #b91c1c) 10%, transparent);
}

.am-admin {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.am-admin-actions {
  display: flex;
  gap: 8px;
}

.am-action {
  padding: 6px 12px;
  background: var(--caleo-surface, #fff);
  color: var(--caleo-text);
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.am-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 8px;
  background: var(--caleo-card-bg);
}

.am-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-field label {
  font-size: 13px;
  font-weight: 600;
}

.am-input {
  padding: 8px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  font-size: 14px;
}

.am-submit {
  align-self: flex-start;
  padding: 8px 16px;
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.am-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.invite-result {
  padding: 12px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 8px;
  background: var(--caleo-card-bg);
}

.invite-note {
  font-size: 12px;
  opacity: 0.8;
  margin: 0 0 10px;
}

.invite-fields {
  margin: 0 0 10px;
}

.invite-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.invite-row dt {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  opacity: 0.7;
}

.invite-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
}
</style>
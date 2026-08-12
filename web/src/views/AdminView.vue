<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import {
  listEmployees,
  sendInvite,
  updateEmployee,
  type EmployeeRecord,
  type InviteResult,
} from "@/api/invitations";
import { listAgents, type AgentRecord } from "@/api/agents";

const KB_EDIT = "kb.edit";
const DEFAULT_LOGO = "/athena-logo-ai.png";

const auth = useAuthStore();
const router = useRouter();

const isAdmin = computed(() => auth.employee?.role === "admin");

const employees = ref<EmployeeRecord[]>([]);
const agentsByOwner = ref<Record<string, AgentRecord[]>>({});
const expanded = ref<Set<string>>(new Set());
const loading = ref(false);
const loadError = ref("");

const inviteEmail = ref("");
const inviteResult = ref<InviteResult | null>(null);
const inviting = ref(false);
const inviteError = ref("");
const copied = ref(false);

const inviteTtlDays = computed(() =>
  inviteResult.value
    ? Math.max(1, Math.round(inviteResult.value.expiresInMs / 86_400_000))
    : 7,
);

function ownedAgents(employeeId: string): AgentRecord[] {
  return agentsByOwner.value[employeeId] ?? [];
}

function sessionToken(): string {
  return auth.sessionToken ?? "";
}

function hasKbEdit(employee: EmployeeRecord): boolean {
  return employee.role === "admin" || (employee.permissions ?? []).includes(KB_EDIT);
}

function replaceInList(updated: EmployeeRecord): void {
  const index = employees.value.findIndex((e) => e.id === updated.id);
  if (index >= 0) {
    employees.value[index] = updated;
  }
}

async function loadAll() {
  if (!auth.sessionToken) {
    return;
  }
  loading.value = true;
  loadError.value = "";
  try {
    const [records, agents] = await Promise.all([
      listEmployees(auth.sessionToken),
      listAgents(),
    ]);
    employees.value = records;
    const byOwner: Record<string, AgentRecord[]> = {};
    for (const agent of agents) {
      const key = agent.owner_employee_id;
      (byOwner[key] ??= []).push(agent);
    }
    agentsByOwner.value = byOwner;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function toggleExpand(employeeId: string): void {
  const next = new Set(expanded.value);
  if (next.has(employeeId)) {
    next.delete(employeeId);
  } else {
    next.add(employeeId);
  }
  expanded.value = next;
}

async function changeRole(employee: EmployeeRecord, role: "admin" | "member") {
  if (employee.role === role) {
    return;
  }
  loadError.value = "";
  try {
    const updated = await updateEmployee(sessionToken(), employee.email, { role });
    replaceInList(updated);
    if (updated.email === auth.employee?.email && updated.role !== auth.employee.role) {
      auth.setEmployee(updated);
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

async function toggleKbEdit(employee: EmployeeRecord, enabled: boolean) {
  const current = employee.permissions ?? [];
  const permissions = enabled
    ? current.includes(KB_EDIT)
      ? current
      : [...current, KB_EDIT]
    : current.filter((p) => p !== KB_EDIT);
  loadError.value = "";
  try {
    const updated = await updateEmployee(sessionToken(), employee.email, { permissions });
    replaceInList(updated);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

async function onInvite() {
  const email = inviteEmail.value.trim();
  if (!email) {
    inviteError.value = "An email is required";
    return;
  }
  inviting.value = true;
  inviteError.value = "";
  inviteResult.value = null;
  try {
    inviteResult.value = await sendInvite(email);
    inviteEmail.value = "";
    copied.value = false;
  } catch (err) {
    inviteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    inviting.value = false;
  }
}

async function copyLink() {
  if (!inviteResult.value) {
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(inviteResult.value.inviteUrl);
    }
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    copied.value = false;
  }
}

onMounted(() => {
  if (!isAdmin.value) {
    router.replace("/settings");
    return;
  }
  void loadAll();
});
</script>

<template>
  <section class="admin-page">
    <header class="admin-header">
      <h2 class="admin-title">Admin</h2>
      <span class="admin-meta">
        Employees, permissions and invitations for your workspace
      </span>
    </header>

    <div v-if="isAdmin" class="admin-body">
      <p v-if="loadError" class="admin-error">{{ loadError }}</p>

      <div class="admin-section">
        <h3 class="section-title">Employees</h3>
        <p v-if="loading" class="admin-hint">Loading…</p>
        <p v-else-if="employees.length === 0" class="admin-hint">
          No employees yet. Invite your first colleague below.
        </p>
        <ul v-else class="employee-list">
          <li
            v-for="employee in employees"
            :key="employee.id"
            class="employee-row"
            :data-email="employee.email"
          >
            <div
              class="employee-top"
              :class="{ 'is-expanded': expanded.has(employee.id) }"
              @click="toggleExpand(employee.id)"
            >
              <span class="employee-caret" aria-hidden="true">{{
                expanded.has(employee.id) ? "▾" : "▸"
              }}</span>
              <img
                class="employee-logo"
                :src="employee.logo_url || DEFAULT_LOGO"
                :alt="employee.display_name"
              />
              <div class="employee-identity">
                <span class="employee-name">{{ employee.display_name }}</span>
                <span class="employee-email">{{ employee.email }}</span>
              </div>
              <select
                class="employee-role"
                :value="employee.role"
                :aria-label="`Role for ${employee.email}`"
                @click.stop
                @change="
                  changeRole(
                    employee,
                    ($event.target as HTMLSelectElement).value as 'admin' | 'member',
                  )
                "
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <label
                class="perm-toggle"
                :title="hasKbEdit(employee) ? 'Revoke kb.edit' : 'Grant kb.edit'"
                @click.stop
              >
                <input
                  type="checkbox"
                  :checked="hasKbEdit(employee)"
                  :aria-label="`kb.edit for ${employee.email}`"
                  @change="
                    toggleKbEdit(employee, ($event.target as HTMLInputElement).checked)
                  "
                />
                <span class="perm-label">kb.edit</span>
              </label>
            </div>

            <ul v-if="expanded.has(employee.id)" class="agent-sub">
              <li
                v-for="agent in ownedAgents(employee.id)"
                :key="agent.id"
                class="agent-sub-row"
              >
                <img
                  class="agent-sub-logo"
                  :src="agent.logo_url || DEFAULT_LOGO"
                  :alt="agent.alias"
                />
                <span class="agent-sub-name">{{ agent.alias }}</span>
              </li>
              <li v-if="ownedAgents(employee.id).length === 0" class="agent-sub-empty">
                No agents owned by this employee
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <div class="admin-section">
        <h3 class="section-title">Invitations</h3>
        <p class="admin-hint">
          Invitation links expire after {{ inviteTtlDays }} days.
        </p>
        <div class="invite-form">
          <input
            v-model="inviteEmail"
            class="invite-input"
            placeholder="new@caleo.com"
            aria-label="Email to invite"
            @keyup.enter="onInvite"
          />
          <button
            type="button"
            class="invite-button"
            :disabled="inviting"
            @click="onInvite"
          >
            {{ inviting ? "Generating…" : "Generate invite link" }}
          </button>
        </div>
        <p v-if="inviteError" class="admin-error">{{ inviteError }}</p>
        <div v-if="inviteResult" class="invite-result">
          <code class="invite-link">{{ inviteResult.inviteUrl }}</code>
          <button type="button" class="copy-button" @click="copyLink">
            {{ copied ? "Copied!" : "Copy" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.admin-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  height: calc(100dvh - 48px);
  padding: 24px;
  gap: 16px;
  overflow-y: auto;
}

.admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.admin-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.admin-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.admin-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.admin-section {
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.section-title {
  margin: 0 0 12px;
  font-size: 15px;
  color: var(--caleo-text);
}

.admin-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
  color: var(--caleo-text-secondary);
}

.admin-error {
  margin: 0 0 8px;
  color: var(--caleo-error);
  font-size: 13px;
}

.employee-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.employee-row {
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  background: var(--caleo-body-bg);
}

.employee-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
}

.employee-top.is-expanded {
  border-bottom: 1px solid var(--caleo-border);
}

.employee-caret {
  color: var(--caleo-text-secondary);
  font-size: 12px;
  width: 14px;
  flex-shrink: 0;
}

.employee-logo {
  width: 32px;
  height: 32px;
  object-fit: contain;
  flex-shrink: 0;
}

.employee-identity {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.employee-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--caleo-text);
}

.employee-email {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.employee-role {
  padding: 4px 6px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
}

.perm-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--caleo-text);
  flex-shrink: 0;
}

.perm-label {
  font-weight: 600;
}

.agent-sub {
  list-style: none;
  margin: 0;
  padding: 8px 12px 8px 36px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agent-sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-sub-logo {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.agent-sub-name {
  font-size: 13px;
  color: var(--caleo-text);
}

.agent-sub-empty {
  font-size: 12px;
  color: var(--caleo-text-secondary);
  opacity: 0.7;
}

.invite-form {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.invite-input {
  flex: 1;
  padding: 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  font-size: 14px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
}

.invite-button,
.copy-button {
  padding: 8px 16px;
  background: var(--caleo-primary);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.invite-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.invite-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.invite-link {
  flex: 1;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  font-size: 12px;
  background: var(--caleo-body-bg);
  color: var(--caleo-text);
  overflow-wrap: anywhere;
}
</style>

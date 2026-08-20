<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useAuthStore } from "@/stores/auth";
import { listAgents } from "@/api/agents";
import { listEmployees } from "@/api/invitations";
import AgentCard from "@/components/AgentCard.vue";
import type { AgentRecord } from "@/api/agents";
import type { EmployeeRecord } from "@/api/invitations";
import {
  CONTEXT_THRESHOLD_TOKENS,
  estimateTokens,
  contextMeterState,
  contextMeterPercent,
  formatContextMeter,
} from "@/utils/context";

const chat = useChatStore();
const auth = useAuthStore();
const { messages, loading, error } = storeToRefs(chat);

const input = ref("");
const agentPickerOpen = ref(false);
const employeePickerOpen = ref(false);
const sessionPickerOpen = ref(false);
const availableAgents = ref<AgentRecord[]>([]);
const availableEmployees = ref<EmployeeRecord[]>([]);
const pickerError = ref("");
const expandedAgentId = ref<string | null>(null);

/** G4.S7.T12: compact relative-time label for a session's last activity. */
function relativeTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString();
}

async function toggleSessionPicker() {
  sessionPickerOpen.value = !sessionPickerOpen.value;
  if (sessionPickerOpen.value && chat.sessions.length === 0) {
    await chat.loadSessions();
  }
}

function pickSession(sessionId: string) {
  sessionPickerOpen.value = false;
  void chat.pickSession(sessionId);
}

function startNewChat() {
  sessionPickerOpen.value = false;
  void chat.newChat();
}

/** G4.S7.T13: inline session rename in the picker (edit pencil → input → save). */
const renamingSessionId = ref<string | null>(null);
const renameDraft = ref("");
function startRename(sessionId: string, currentTitle: string) {
  renamingSessionId.value = sessionId;
  renameDraft.value = currentTitle || "";
}
function submitRename(sessionId: string) {
  const draft = renameDraft.value.trim();
  if (draft) {
    void chat.renameSession(sessionId, draft);
  }
  renamingSessionId.value = null;
}
function cancelRename() {
  renamingSessionId.value = null;
}

/** G4.S7.T15: delete one session with a t-dialog confirmation (like the agent
 *  delete flow — never a silent window.confirm). */
const deleteVisible = ref(false);
const deleteTarget = ref<{ session_id: string; title: string } | null>(null);
const deleting = ref(false);
function openDelete(sessionId: string, title: string) {
  deleteTarget.value = { session_id: sessionId, title: title || "Previous chat" };
  deleteVisible.value = true;
}
async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  try {
    await chat.deleteSession(target.session_id);
    deleteVisible.value = false;
    deleteTarget.value = null;
  } finally {
    deleting.value = false;
  }
}

/** G4.S7.T10: estimated tokens of the accumulated user/assistant conversation —
 *  mirrors the server heuristic; drives the context meter in the panel.
 *  G4.S7.T11: includes the assistant's `thinking` and each tool `output` so the
 *  meter matches the server's full-history budget (which counts them too). */
const contextTokens = computed(() => {
  const text = messages.value
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0)
    .map((m) => {
      const parts = [m.content];
      if (m.role === "assistant" && m.thinking) parts.push(m.thinking);
      if (m.role === "assistant" && m.progress) {
        for (const row of m.progress) {
          if (row.output) parts.push(row.output);
        }
      }
      return parts.join("\n");
    })
    .join("\n");
  return estimateTokens(text);
});
const contextMeter = computed(() => {
  const tokens = contextTokens.value;
  return {
    tokens,
    threshold: CONTEXT_THRESHOLD_TOKENS,
    state: contextMeterState(tokens),
    percent: contextMeterPercent(tokens),
    label: formatContextMeter(tokens),
  };
});

// The signed-in employee is the human behind the user bubbles (G3.S2 identity).
// userId (sent with each message so the server attributes who is speaking) is
// derived from the signed-in employee — not typed by hand.
watch(
  () => auth.employee,
  (employee) => {
    if (employee) {
      chat.setUserSpeaker({
        id: employee.id,
        kind: "employee",
        name: employee.display_name || employee.email,
        logoUrl: employee.logo_url,
      });
      chat.userId = employee.id;
      // G4.S7.T12: populate the session picker (cheap list, no message fetch).
      // The conversation starts at a fresh "New chat" empty state until the user
      // picks a prior session (mirrors Hermes' /resume — show the list, let the
      // user choose; do NOT auto-load a full conversation on sign-in).
      void chat.loadSessions();
    }
  },
  { immediate: true },
);

function sendMessage() {
  const text = input.value.trim();
  if (!text || loading.value) return;

  chat.send(text);
  input.value = "";
}

function onKeydown(_value: string, ctx: { e: KeyboardEvent }) {
  if (ctx.e.key === "Enter" && !ctx.e.shiftKey) {
    ctx.e.preventDefault();
    sendMessage();
  }
}

/** Open/close the add-agent picker, loading the agent registry on first open. */
async function toggleAgentPicker() {
  agentPickerOpen.value = !agentPickerOpen.value;
  employeePickerOpen.value = false;
  pickerError.value = "";
  if (agentPickerOpen.value && availableAgents.value.length === 0) {
    try {
      availableAgents.value = await listAgents();
    } catch (err) {
      pickerError.value = err instanceof Error ? err.message : String(err);
    }
  }
}

/** Open/close the add-employee picker, loading employees on first open. */
async function toggleEmployeePicker() {
  employeePickerOpen.value = !employeePickerOpen.value;
  agentPickerOpen.value = false;
  pickerError.value = "";
  if (employeePickerOpen.value && availableEmployees.value.length === 0) {
    try {
      availableEmployees.value = await listEmployees(auth.sessionToken ?? "");
    } catch (err) {
      pickerError.value = err instanceof Error ? err.message : String(err);
    }
  }
}

function pickableAgents() {
  const joined = new Set(chat.participants.map((p) => p.id));
  return availableAgents.value.filter((agent) => !joined.has(agent.alias));
}

function pickableEmployees() {
  const joined = new Set(chat.participants.map((p) => p.id));
  return availableEmployees.value.filter((emp) => !joined.has(emp.id));
}

function addAgent(agent: AgentRecord) {
  chat.onAgentJoined({
    id: agent.alias,
    kind: "agent",
    name: agent.alias,
    logoUrl: agent.logo_url,
    // G4.S7.T4: the registered identity drives reverse-tunnel chat routing.
    agentId: agent.agent_id,
    capabilities: [
      agent.capabilities.specialty,
      ...agent.capabilities.mcp,
      ...agent.capabilities.tools,
      ...agent.capabilities.skills,
    ].filter(Boolean),
  });
  agentPickerOpen.value = false;
}

function addEmployee(emp: EmployeeRecord) {
  chat.onAgentJoined({
    id: emp.id,
    kind: "employee",
    name: emp.display_name || emp.email,
    logoUrl: emp.logo_url,
    capabilities: [emp.role],
  });
  employeePickerOpen.value = false;
}
</script>

<template>
  <aside class="global-chat-panel">
    <section class="participants">
      <h3 class="participants-title">In conversation</h3>
      <!-- G4.S7.T12: session switcher — recent chats (resume) + New chat. Lives
           in the agent-card area per the user's explicit UI request. -->
      <div class="session-switcher">
        <button type="button" class="session-trigger" @click="toggleSessionPicker">
          <span v-if="chat.activeSessionId">
            {{ chat.sessions.find((s) => s.session_id === chat.activeSessionId)?.title || "Current chat" }}
          </span>
          <span v-else>New chat</span>
          <span class="session-caret">▾</span>
        </button>
        <div v-if="sessionPickerOpen" class="session-menu">
          <button type="button" class="session-option session-new" @click="startNewChat">
            <span class="session-option-title">+ New chat</span>
          </button>
          <div v-if="chat.sessions.length === 0" class="session-empty">No previous chats.</div>
          <button
            v-for="s in chat.sessions"
            :key="s.session_id"
            type="button"
            class="session-option"
            :class="{ active: s.session_id === chat.activeSessionId }"
            @click="pickSession(s.session_id)"
          >
            <template v-if="renamingSessionId === s.session_id">
              <input
                v-model="renameDraft"
                class="session-rename-input"
                :placeholder="s.title || 'Chat title'"
                @keyup.enter="submitRename(s.session_id)"
                @keyup.esc="cancelRename"
                @blur="submitRename(s.session_id)"
                @click.stop
              />
            </template>
            <template v-else>
              <span class="session-option-title">{{ s.title || "Previous chat" }}</span>
              <span class="session-option-meta">
                {{ s.message_count }} msg · {{ relativeTime(s.updated_at) }}
              </span>
            </template>
            <span
              v-if="renamingSessionId !== s.session_id"
              class="session-rename"
              title="Rename this chat"
              @click.stop="startRename(s.session_id, s.title)"
            >✏️</span>
            <span
              v-if="renamingSessionId !== s.session_id"
              class="session-delete"
              title="Delete this chat"
              @click.stop="openDelete(s.session_id, s.title)"
            >🗑️</span>
          </button>
        </div>
      </div>
      <div class="agent-cards">
        <AgentCard
          v-for="(participant, idx) in chat.participants"
          :key="participant.id"
          :participant="participant"
          :active="expandedAgentId === participant.id"
          :stack-index="idx"
          @toggle="expandedAgentId = expandedAgentId === participant.id ? null : participant.id"
          @speak-change="(speak) => chat.onSpeakToggleChanged(participant.id, speak)"
          @left="chat.onAgentLeft(participant.id)"
        />
      </div>
      <div class="add-entries">
        <t-button size="small" variant="outline" class="add-agent-entry" @click="toggleAgentPicker">
          + Add agent
        </t-button>
        <t-button size="small" variant="outline" class="add-employee-entry" @click="toggleEmployeePicker">
          + Add employee
        </t-button>
      </div>

      <div v-if="agentPickerOpen" class="picker add-agent-picker">
        <p v-if="pickerError" class="picker-error">{{ pickerError }}</p>
        <button
          v-for="agent in pickableAgents()"
          :key="agent.alias"
          type="button"
          class="picker-option"
          @click="addAgent(agent)"
        >
          <img class="picker-logo" :src="agent.logo_url" alt="" />
          <span>{{ agent.alias }}</span>
          <!-- G4.S7.T4: a live reverse tunnel = the agent is reachable now. -->
          <span class="picker-connectivity" :class="agent.connected ? 'is-live' : 'is-offline'">
            {{ agent.connected ? "Live" : "Offline" }}
          </span>
        </button>
        <p v-if="!pickerError && pickableAgents().length === 0" class="picker-empty">
          No agents available to add.
        </p>
      </div>

      <div v-if="employeePickerOpen" class="picker add-employee-picker">
        <p v-if="pickerError" class="picker-error">{{ pickerError }}</p>
        <button
          v-for="emp in pickableEmployees()"
          :key="emp.id"
          type="button"
          class="picker-option"
          @click="addEmployee(emp)"
        >
          <img class="picker-logo" :src="emp.logo_url" alt="" />
          <span>{{ emp.display_name || emp.email }}</span>
        </button>
        <p v-if="!pickerError && pickableEmployees().length === 0" class="picker-empty">
          No employees available to add.
        </p>
      </div>
    </section>

    <!-- G4.S7.T10: live context-usage meter — estimated tokens / configured
         threshold; the server summarizes above the threshold (>= 100%). -->
    <div
      v-if="messages.length > 0"
      class="context-meter"
      :class="`context-${contextMeter.state}`"
      :title="`Estimated context: ${contextMeter.label} — the server summarizes once the threshold is reached`"
    >
      <div class="context-meter-bar">
        <div class="context-meter-fill" :style="{ width: `${contextMeter.percent}%` }"></div>
      </div>
      <span class="context-meter-text">{{ contextMeter.label }}</span>
    </div>

    <div class="message-list">
      <p v-if="messages.length === 0" class="empty-hint">
        Start a conversation with your team.
      </p>
      <div
        v-for="(msg, index) in messages"
        :key="index"
        class="message-row"
        :class="msg.role"
      >
        <div v-if="msg.role === 'system'" class="system-notice">
          {{ msg.content }}
        </div>
        <template v-else>
          <span v-if="msg.speaker" class="speaker-logo">
            <img
              v-if="msg.speaker.logoUrl"
              :src="msg.speaker.logoUrl"
              :alt="msg.speaker.name"
            />
            <span v-else class="speaker-fallback">{{ msg.speaker.name.charAt(0).toUpperCase() }}</span>
          </span>
          <div class="bubble-block">
            <div class="bubble" :class="{ typing: msg.role === 'assistant' && !msg.content }">
              {{ msg.content || (msg.role === "assistant" ? `${msg.speaker?.name ?? "agent"} is typing...` : "") }}
            </div>
            <!-- G4.S7.T4: a remote agent's reasoning channel — collapsed progress row
                 under the bubble, distinct from the final answer text. -->
            <details v-if="msg.role === 'assistant' && msg.thinking" class="thinking-block">
              <summary>Thought for a moment…</summary>
              <div class="thinking-text">{{ msg.thinking }}</div>
            </details>
            <!-- G4.S7.T4: tool progress rows streamed by a remote agent. -->
            <div v-if="msg.role === 'assistant' && msg.progress && msg.progress.length" class="tool-progress">
              <div
                v-for="(tool, toolIdx) in msg.progress"
                :key="`${tool.name}-${toolIdx}`"
                class="tool-progress-row"
              >
                <span class="tool-state" :class="`tool-${tool.state}`">
                  {{ tool.state === "started" ? "▶" : tool.state === "completed" ? "✓" : "✕" }}
                </span>
                <span class="tool-name">{{ tool.name }}</span>
                <span v-if="tool.detail" class="tool-detail">{{ tool.detail }}</span>
                <span v-if="tool.state === 'completed' || tool.state === 'failed'">done</span>
                <span v-if="tool.error" class="tool-error">{{ tool.error }}</span>
              </div>
            </div>
            <!-- G4.S3.T13: a legitimate clarification → render question + options
                 as a REAL user follow-up; picking one re-runs the query. -->
            <div v-if="msg.role === 'assistant' && msg.clarification" class="clarification">
              <p class="clarification-question">{{ msg.clarification.question }}</p>
              <div v-if="!msg.clarificationAnswered" class="clarification-options">
                <button
                  v-for="option in msg.clarification.options"
                  :key="option"
                  type="button"
                  class="clarification-option"
                  :disabled="loading"
                  @click="chat.answerClarification(index, option)"
                >
                  {{ option }}
                </button>
                <span v-if="msg.clarification.options.length === 0" class="clarification-hint">
                  Type your answer below and send it.
                </span>
              </div>
              <p v-else class="clarification-answered">Answered — Athena is re-running the query…</p>
            </div>
            <div
              v-if="msg.role === 'assistant' && msg.content && !msg.clarification"
              class="feedback-controls"
            >
              <button
                type="button"
                class="feedback-btn feedback-up"
                :class="{ active: msg.feedback === 'up' }"
                title="Helpful answer — reinforce the sources"
                aria-label="Upvote answer"
                @click="chat.rateMessage(index, 'up')"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path d="M2 21h3v-9H2v9zM22 11c0-.9-.8-1.6-1.7-1.5H14l.6-2.8.1-1.1c0-1.2-.9-2.1-2.1-2.1L9 7.9c-.6.6-1 1.5-1 2.4V19c0 .9.7 1.6 1.6 1.6h7.4c.7 0 1.3-.4 1.5-1.1l1.4-5.6c.1-.3.1-.6.1-.9v-2z" />
                </svg>
              </button>
              <button
                type="button"
                class="feedback-btn feedback-down"
                :class="{ active: msg.feedback === 'down' }"
                title="Not helpful — fade the sources"
                aria-label="Downvote answer"
                @click="chat.rateMessage(index, 'down')"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path d="M2 3h3v9H2V3zm20 10c0 .9-.8 1.6-1.7 1.5H14l.6 2.8.1 1.1c0 1.2-.9 2.1-2.1 2.1l-3.6-3.4c-.6-.6-1-1.5-1-2.4V5c0-.9.7-1.6 1.6-1.6h7.4c.7 0 1.3.4 1.5 1.1l1.4 5.6c.1.3.1.6.1.9v2z" />
                </svg>
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <p v-if="error" class="chat-error">{{ error }}</p>

    <footer class="chat-composer">
      <t-textarea
        v-model="input"
        class="composer-input"
        placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
        :disabled="loading"
        @keydown="onKeydown"
      />
      <t-button class="send-button" :disabled="loading" @click="sendMessage">
        {{ loading ? "Sending..." : "Send" }}
      </t-button>
    </footer>

    <!-- G4.S7.T15: delete-session confirmation (t-dialog, consistent with the
         agent delete flow — never a browser confirm). -->
    <t-dialog
      v-model:visible="deleteVisible"
      header="Delete chat"
      :confirm-btn="{ content: 'Delete', theme: 'danger' }"
      :cancel-btn="{ content: 'Cancel' }"
      :confirm-loading="deleting"
      @confirm="confirmDelete"
      @close="deleteVisible = false"
    >
      <template #body>
        <p>
          Delete chat <strong>{{ deleteTarget?.title || "" }}</strong>? This
          permanently removes the conversation and its messages.
        </p>
      </template>
    </t-dialog>
  </aside>
</template>

<style scoped>
.global-chat-panel {
  width: var(--chat-panel-width, 360px);
  min-width: 280px;
  max-width: 70vw;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: 16px;
  box-sizing: border-box;
  background: var(--caleo-body-bg);
  border-left: 1px solid var(--caleo-border);
  position: sticky;
  top: 0;
}

.participants {
  margin-bottom: 12px;
  padding: 12px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.participants-title {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

/* G4.S7.T12: session switcher in the agent-card area. */
.session-switcher {
  position: relative;
  margin-bottom: 10px;
}

.session-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.session-trigger:hover {
  border-color: var(--caleo-primary);
}

.session-caret {
  margin-left: auto;
  color: var(--caleo-text-secondary);
  font-size: 11px;
}

.session-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  max-height: 260px;
  overflow-y: auto;
}

.session-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--caleo-text);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}

.session-option:hover {
  background: var(--caleo-hover);
}

.session-option.active {
  background: color-mix(in srgb, var(--caleo-primary) 12%, transparent);
}

.session-new {
  font-weight: 600;
  color: var(--caleo-primary);
  border-bottom: 1px solid var(--caleo-border);
  border-radius: 6px 6px 0 0;
}

.session-option-title {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-option-meta {
  font-size: 11px;
  color: var(--caleo-text-secondary);
  white-space: nowrap;
}

.session-empty {
  padding: 8px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  text-align: center;
}

/* G4.S7.T13: inline rename in a session option (pencil + edit input). */
.session-rename {
  margin-left: auto;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  cursor: pointer;
  padding: 0 4px;
  border-radius: 4px;
}
.session-rename:hover {
  background: var(--caleo-hover);
}
.session-rename-input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--caleo-primary);
  border-radius: 4px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
  font-size: 12px;
  outline: none;
}

/* G4.S7.T15: delete button in a session option (next to the rename pencil). */
.session-delete {
  margin-left: 2px;
  font-size: 12px;
  color: var(--caleo-danger, #c0392b);
  cursor: pointer;
  padding: 0 4px;
  border-radius: 4px;
}
.session-delete:hover {
  background: var(--caleo-hover);
  color: #e74c3c;
}

.agent-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}

.add-entries {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.picker {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.picker-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: transparent;
  color: var(--caleo-text);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}

.picker-option:hover {
  background: var(--caleo-hover);
}

.picker-logo {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: contain;
}

/* G4.S7.T4: live-tunnel status in the agent picker. */
.picker-connectivity {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  white-space: nowrap;
}

.picker-connectivity.is-live {
  color: var(--caleo-success, #2f9e44);
  background: color-mix(in srgb, var(--caleo-success, #2f9e44) 12%, transparent);
}

.picker-connectivity.is-offline {
  color: var(--caleo-text-secondary);
  background: color-mix(in srgb, var(--caleo-text-secondary) 12%, transparent);
}

/* G4.S7.T4: remote-agent reasoning + tool progress rows under the bubble. */
.thinking-block {
  margin-top: 6px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: color-mix(in srgb, var(--caleo-primary) 5%, transparent);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  padding: 6px 10px;
  max-width: 100%;
  overflow: hidden;
  box-sizing: border-box;
}

.thinking-block summary {
  cursor: pointer;
  font-weight: 500;
}

.thinking-text {
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
}

.tool-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  max-width: 100%;
}

.tool-progress-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  padding: 3px 8px;
}

.tool-state {
  font-size: 11px;
  width: 14px;
}

.tool-state.tool-started {
  color: var(--caleo-primary);
}

.tool-state.tool-completed {
  color: var(--caleo-success, #2f9e44);
}

.tool-state.tool-failed {
  color: var(--caleo-error);
}

.tool-name {
  font-weight: 600;
  color: var(--caleo-text);
}

.tool-detail,
.tool-error {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-error {
  color: var(--caleo-error);
}

.picker-error {
  color: var(--caleo-error);
  font-size: 12px;
}

.picker-empty {
  color: var(--caleo-text-secondary);
  font-size: 12px;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-hint {
  margin: auto;
  color: var(--caleo-text-secondary);
  text-align: center;
}

.message-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  animation: message-enter 0.2s var(--caleo-ease-out);
}

@keyframes message-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .message-row {
    animation: none;
  }
}

.message-row.user {
  /* row-reverse flips the main axis: flex-start = visual RIGHT, so user
     bubbles sit on the right while the speaker avatar sits on the left. */
  justify-content: flex-start;
  flex-direction: row-reverse;
}

.message-row.assistant {
  justify-content: flex-start;
}

.system-notice {
  margin: 0 auto;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: color-mix(in srgb, var(--caleo-text-secondary) 10%, transparent);
  border-radius: 999px;
  padding: 3px 12px;
  text-align: center;
}

.speaker-logo {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: contain;
  flex-shrink: 0;
  background: var(--caleo-card-bg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.speaker-logo img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.speaker-fallback {
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-primary);
}

.bubble {
  max-width: 70%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

/* G4.S3.T5: the assistant bubble block groups the bubble with its thumbs
   up/down feedback controls (constrained to the same width as the bubble). */
.bubble-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 70%;
  min-width: 0;
}

.bubble-block .bubble {
  max-width: 100%;
}

.feedback-controls {
  display: flex;
  gap: 4px;
}

/* G4.S3.T13: real clarification follow-up — question + option buttons under the bubble. */
.clarification {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px dashed var(--caleo-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--caleo-primary) 6%, transparent);
  max-width: 100%;
}

.clarification-question {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
}

.clarification-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.clarification-option {
  padding: 4px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 999px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
  cursor: pointer;
  font-size: 13px;
  transition: color 0.15s var(--caleo-ease-out), background-color 0.15s var(--caleo-ease-out), border-color 0.15s var(--caleo-ease-out);
}

.clarification-option:hover:not(:disabled) {
  background: var(--caleo-primary);
  color: #fff;
  border-color: var(--caleo-primary);
}

.clarification-option:disabled {
  opacity: 0.6;
  cursor: default;
}

.clarification-hint,
.clarification-answered {
  margin: 0;
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.feedback-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: transparent;
  color: var(--caleo-text-secondary);
  cursor: pointer;
  transition: color 0.15s var(--caleo-ease-out), background-color 0.15s var(--caleo-ease-out);
}

/* The thumbs-up/down SVG paths have no fill attribute; force them to inherit
   the button's color (currentColor) so they are not solid black on dark mode. */
.feedback-btn svg {
  fill: currentColor;
}

.feedback-btn:hover {
  background: var(--caleo-hover);
  color: var(--caleo-text);
}

.feedback-btn.active.feedback-up {
  color: var(--caleo-primary);
  border-color: color-mix(in srgb, var(--caleo-primary) 45%, transparent);
  background: color-mix(in srgb, var(--caleo-primary) 10%, transparent);
}

.feedback-btn.active.feedback-down {
  color: var(--caleo-error);
  border-color: color-mix(in srgb, var(--caleo-error) 45%, transparent);
  background: color-mix(in srgb, var(--caleo-error) 10%, transparent);
}

.message-row.user .bubble {
  background: var(--caleo-bubble-user);
  color: var(--caleo-bubble-user-text);
  border-bottom-right-radius: 2px;
}

.message-row.assistant .bubble {
  background: var(--caleo-bubble-ai);
  color: var(--caleo-text);
  border-bottom-left-radius: 2px;
}

.bubble.typing {
  color: var(--caleo-text-secondary);
  font-style: italic;
}

.chat-error {
  margin: 8px 0 0;
  color: var(--caleo-error);
  font-size: 13px;
}

.chat-composer {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-top: 12px;
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.composer-input {
  flex: 1;
}

.composer-input :deep(.t-textarea__inner) {
  min-height: 66px;
  max-height: 180px;
  resize: vertical;
}

/* G4.S7.T10: context meter — estimated tokens / threshold with normal, warning
   (80–100%) and summarizing (>= 100%) visual states. */
.context-meter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 6px 10px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.context-meter-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--caleo-text-secondary) 18%, transparent);
  overflow: hidden;
}

.context-meter-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--caleo-success, #2f9e44);
  transition: width 0.25s var(--caleo-ease-out), background-color 0.25s var(--caleo-ease-out);
}

.context-meter.context-warning .context-meter-fill {
  background: var(--caleo-warning, #f5a623);
}

.context-meter.context-summarizing .context-meter-fill {
  background: var(--caleo-error);
}

.context-meter-text {
  font-size: 11px;
  color: var(--caleo-text-secondary);
  white-space: nowrap;
}

.context-meter.context-summarizing .context-meter-text {
  color: var(--caleo-error);
  font-weight: 600;
}
</style>

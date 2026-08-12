<script setup lang="ts">
import { ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useAuthStore } from "@/stores/auth";
import { listAgents } from "@/api/agents";
import { listEmployees } from "@/api/invitations";
import AgentCard from "@/components/AgentCard.vue";
import type { AgentRecord } from "@/api/agents";
import type { EmployeeRecord } from "@/api/invitations";

const chat = useChatStore();
const auth = useAuthStore();
const { messages, loading, error } = storeToRefs(chat);

const input = ref("");
const agentPickerOpen = ref(false);
const employeePickerOpen = ref(false);
const availableAgents = ref<AgentRecord[]>([]);
const availableEmployees = ref<EmployeeRecord[]>([]);
const pickerError = ref("");

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
      <div class="agent-cards">
        <AgentCard
          v-for="participant in chat.participants"
          :key="participant.id"
          :participant="participant"
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
              {{ msg.content || (msg.role === "assistant" ? "Pi is typing..." : "") }}
            </div>
            <div
              v-if="msg.role === 'assistant' && msg.content"
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

.agent-cards {
  display: flex;
  flex-direction: column;
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
</style>

<script setup lang="ts">
import { ref } from "vue";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const defaultUserId = "hermes";

const userId = ref(defaultUserId);
const input = ref("");
const messages = ref<ChatMessage[]>([]);
const loading = ref(false);
const error = ref("");

async function sendMessage() {
  const text = input.value.trim();
  if (!text || loading.value) return;

  messages.value.push({ role: "user", content: text });
  input.value = "";
  loading.value = true;
  error.value = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userId.value, message: text }),
    });
    if (!res.ok) {
      throw new Error(`Request failed with status ${res.status}`);
    }
    const data = (await res.json()) as { reply?: string };
    messages.value.push({ role: "assistant", content: data.reply ?? "" });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="chat-panel">
    <header class="chat-header">
      <h2 class="chat-title">Personal Chat</h2>
      <div class="user-id-field">
        <span class="user-id-label">User ID</span>
        <t-input
          v-model="userId"
          class="user-id-input"
          size="small"
          placeholder="User ID"
        />
      </div>
    </header>

    <div class="message-list">
      <p v-if="messages.length === 0" class="empty-hint">
        Start a conversation with your personal Pi assistant.
      </p>
      <div
        v-for="(msg, index) in messages"
        :key="index"
        class="message-row"
        :class="msg.role"
      >
        <div class="bubble">{{ msg.content }}</div>
      </div>
      <div v-if="loading" class="message-row assistant">
        <div class="bubble typing">Pi is typing...</div>
      </div>
    </div>

    <p v-if="error" class="chat-error">{{ error }}</p>

    <footer class="chat-composer">
      <t-input
        v-model="input"
        class="composer-input"
        placeholder="Type a message..."
        :disabled="loading"
        @enter="sendMessage"
      />
      <t-button class="send-button" :disabled="loading" @click="sendMessage">
        {{ loading ? "Sending..." : "Send" }}
      </t-button>
    </footer>
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  padding: 24px;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.chat-title {
  margin: 0;
  font-size: 20px;
  color: var(--caleo-dark);
}

.user-id-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-id-label {
  font-size: 13px;
  color: var(--caleo-light-gray);
}

.user-id-input {
  width: 160px;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  background: #fff;
  border: 1px solid #e7e7e7;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-hint {
  margin: auto;
  color: var(--caleo-light-gray);
  text-align: center;
}

.message-row {
  display: flex;
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.assistant {
  justify-content: flex-start;
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

.message-row.user .bubble {
  background: var(--caleo-primary);
  color: #fff;
  border-bottom-right-radius: 2px;
}

.message-row.assistant .bubble {
  background: #f0f1f3;
  color: var(--caleo-dark);
  border-bottom-left-radius: 2px;
}

.bubble.typing {
  color: var(--caleo-light-gray);
  font-style: italic;
}

.chat-error {
  margin: 8px 0 0;
  color: #d54941;
  font-size: 13px;
}

.chat-composer {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.composer-input {
  flex: 1;
}
</style>

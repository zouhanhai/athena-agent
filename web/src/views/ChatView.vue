<script setup lang="ts">
import { ref } from "vue";
import { storeToRefs } from "pinia";
import { useChatStore } from "@/stores/chat";

const chat = useChatStore();
const { messages, loading, error, userId } = storeToRefs(chat);

const input = ref("");

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
        <div class="bubble" :class="{ typing: msg.role === 'assistant' && !msg.content }">
          {{ msg.content || (msg.role === "assistant" ? "Pi is typing..." : "") }}
        </div>
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
  color: var(--caleo-text);
}

.user-id-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-id-label {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.user-id-input {
  width: 160px;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
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
  background: var(--caleo-bubble-bg);
  color: var(--caleo-text);
  border-bottom-left-radius: 2px;
}

.bubble.typing {
  color: var(--caleo-text-secondary);
  font-style: italic;
}

.chat-error {
  margin: 8px 0 0;
  color: #d54941;
  font-size: 13px;
}

.chat-composer {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-top: 16px;
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

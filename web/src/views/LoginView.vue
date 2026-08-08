<script setup lang="ts">
import { ref } from "vue";
import { requestMagicLink } from "@/api/invitations";

const email = ref("");
const sent = ref(false);
const submitting = ref(false);
const error = ref("");

async function submit() {
  if (!email.value.trim()) {
    error.value = "Email is required";
    return;
  }
  submitting.value = true;
  error.value = "";
  sent.value = false;
  try {
    await requestMagicLink(email.value.trim());
    sent.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="login">
    <h2 class="login-title">Sign in to Athena</h2>
    <p class="login-intro">
      Enter your work email and we'll send you a magic sign-in link.
    </p>

    <form class="login-form" @submit.prevent="submit">
      <div class="login-field">
        <label for="login-email">Email</label>
        <input
          id="login-email"
          class="login-email"
          v-model="email"
          type="email"
          placeholder="you@caleo.com"
        />
      </div>
      <p v-if="error" class="login-error">{{ error }}</p>
      <p v-if="sent" class="login-sent">
        If {{ email }} is a registered employee, a magic link is on its way.
      </p>
      <button type="button" class="login-submit" :disabled="submitting" @click="submit">
        {{ submitting ? "Sending…" : "Send magic link" }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.login {
  padding: 24px;
  max-width: 440px;
}

.login-title {
  margin: 0 0 4px;
}

.login-intro {
  margin: 0 0 16px;
  opacity: 0.8;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.login-field label {
  font-size: 13px;
  font-weight: 600;
}

.login-email {
  padding: 8px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  font-size: 14px;
}

.login-error {
  color: var(--caleo-error);
  font-size: 13px;
  margin: 0;
}

.login-sent {
  font-size: 13px;
  opacity: 0.9;
  margin: 0;
}

.login-submit {
  align-self: flex-start;
  padding: 8px 16px;
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.login-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { loginWithPassword, requestMagicLink } from "@/api/invitations";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

/** "password" = email+password sign-in (default); "magic" = magic-link fallback. */
const mode = ref<"password" | "magic">("password");
const email = ref("");
const password = ref("");
const submitting = ref(false);
const error = ref("");
const sent = ref(false);

function useMagicLink() {
  mode.value = "magic";
  error.value = "";
  sent.value = false;
}

function usePassword() {
  mode.value = "password";
  error.value = "";
  sent.value = false;
}

async function submit() {
  if (!email.value.trim()) {
    error.value = "Email is required";
    return;
  }
  if (mode.value === "password" && !password.value) {
    error.value = "Password is required";
    return;
  }
  submitting.value = true;
  error.value = "";
  sent.value = false;
  try {
    if (mode.value === "password") {
      const result = await loginWithPassword(email.value.trim(), password.value);
      if ("session_token" in result && "employee" in result) {
        auth.setSession(result);
        const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/knowledge";
        await router.push(redirect);
        return;
      }
      // The account has no password set — the server fell back to a magic link.
      sent.value = true;
    } else {
      await requestMagicLink(email.value.trim());
      sent.value = true;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="login">
    <div class="login-card">
      <header class="login-header">
        <img class="login-logo" src="/athena-logo-ai.png" alt="Athena" />
        <h1 class="login-title">Sign in to Athena</h1>
        <p v-if="mode === 'password'" class="login-subtitle">
          Welcome back — sign in with your email and password.
        </p>
        <p v-else class="login-subtitle">
          Enter your email and we'll send you a magic sign-in link.
        </p>
      </header>

      <form class="login-form" @submit.prevent="submit">
        <div class="login-field">
          <label for="login-email">Email</label>
          <input
            id="login-email"
            class="login-email"
            v-model="email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
          />
        </div>

        <div v-if="mode === 'password'" class="login-field">
          <label for="login-password">Password</label>
          <input
            id="login-password"
            class="login-password"
            v-model="password"
            type="password"
            placeholder="Your password"
            autocomplete="current-password"
          />
        </div>

        <p v-if="error" class="login-error">{{ error }}</p>
        <p v-if="sent" class="login-sent">
          <template v-if="mode === 'password'">
            This account has no password set — a magic link is on its way to
            {{ email }}.
          </template>
          <template v-else>
            If {{ email }} is a registered employee, a magic link is on its way.
          </template>
        </p>

        <button type="button" class="login-submit" :disabled="submitting" @click="submit">
          <span v-if="submitting">
            {{ mode === "password" ? "Signing in…" : "Sending…" }}
          </span>
          <span v-else>
            {{ mode === "password" ? "Sign in" : "Send magic link" }}
          </span>
        </button>
      </form>

      <div v-if="mode === 'password'" class="login-divider">
        <span class="login-divider-line"></span>
        <span class="login-divider-text">or</span>
        <span class="login-divider-line"></span>
      </div>

      <button
        type="button"
        class="login-magic-toggle"
        :class="{ 'is-magic': mode === 'magic' }"
        @click="mode === 'password' ? useMagicLink() : usePassword()"
      >
        <span v-if="mode === 'password'">Use a magic link instead</span>
        <span v-else>Sign in with email and password</span>
      </button>
    </div>

    <p class="login-footer">Athena — your company knowledge, agents and workbench.</p>
  </section>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 24px;
  background:
    radial-gradient(1200px 600px at 85% -10%, rgba(105, 179, 231, 0.16), transparent 60%),
    radial-gradient(1000px 500px at -10% 110%, rgba(255, 102, 51, 0.12), transparent 60%),
    var(--caleo-body-bg);
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 40px 36px 32px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 16px;
  box-shadow: var(--caleo-shadow);
}

.login-header {
  text-align: center;
  margin-bottom: 24px;
}

.login-logo {
  width: 64px;
  height: 64px;
  object-fit: contain;
  margin-bottom: 14px;
}

.login-title {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--caleo-text);
}

.login-subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--caleo-text-secondary);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.login-field label {
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
}

.login-email,
.login-password {
  width: 100%;
  padding: 11px 12px;
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  background: var(--caleo-card-bg);
  color: var(--caleo-text);
  font-size: 14px;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.login-email:focus,
.login-password:focus {
  border-color: var(--caleo-sky, #69b3e7);
  box-shadow: 0 0 0 3px rgba(105, 179, 231, 0.25);
}

.login-error {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-error);
}

.login-sent {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-sky, #69b3e7);
}

.login-submit {
  width: 100%;
  margin-top: 4px;
  padding: 12px 16px;
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.08s ease;
}

.login-submit:hover:not(:disabled) {
  background: var(--caleo-primary-hover, #e65a2b);
}

.login-submit:active:not(:disabled) {
  transform: translateY(1px);
}

.login-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.login-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 22px 0 12px;
}

.login-divider-line {
  flex: 1;
  height: 1px;
  background: var(--caleo-border);
}

.login-divider-text {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--caleo-text-secondary);
}

.login-magic-toggle {
  width: 100%;
  padding: 10px;
  background: transparent;
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  color: var(--caleo-sky, #69b3e7);
  font-size: 14px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.login-magic-toggle:hover {
  border-color: var(--caleo-sky, #69b3e7);
  background: rgba(105, 179, 231, 0.08);
}

.login-footer {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}
</style>

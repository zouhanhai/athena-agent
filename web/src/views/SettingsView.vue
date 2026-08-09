<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import { useAuthStore } from "@/stores/auth";
import { updateMe } from "@/api/invitations";
import { listLogos, type LogoRecord } from "@/api/agents";
import AgentManagement from "@/components/AgentManagement.vue";

const auth = useAuthStore();

// Profile form (display name / logo / GitHub credential)
const DEFAULT_LOGO = "/athena-logo-ai.png";
const logos = ref<LogoRecord[]>([]);
const displayName = ref("");
const logoUrl = ref(DEFAULT_LOGO);
const githubType = ref<"ssh" | "token">("token");
const githubValue = ref("");
const saving = ref(false);
const profileError = ref("");

const logoOptions = computed(() => [
  { url: DEFAULT_LOGO, label: "Owl", animal: "owl", color: "athena" },
  ...logos.value.map((logo) => ({
    url: logo.url,
    label: logo.name,
    animal: logo.animal ?? "",
    color: logo.color ?? "",
  })),
]);

function selectLogo(url: string) {
  logoUrl.value = url;
}

async function loadLogos() {
  try {
    logos.value = await listLogos();
  } catch {
    logos.value = [];
  }
}

// Full-page view: prefill the profile from the signed-in employee as soon as
// they are known (login bootstrap or session restore).
watch(
  () => auth.employee,
  (employee) => {
    if (employee) {
      displayName.value = employee.display_name;
      logoUrl.value = employee.logo_url || DEFAULT_LOGO;
    }
  },
  { immediate: true },
);

onMounted(loadLogos);

async function saveProfile() {
  if (!auth.isAuthenticated || !auth.sessionToken) {
    return;
  }
  if (!displayName.value.trim()) {
    profileError.value = "Display name is required";
    return;
  }
  saving.value = true;
  profileError.value = "";
  try {
    const updated = await updateMe(auth.sessionToken, {
      display_name: displayName.value.trim(),
      logo_url: logoUrl.value,
      github_credential:
        githubValue.value.trim().length > 0
          ? { type: githubType.value, value: githubValue.value.trim() }
          : undefined,
    });
    auth.setEmployee(updated);
    githubValue.value = "";
    MessagePlugin.success("Profile saved");
  } catch (err) {
    profileError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="settings-page">
    <header class="settings-header">
      <h2 class="settings-title">Settings</h2>
      <span class="settings-meta">
        Profile and agent management for your workspace
      </span>
    </header>

    <div class="settings-body">
      <div
        v-if="auth.isAuthenticated && auth.employee"
        class="settings-section profile"
      >
        <h3 class="section-title">Profile</h3>
        <div class="profile-form">
          <div class="settings-field">
            <label for="settings-name">Display name</label>
            <input
              id="settings-name"
              class="settings-name"
              v-model="displayName"
              placeholder="e.g. Carol Zhang"
            />
          </div>

          <div class="settings-field">
            <span class="settings-field-label">Logo</span>
            <div class="settings-logos">
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

          <div class="settings-field">
            <span class="settings-field-label">GitHub credential</span>
            <div class="settings-github">
              <select
                class="settings-github-type"
                v-model="githubType"
                aria-label="Credential type"
              >
                <option value="token">Personal access token</option>
                <option value="ssh">SSH key</option>
              </select>
              <input
                class="settings-github-value"
                v-model="githubValue"
                :type="githubType === 'token' ? 'password' : 'text'"
                :placeholder="
                  githubType === 'token'
                    ? 'ghp_…'
                    : 'ssh-ed25519 AAAA…'
                "
              />
            </div>
            <p class="settings-hint">
              Stored encrypted at rest; leave empty to keep your existing credential.
            </p>
          </div>

          <p v-if="profileError" class="settings-error">{{ profileError }}</p>
          <button
            type="button"
            class="settings-save"
            :disabled="saving"
            @click="saveProfile"
          >
            {{ saving ? "Saving…" : "Save profile" }}
          </button>
        </div>
      </div>

      <div class="settings-section agents">
        <h3 class="section-title">Agents</h3>
        <AgentManagement />
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  height: calc(100dvh - 48px);
  padding: 24px;
  gap: 16px;
  overflow-y: auto;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.settings-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.settings-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-section {
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

.profile-form,
.settings-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.profile-form {
  gap: 14px;
}

.settings-field label,
.settings-field-label {
  font-size: 13px;
  font-weight: 600;
}

.settings-name,
.settings-github-value,
.settings-github-type {
  padding: 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  font-size: 14px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
}

.settings-github {
  display: flex;
  gap: 8px;
}

.settings-github-type {
  flex-shrink: 0;
}

.settings-github-value {
  flex: 1;
}

.settings-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
}

.settings-logos {
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
  border-color: var(--caleo-primary);
}

.settings-error {
  margin: 0;
  color: var(--caleo-error);
  font-size: 13px;
}

.settings-save {
  align-self: flex-start;
  padding: 8px 16px;
  background: var(--caleo-primary);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.settings-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

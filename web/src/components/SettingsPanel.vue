<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { SettingIcon } from "tdesign-icons-vue-next";
import { MessagePlugin } from "tdesign-vue-next";
import { useThemeStore } from "@/stores/theme";
import { useAuthStore } from "@/stores/auth";
import { updateMe } from "@/api/invitations";
import { listLogos, type LogoRecord } from "@/api/agents";
import AgentManagement from "@/components/AgentManagement.vue";
import type { ThemeMode } from "@/theme";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);
const auth = useAuthStore();

const visible = ref(false);
const panelRef = ref<HTMLElement | null>(null);

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

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

function attachToPanel() {
  return panelRef.value;
}

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

function open() {
  visible.value = true;
  profileError.value = "";
  githubValue.value = "";
  if (auth.employee) {
    displayName.value = auth.employee.display_name;
    logoUrl.value = auth.employee.logo_url || DEFAULT_LOGO;
  }
  loadLogos();
}
</script>

<template>
  <div ref="panelRef" class="settings-panel">
    <t-button
      class="settings-trigger"
      variant="text"
      theme="default"
      @click="open"
    >
      <template #icon><SettingIcon /></template>
      Settings
    </t-button>

    <t-dialog
      v-model:visible="visible"
      class="settings-dialog"
      header="Settings"
      :footer="false"
      :destroy-on-close="true"
      :attach="attachToPanel"
      width="560px"
    >
      <div v-if="auth.isAuthenticated && auth.employee" class="settings-section">
        <h4 class="settings-title">Profile</h4>
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

      <div class="settings-section">
        <h4 class="settings-title">Agents</h4>
        <AgentManagement />
      </div>

      <div class="settings-section">
        <h4 class="settings-title">Theme</h4>
        <div class="theme-options">
          <button
            v-for="opt in themeOptions"
            :key="opt.value"
            type="button"
            class="theme-option"
            :class="{ active: mode === opt.value }"
            @click="theme.setMode(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.settings-trigger {
  width: 100%;
  justify-content: flex-start;
  color: var(--caleo-sidebar-sub) !important;
  background: transparent !important;
}
.settings-trigger:hover {
  color: var(--caleo-primary) !important;
  background: var(--caleo-sidebar-hover) !important;
}

.settings-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--caleo-text-secondary);
}

.theme-options {
  display: flex;
  gap: 8px;
}

.theme-option {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
  font-size: 14px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.theme-option:hover {
  border-color: var(--caleo-primary);
  background: var(--caleo-surface-hover);
}

.theme-option.active {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
  font-weight: 600;
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

.settings-section + .settings-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--caleo-border);
}
</style>

<style>
.settings-dialog .t-dialog {
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
}

.settings-dialog .t-dialog__header {
  border-bottom: 1px solid var(--caleo-border);
}

.settings-dialog .t-dialog .title {
  color: var(--caleo-text);
}
</style>

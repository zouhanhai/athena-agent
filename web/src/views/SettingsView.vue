<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import { useAuthStore } from "@/stores/auth";
import { updateMe } from "@/api/invitations";
import { listLogos, uploadLogo, type LogoRecord } from "@/api/agents";
import AgentManagement from "@/components/AgentManagement.vue";

const auth = useAuthStore();

// Profile form (display name / logo / GitHub credential)
const DEFAULT_LOGO = "/athena-logo-ai.png";
const logos = ref<LogoRecord[]>([]);
const displayName = ref("");
const logoUrl = ref(DEFAULT_LOGO);
// The logo the user had when the page loaded — always shown in the picker
// (even if in-use/excluded) so it never abruptly disappears when switching.
const originalLogo = ref(DEFAULT_LOGO);
const githubValue = ref("");
const githubEditing = ref(false);
const saving = ref(false);
const profileError = ref("");
const uploading = ref(false);
const logoError = ref("");

// When a GitHub credential is stored, the field is pre-filled with the backend
// mask (first + last 4 chars) so the user can compare it with GitHub — never
// the full secret. Focusing the field clears it so a real token can be typed;
// only a freshly typed value is ever submitted.
const githubMask = computed(() => auth.employee?.github_credential_masked ?? "");

const githubDisplay = computed({
  get: () => {
    if (!githubEditing.value && githubValue.value.length === 0) {
      return githubMask.value;
    }
    return githubValue.value;
  },
  set: (value: string) => {
    githubValue.value = value;
  },
});

function focusGithub() {
  if (!githubEditing.value) {
    githubEditing.value = true;
    githubValue.value = "";
  }
}

function blurGithub() {
  githubEditing.value = false;
}

// Available logos come from the server (in-use ones excluded). The employee's
// CURRENT logo is always shown as well — even when the server excludes it as
// in-use — so the user can see/keep what they already have. The current logo is
// highlighted via the existing is-selected binding on logoUrl.
const logoOptions = computed(() => {
  const available = logos.value.map((logo) => ({
    url: logo.url,
    label: logo.name,
    animal: logo.animal ?? "",
    color: logo.color ?? "",
  }));
  // Always keep the CURRENT logo (loaded with the page) visible — even if it's
  // in-use and excluded by the server — so it never abruptly disappears when
  // switching to another option. Highlighted via is-selected when it's active.
  const hasOriginal = available.some((logo) => logo.url === originalLogo.value);
  if (!hasOriginal) {
    available.unshift({
      url: originalLogo.value,
      label: "Current",
      animal: "",
      color: "",
    });
  }
  return available;
});

function selectLogo(url: string) {
  logoUrl.value = url;
}

async function loadLogos() {
  try {
    logos.value = await listLogos({ excludeInUse: true });
  } catch {
    logos.value = [];
  }
}

async function onUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) {
    return;
  }
  uploading.value = true;
  logoError.value = "";
  try {
    const logo = await uploadLogo(file);
    await loadLogos();
    logoUrl.value = logo.url;
  } catch (err) {
    logoError.value = err instanceof Error ? err.message : String(err);
  } finally {
    uploading.value = false;
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
      originalLogo.value = employee.logo_url || DEFAULT_LOGO;
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
          ? { type: "token", value: githubValue.value.trim() }
          : undefined,
    });
    auth.setEmployee(updated);
    githubValue.value = "";
    githubEditing.value = false;
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
              <label
                class="logo-upload"
                :class="{ 'is-uploading': uploading }"
                title="Upload a custom logo (png/jpg/webp)"
              >
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  class="logo-upload-input"
                  :disabled="uploading"
                  @change="onUpload"
                />
                {{ uploading ? "Uploading…" : "Upload" }}
              </label>
            </div>
            <p v-if="logoError" class="settings-error">{{ logoError }}</p>
            <p v-else class="settings-hint">
              Logos already used by another agent or employee are not shown.
            </p>
          </div>

          <div class="settings-field">
            <span class="settings-field-label">GitHub credential</span>
            <div class="settings-github">
              <input
                class="settings-github-value"
                v-model="githubDisplay"
                :type="
                  !githubEditing && githubValue.length === 0 && auth.employee?.github_has_credential
                    ? 'text'
                    : 'password'
                "
                :placeholder="
                  auth.employee?.github_has_credential
                    ? 'Type a new token to replace the stored one'
                    : 'ghp_… or github_pat_…'
                "
                aria-label="GitHub personal access token"
                @focus="focusGithub"
                @blur="blurGithub"
              />
            </div>
            <p class="settings-hint">
              GitHub REST is token-only (SSH keys cannot authenticate the API).
              Use a Classic PAT with the <code>repo</code> scope or a
              Fine-grained PAT with repo-level Contents, Issues and Pull requests
              read access. Stored encrypted at rest; leave empty to keep your
              existing credential.
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
.settings-github-value {
  padding: 8px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  font-size: 14px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
}

.settings-github-value {
  width: 100%;
}

.settings-github {
  display: flex;
  gap: 8px;
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

.logo-upload {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  min-height: 48px;
  padding: 4px 10px;
  border: 1px dashed var(--caleo-border);
  border-radius: 8px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  cursor: pointer;
}

.logo-upload.is-uploading {
  opacity: 0.6;
  cursor: wait;
}

.logo-upload-input {
  display: none;
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

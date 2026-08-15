<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listLogos, uploadLogo, type LogoRecord } from "@/api/agents";
import { registerInvitedEmployee, resolveInvitation } from "@/api/invitations";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const DEFAULT_LOGO = "/athena-logo-ai.png";
const MIN_PASSWORD_LENGTH = 8;

const invitedEmail = ref("");
const loading = ref(true);
const error = ref("");
const submitting = ref(false);
const uploading = ref(false);
const logoError = ref("");

const logos = ref<LogoRecord[]>([]);
const displayName = ref("");
const password = ref("");
const logoUrl = ref(DEFAULT_LOGO);
const githubValue = ref("");

const token = computed(() => (typeof route.query.token === "string" ? route.query.token : ""));

const logoOptions = computed(() =>
  logos.value.map((logo) => ({
    url: logo.url,
    label: logo.name,
    animal: logo.animal ?? "",
    color: logo.color ?? "",
  })),
);

function selectLogo(url: string) {
  logoUrl.value = url;
}

onMounted(async () => {
  error.value = "";
  loading.value = true;
  if (!token.value) {
    error.value = "No invitation token in the link. Check your invitation email.";
    loading.value = false;
    return;
  }
  try {
    const [email, logoList] = await Promise.all([
      resolveInvitation(token.value),
      listLogos({ excludeInUse: true }),
    ]);
    invitedEmail.value = email;
    logos.value = logoList;
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : "This invitation is invalid or expired.";
  } finally {
    loading.value = false;
  }
});

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
    logos.value = await listLogos({ excludeInUse: true });
    logoUrl.value = logo.url;
  } catch (err) {
    logoError.value = err instanceof Error ? err.message : String(err);
  } finally {
    uploading.value = false;
  }
}

async function submit() {
  if (!displayName.value.trim()) {
    error.value = "Display name is required";
    return;
  }
  if (password.value && password.value.length < MIN_PASSWORD_LENGTH) {
    error.value = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    const githubCredential =
      githubValue.value.trim().length > 0
        ? { type: "token" as const, value: githubValue.value.trim() }
        : undefined;
    const verification = await registerInvitedEmployee(token.value, {
      display_name: displayName.value.trim(),
      password: password.value || undefined,
      logo_url: logoUrl.value,
      github_credential: githubCredential,
    });
    auth.setSession(verification);
    await router.push("/knowledge");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="registration">
    <h2 class="reg-title">Employee Registration</h2>
    <p class="reg-intro">
      You've been invited to join the Athena agent portal. Verify your email,
      then set up your profile and GitHub credential.
    </p>

    <p v-if="loading" class="reg-loading">Checking your invitation…</p>
    <p v-if="error" class="reg-error">{{ error }}</p>

    <template v-if="!loading && invitedEmail">
      <p class="reg-invited">
        <span class="reg-invited-label">Verified email</span>
        <span class="reg-invited-value">{{ invitedEmail }}</span>
      </p>

      <form class="reg-form" @submit.prevent="submit">
        <div class="reg-field">
          <label for="reg-name">Display name</label>
          <input id="reg-name" class="reg-name" v-model="displayName" placeholder="e.g. Carol Zhang" />
        </div>

        <div class="reg-field">
          <label for="reg-password">Password</label>
          <input
            id="reg-password"
            class="reg-password"
            v-model="password"
            type="password"
            placeholder="At least 8 characters"
            autocomplete="new-password"
          />
          <p class="reg-hint">
            Set a password to sign in with email + password. Leave blank to keep
            magic-link sign-in only.
          </p>
        </div>

        <div class="reg-field">
          <span class="reg-field-label">Logo</span>
          <div class="reg-logos">
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
          <p v-if="logoError" class="reg-error reg-error-form">{{ logoError }}</p>
          <p v-else class="reg-hint">
            Logos already used by another agent or employee are not shown.
          </p>
        </div>

        <div class="reg-field">
          <span class="reg-field-label">GitHub credential (optional)</span>
          <div class="reg-github">
            <input
              class="reg-github-value"
              v-model="githubValue"
              type="password"
              placeholder="ghp_… or github_pat_…"
              aria-label="GitHub personal access token"
            />
          </div>
          <p class="reg-hint">
            GitHub REST is token-only (SSH keys cannot authenticate the API).
            Use a Classic PAT with the <code>repo</code> scope or a Fine-grained
            PAT with repo-level Contents, Issues and Pull requests read access.
            Stored encrypted at rest; scopes the Workbench repos to what you can see.
          </p>
        </div>

        <p v-if="error" class="reg-error reg-error-form">{{ error }}</p>
        <button type="button" class="reg-submit" :disabled="submitting" @click="submit">
          {{ submitting ? "Registering…" : "Complete registration" }}
        </button>
      </form>
    </template>

    <p v-if="!loading && !invitedEmail && !error" class="reg-invite-missing">
      No invitation found for this link. Ask an admin to invite you.
    </p>
  </section>
</template>

<style scoped>
.registration {
  padding: 24px;
  max-width: 560px;
}

.reg-title {
  margin: 0 0 4px;
}

.reg-intro {
  margin: 0 0 16px;
  opacity: 0.8;
}

.reg-error {
  color: var(--caleo-error);
  font-size: 13px;
}

.reg-loading,
.reg-invite-missing {
  opacity: 0.7;
}

.reg-invited {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
  background: var(--caleo-card-bg);
}

.reg-invited-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.6;
}

.reg-invited-value {
  font-weight: 600;
}

.reg-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.reg-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.reg-field label,
.reg-field-label {
  font-size: 13px;
  font-weight: 600;
}

.reg-name,
.reg-password,
.reg-github-value {
  padding: 8px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  font-size: 14px;
}

.reg-github-value {
  width: 100%;
}

.reg-github {
  display: flex;
  gap: 8px;
}

.reg-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
}

.reg-logos {
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
  border-color: var(--caleo-primary, #ff6633);
}

.logo-upload {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  min-height: 48px;
  padding: 4px 10px;
  border: 1px dashed var(--caleo-border, #ddd);
  border-radius: 8px;
  font-size: 12px;
  color: var(--caleo-text-secondary, #666);
  cursor: pointer;
}

.logo-upload.is-uploading {
  opacity: 0.6;
  cursor: wait;
}

.logo-upload-input {
  display: none;
}

.reg-error-form {
  margin: 0;
}

.reg-submit {
  align-self: flex-start;
  padding: 8px 16px;
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.reg-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

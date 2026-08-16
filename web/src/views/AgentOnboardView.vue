<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { registerAgent, submitSelfDeclaration } from "@/api/agents";

const route = useRoute();
const token = computed(() => (route.query.token as string) || "");

const loading = ref(false);
const done = ref(false);
const error = ref("");
const agentId = ref("");
const apiUrl = ref("");

// The agent's self-declared capabilities (optional; empty = plain generic agent).
const system = ref("");
const specialty = ref("");
const toolsText = ref("");
const runtimeDecl = ref("");

const CAPS_EXAMPLE = `{
  "system": "opencode",        // e.g. hermes / opencode / codex / pi
  "mcp": [],                   // MCP server ids this agent exposes
  "tools": [],                 // tool ids this agent provides
  "skills": [],                // skill ids this agent has
  "specialty": "general",      // e.g. integration / sap / general
  "description": "…"           // optional short blurb
}`;

async function onSubmit() {
  if (!token.value) {
    error.value = "Missing invitation token";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    // 1) Register the invited agent (proves possession of the token).
    const rec = await registerAgent({
      agent_id: agentId.value.trim(),
      api_url: apiUrl.value.trim() || undefined,
      token: token.value,
    });
    // 2) If the agent declared capabilities, submit them via self-declare.
    if (system.value.trim() || specialty.value.trim() || toolsText.value.trim()) {
      await submitSelfDeclaration(
        rec.agent_id,
        {
          system: system.value.trim() || "remote",
          mcp: [],
          tools: toolsText.value.split(",").map((s) => s.trim()).filter(Boolean),
          skills: [],
          specialty: specialty.value.trim() || "general",
        },
        runtimeDecl.value.trim() || undefined,
      );
    }
    done.value = true;
    agentId.value = rec.agent_id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (!token.value) {
    error.value = "No invitation token in the URL (?token=…)";
  }
});
</script>

<template>
  <section class="agent-onboard">
    <header class="onboard-header">
      <h2 class="onboard-title">Agent onboarding</h2>
      <span class="onboard-meta">
        Register this agent into the platform, then connect it over reverse WebSocket.
      </span>
    </header>

    <div class="onboard-body">
      <p v-if="error" class="onboard-error">{{ error }}</p>

      <template v-if="!done">
        <div class="onboard-section">
          <h3>1 · Your invitation</h3>
          <p>
            This invitation was issued for a remote agent. Register with the
            <code>agent_id</code> + <code>token</code> below, then connect into the
            platform's WebSocket to become reachable.
          </p>
          <div class="onboard-fields">
            <label>
              agent_id
              <input v-model="agentId" placeholder="agent-… (from your invite)" />
            </label>
            <label>
              token
              <input :value="token" readonly />
            </label>
            <label>
              api_url (optional — leave blank; reverse-WS connects INTO the platform)
              <input v-model="apiUrl" placeholder="https://agent.example.local:3001" />
            </label>
          </div>
        </div>

        <div class="onboard-section">
          <h3>2 · Declare your capabilities (optional)</h3>
          <p>
            Tell the platform what you can do. These appear on your agent card and
            help route tasks to you. Leave system empty for a plain generic agent.
          </p>
          <div class="onboard-fields">
            <label>
              system (runtime family)
              <input v-model="system" placeholder="opencode / hermes / codex / pi" />
            </label>
            <label>
              specialty
              <input v-model="specialty" placeholder="general / integration / sap …" />
            </label>
            <label>
              tools (comma-separated)
              <input v-model="toolsText" placeholder="search_knowledge, get_wiki_page" />
            </label>
            <label>
              runtime (optional)
              <input v-model="runtimeDecl" placeholder="local / server" />
            </label>
          </div>
          <pre class="caps-example">{{ CAPS_EXAMPLE }}</pre>
        </div>

        <button class="onboard-submit" :disabled="loading || !token" @click="onSubmit">
          {{ loading ? "Registering…" : "Register agent" }}
        </button>
      </template>

      <template v-else>
        <div class="onboard-section">
          <h3>✓ Registered</h3>
          <p>
            Agent <code>{{ agentId }}</code> is registered. Now connect it into the
            platform over reverse WebSocket so it becomes reachable.
          </p>
          <pre class="caps-example">wss://athenakb.com/ws/agent
{ "type": "register", "agent_id": "{{ agentId }}", "token": "{{ token }}" }</pre>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.agent-onboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 24px;
  gap: 16px;
  overflow-y: auto;
}
.onboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}
.onboard-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--caleo-text);
}
.onboard-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}
.onboard-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.onboard-error {
  color: var(--caleo-error);
  margin: 0;
}
.onboard-section {
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}
.onboard-section h3 {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--caleo-text);
}
.onboard-section p {
  font-size: 13px;
  opacity: 0.8;
  margin: 0 0 12px;
}
.onboard-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.onboard-fields label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
}
.onboard-fields input {
  padding: 8px;
  border: 1px solid var(--caleo-border, #ddd);
  border-radius: 6px;
  font-size: 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.caps-example {
  margin: 12px 0 0;
  padding: 12px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 8px;
  font-size: 12px;
  overflow-x: auto;
  white-space: pre;
}
.onboard-submit {
  align-self: flex-start;
  padding: 8px 16px;
  background: var(--caleo-primary, #ff6633);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.onboard-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

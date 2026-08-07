<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  listDeclarations,
  listLogos,
  type PendingAgentDeclaration,
  type LogoRecord,
} from "@/api/agents";
import DeclarationCard from "@/components/DeclarationCard.vue";

const declarations = ref<PendingAgentDeclaration[]>([]);
const logos = ref<LogoRecord[]>([]);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [decls, logoList] = await Promise.all([listDeclarations(), listLogos()]);
    declarations.value = decls;
    logos.value = logoList;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function onRegistered(id: string) {
  declarations.value = declarations.value.filter((d) => d.id !== id);
}

onMounted(load);
</script>

<template>
  <section class="agent-registration">
    <h2 class="reg-title">Agent Registration</h2>
    <p class="reg-intro">
      Connected agents auto-declare their capabilities. Review each declaration,
      then assign an alias and logo to register the agent.
    </p>
    <p v-if="error" class="reg-error">{{ error }}</p>
    <p v-if="loading" class="reg-loading">Loading declarations…</p>
    <p
      v-if="!loading && !error && declarations.length === 0"
      class="reg-empty"
    >
      No pending agent declarations. Agents connect and self-declare via
      POST /api/agents/self-declare.
    </p>
    <DeclarationCard
      v-for="decl in declarations"
      :key="decl.id"
      :declaration="decl"
      :logos="logos"
      @registered="onRegistered"
    />
  </section>
</template>

<style scoped>
.agent-registration {
  padding: 24px;
  max-width: 720px;
}

.reg-title {
  margin: 0 0 4px;
}

.reg-intro {
  margin: 0 0 16px;
  opacity: 0.8;
}

.reg-error {
  color: #d54941;
}

.reg-empty,
.reg-loading {
  opacity: 0.7;
}
</style>

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
    const [decls, logoList] = await Promise.all([
      listDeclarations(),
      listLogos({ excludeInUse: true }),
    ]);
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
  <div class="agent-management">
    <p class="am-intro">
      Connected agents auto-declare their capabilities. Review each declaration,
      then assign an alias and logo to register the agent.
    </p>
    <p v-if="error" class="am-error">{{ error }}</p>
    <p v-if="loading" class="am-loading">Loading declarations…</p>
    <p
      v-if="!loading && !error && declarations.length === 0"
      class="am-empty"
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
  </div>
</template>

<style scoped>
.am-intro {
  margin: 0 0 12px;
  font-size: 13px;
  opacity: 0.8;
}

.am-error {
  color: var(--caleo-error);
}

.am-empty,
.am-loading {
  opacity: 0.7;
}
</style>

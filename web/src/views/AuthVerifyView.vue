<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { verifyMagicLink } from "@/api/invitations";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const error = ref("");

onMounted(async () => {
  const token = typeof route.query.token === "string" ? route.query.token : "";
  if (!token) {
    error.value = "No sign-in token in the link.";
    return;
  }
  try {
    const verification = await verifyMagicLink(token);
    auth.setSession(verification);
    await router.replace("/knowledge");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<template>
  <section class="verify">
    <p v-if="error" class="verify-error">{{ error }}</p>
    <p v-else class="verify-loading">Signing you in…</p>
  </section>
</template>

<style scoped>
.verify {
  padding: 24px;
  max-width: 440px;
}

.verify-error {
  color: var(--caleo-error);
}

.verify-loading {
  opacity: 0.7;
}
</style>

<template>
  <DdicSchemaView
    v-if="channel === 'ddic'"
    :meta="meta"
    :system="system"
    :existing-paths="existingPaths"
    @navigate="(p) => emit('navigate', p)"
    @search="(t) => emit('search', t)"
  />
  <CdsSourceOutline
    v-else-if="channel === 'cds'"
    :meta="meta"
    :system="system"
    :existing-paths="existingPaths"
    @navigate="(p) => emit('navigate', p)"
    @search="(t) => emit('search', t)"
  />
  <AbapUnitNav v-else-if="channel === 'abap'" :meta="meta" />
  <Ui5StructureView v-else-if="channel === 'ui5'" :meta="meta" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { WikiCodeMeta } from "@/api/kb";
import { detectCodeChannel } from "@/kb/code-links";
import DdicSchemaView from "./DdicSchemaView.vue";
import CdsSourceOutline from "./CdsSourceOutline.vue";
import AbapUnitNav from "./AbapUnitNav.vue";
import Ui5StructureView from "./Ui5StructureView.vue";

const props = defineProps<{
  meta: WikiCodeMeta;
  system?: string;
  existingPaths: string[];
}>();

const emit = defineEmits<{
  (e: "navigate", path: string): void;
  (e: "search", target: string): void;
}>();

const channel = computed(() => detectCodeChannel(props.meta));
</script>
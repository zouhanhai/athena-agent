<script setup lang="ts">
import CodeTreeNode from "./CodeTreeNode.vue";
import { ref } from "vue";
import type { TreeNode } from "@/github/tree";

const props = defineProps<{
  node: TreeNode;
}>();

const emit = defineEmits<{
  open: [node: TreeNode];
}>();

/** Per-folder expansion is local to each rendered node (reset on tree rebuild). */
const expanded = ref(false);

function onClick(): void {
  if (props.node.type === "tree") {
    expanded.value = !expanded.value;
    return;
  }
  emit("open", props.node);
}
</script>

<template>
  <div class="tree-node" :class="`tree-node-${node.type}`">
    <button class="tree-row" type="button" @click="onClick">
      <span v-if="node.type === 'tree'" class="tree-caret" aria-hidden="true">
        {{ expanded ? "▾" : "▸" }}
      </span>
      <span v-else class="tree-caret" aria-hidden="true" />
      <span class="tree-icon" aria-hidden="true">{{ node.type === "tree" ? "📁" : "📄" }}</span>
      <span class="tree-name">{{ node.name }}</span>
      <span v-if="node.type === 'blob' && node.size != null" class="tree-size">{{ node.size }}</span>
    </button>
    <div v-if="node.type === 'tree' && node.children.length" class="tree-children" :class="{ 'tree-children-hidden': !expanded }">
      <CodeTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        @open="emit('open', $event)"
      />
    </div>
  </div>
</template>

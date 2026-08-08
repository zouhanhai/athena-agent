<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import {
  CloudFilledIcon,
  MoonFilledIcon,
  StarFilledIcon,
  SunnyFilledIcon,
} from "tdesign-icons-vue-next";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);

const isDark = computed(() => mode.value === "dark");
const stateLabel = computed(() => (isDark.value ? "dark" : "light"));

function onToggle() {
  theme.toggle();
}
</script>

<template>
  <div
    class="theme-toggle"
    :class="{ 'is-dark': isDark }"
    :data-mode="stateLabel"
    role="switch"
    :aria-checked="isDark"
    :aria-label="`Toggle theme (currently ${stateLabel})`"
    title="Toggle dark / light theme"
    tabindex="0"
    @click="onToggle"
    @keydown.enter="onToggle"
    @keydown.space.prevent="onToggle"
  >
    <div class="theme-toggle__track">
      <div class="theme-toggle__thumb">
        <div
          class="theme-toggle__icons theme-toggle__icons--dark"
          :aria-hidden="!isDark"
        >
          <StarFilledIcon />
          <MoonFilledIcon />
        </div>
        <div
          class="theme-toggle__icons theme-toggle__icons--light"
          :aria-hidden="isDark"
        >
          <SunnyFilledIcon />
          <CloudFilledIcon />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-toggle {
  --caleo-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --caleo-duration-toggle: 200ms;

  display: flex;
  justify-content: center;
  padding: 10px 0 2px;
  cursor: pointer;
  user-select: none;
  outline: none;
}

.theme-toggle:focus-visible .theme-toggle__track {
  box-shadow: 0 0 0 2px var(--caleo-primary);
}

.theme-toggle__track {
  width: 64px;
  height: 32px;
  padding: 2px;
  border-radius: 999px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  transition: background-color 0.15s var(--caleo-ease-out);
}

.theme-toggle__thumb {
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--caleo-sidebar-hover);
  transition: transform var(--caleo-duration-toggle) var(--caleo-ease-out);
}

.theme-toggle.is-light .theme-toggle__thumb {
  transform: translateX(32px);
}

.theme-toggle__icons {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  font-size: 12px;
  color: var(--caleo-text);
  transition:
    opacity var(--caleo-duration-toggle) var(--caleo-ease-out),
    transform var(--caleo-duration-toggle) var(--caleo-ease-out);
}

.theme-toggle__icons--dark {
  opacity: 1;
  transform: scale(1);
}

.theme-toggle__icons--light {
  opacity: 0;
  transform: scale(0.9);
}

.theme-toggle.is-light .theme-toggle__icons--dark {
  opacity: 0;
  transform: scale(0.9);
}

.theme-toggle.is-light .theme-toggle__icons--light {
  opacity: 1;
  transform: scale(1);
}

@media (prefers-reduced-motion: reduce) {
  .theme-toggle__thumb {
    transition: none;
  }

  .theme-toggle__icons {
    transition: opacity 0.15s ease;
  }
}
</style>

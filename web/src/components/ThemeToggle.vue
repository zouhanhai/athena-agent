<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
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
    :class="{ 'is-dark': isDark, 'is-light': !isDark }"
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
      <!-- Day (light) sky scene -->
      <div
        class="theme-toggle__sky theme-toggle__sky--day"
        :aria-hidden="isDark ? 'true' : 'false'"
      >
        <span class="theme-toggle__cloud theme-toggle__cloud--a" />
        <span class="theme-toggle__cloud theme-toggle__cloud--b" />
      </div>
      <!-- Night (dark) sky scene -->
      <div
        class="theme-toggle__sky theme-toggle__sky--night"
        :aria-hidden="isDark ? 'false' : 'true'"
      >
        <span class="theme-toggle__star theme-toggle__star--a" />
        <span class="theme-toggle__star theme-toggle__star--b" />
        <span class="theme-toggle__star theme-toggle__star--c" />
        <span class="theme-toggle__star theme-toggle__star--d" />
      </div>
      <!-- Thumb: sun in day / moon in night -->
      <div class="theme-toggle__thumb">
        <div class="theme-toggle__thumb-icon theme-toggle__sun" aria-hidden="true" />
        <div class="theme-toggle__thumb-icon theme-toggle__moon" aria-hidden="true" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-toggle {
  --caleo-duration-toggle: 250ms;

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

/* Track: sky blue in light mode, deep navy at night. Color transitions as the scene swaps. */
.theme-toggle__track {
  position: relative;
  width: 68px;
  height: 32px;
  padding: 2px;
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid rgba(127, 127, 127, 0.35);
  background: linear-gradient(180deg, #aee1ff 0%, #7cc4f5 100%); /* day sky */
  transition: background 0.25s ease;
}

.theme-toggle.is-dark .theme-toggle__track {
  background: linear-gradient(180deg, #101828 0%, #1e2a4a 100%); /* night sky */
}

/* Thumb slides left/right on the track. */
.theme-toggle__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #ffffff, #e8ecf3 70%);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.35);
  transition: transform var(--caleo-duration-toggle) cubic-bezier(0.23, 1, 0.32, 1);
  z-index: 2;
}

.theme-toggle.is-light .theme-toggle__thumb {
  transform: translateX(36px);
}

/* Sun / moon icons inside the thumb, crossfade. */
.theme-toggle__thumb-icon {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  transition: opacity var(--caleo-duration-toggle) ease, transform var(--caleo-duration-toggle) ease;
}

.theme-toggle__sun {
  background: radial-gradient(circle at 40% 40%, #ffe66d 0%, #ffb42b 55%, #ff8a00 100%);
  opacity: 1;
  transform: scale(1);
  box-shadow: inset -2px -2px 4px rgba(200, 100, 0, 0.35);
}

/* Sun rays */
.theme-toggle__sun::before {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background:
    repeating-conic-gradient(
      from 0deg,
      rgba(255, 176, 46, 0.9) 0deg 8deg,
      transparent 8deg 22deg
    );
  -webkit-mask: radial-gradient(circle, transparent 55%, #000 56% 78%, transparent 79%);
  mask: radial-gradient(circle, transparent 55%, #000 56% 78%, transparent 79%);
}

.theme-toggle__moon {
  background: radial-gradient(circle at 40% 40%, #eef0f6 0%, #c9cfdf 60%, #a8b0c6 100%);
  opacity: 0;
  transform: scale(0.85);
  box-shadow: inset 2px 2px 5px rgba(120, 130, 160, 0.4);
}

/* Crescent cutout */
.theme-toggle__moon::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #2a3650;
  box-shadow: inset 0 0 3px rgba(0, 0, 0, 0.5);
}

.theme-toggle.is-dark .theme-toggle__sun {
  opacity: 0;
  transform: scale(0.7) rotate(40deg);
}

.theme-toggle.is-dark .theme-toggle__moon {
  opacity: 1;
  transform: scale(1) rotate(-10deg);
}

/* Sky scenes fade in/out. */
.theme-toggle__sky {
  position: absolute;
  inset: 0;
  transition: opacity 0.25s ease;
  pointer-events: none;
}

.theme-toggle__sky--day {
  opacity: 1;
}
.theme-toggle.is-dark .theme-toggle__sky--day {
  opacity: 0;
}
.theme-toggle__sky--night {
  opacity: 0;
}
.theme-toggle.is-dark .theme-toggle__sky--night {
  opacity: 1;
}

/* Clouds (day) */
.theme-toggle__cloud {
  position: absolute;
  border-radius: 999px;
  background: #fff;
  box-shadow: inset 0 -3px 4px rgba(160, 190, 210, 0.4);
}
.theme-toggle__cloud::before,
.theme-toggle__cloud::after {
  content: "";
  position: absolute;
  border-radius: 50%;
  background: inherit;
}
.theme-toggle__cloud--a {
  width: 20px;
  height: 9px;
  top: 9px;
  left: 22px;
}
.theme-toggle__cloud--a::before {
  width: 12px;
  height: 12px;
  top: -6px;
  left: 3px;
}
.theme-toggle__cloud--a::after {
  width: 9px;
  height: 9px;
  top: -3px;
  left: 11px;
}
.theme-toggle__cloud--b {
  width: 13px;
  height: 7px;
  top: 5px;
  left: 44px;
  opacity: 0.8;
}
.theme-toggle__cloud--b::before {
  width: 8px;
  height: 8px;
  top: -4px;
  left: 2px;
}

/* Stars (night) */
.theme-toggle__star {
  position: absolute;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 3px rgba(255, 255, 255, 0.9);
}
.theme-toggle__star::after {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  background: #fff;
  opacity: 0.5;
}
.theme-toggle__star--a {
  top: 7px;
  left: 20px;
}
.theme-toggle__star--b {
  top: 13px;
  left: 34px;
}
.theme-toggle__star--c {
  top: 7px;
  left: 50px;
}
.theme-toggle__star--d {
  top: 18px;
  left: 56px;
  width: 2px;
  height: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .theme-toggle__track,
  .theme-toggle__thumb,
  .theme-toggle__thumb-icon,
  .theme-toggle__sky {
    transition: none;
  }
}
</style>

<script setup lang="ts">
import { ref } from "vue";

const dark = ref(document.documentElement.dataset.theme === "dark");
function flip() {
  dark.value = !dark.value;
  const root = document.documentElement;
  // No transitions while every token changes at once.
  const style = document.createElement("style");
  style.textContent = "*{transition:none!important}";
  document.head.append(style);
  root.dataset.theme = dark.value ? "dark" : "light";
  try {
    localStorage.setItem("theme", root.dataset.theme);
  } catch {}
  requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
}
</script>

<template>
  <button class="btn quiet icon" :aria-label="dark ? 'Use light theme' : 'Use dark theme'" @click="flip">
    <svg v-if="dark" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </svg>
    <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </svg>
  </button>
</template>

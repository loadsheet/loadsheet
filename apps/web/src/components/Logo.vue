<script setup lang="ts">
/** The mark is four blocks of the map: the ink harness and three kinds. `word` adds the pixel wordmark beside it. */
withDefaults(defineProps<{ size?: number; word?: boolean }>(), { size: 20 });
</script>

<template>
  <span class="lock" :style="{ '--mk': `${size}px` }">
    <svg class="mk" viewBox="0 0 32 32" :width="size" :height="size" aria-hidden="true">
      <path d="M7 3h10v26H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z" fill="currentColor" />
      <path d="M19 3h6a4 4 0 0 1 4 4v7H19Z" fill="var(--k-mcp)" />
      <rect x="19" y="16" width="4.5" height="13" fill="var(--k-instr)" />
      <path d="M25.5 16H29v9a4 4 0 0 1-3.5 4Z" fill="var(--k-skill)" />
    </svg>
    <span v-if="word">loadsheet</span>
  </span>
</template>

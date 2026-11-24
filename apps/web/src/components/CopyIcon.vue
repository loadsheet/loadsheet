<script setup lang="ts">
/** The copy glyph; `done` cross-fades it to a check for as long as the copy is confirmed. */
defineProps<{ done?: boolean }>();
</script>

<template>
  <span class="ci" :class="{ done }" aria-hidden="true">
    <svg class="a" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5" />
    </svg>
    <svg class="b" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  </span>
</template>

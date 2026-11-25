<script setup lang="ts">
/** A harness's mark for its switch: Claude Code's starburst, Codex's prompt square, a plain square otherwise. */
defineProps<{ id: string }>();
const RAYS = [
  [9.53, 8.47, 14.69, 10.07],
  [8.96, 9.28, 11.36, 12.48],
  [8.02, 9.6, 8.09, 14.6],
  [7.08, 9.31, 5, 12.25],
  [6.49, 8.52, 1.37, 10.26],
  [6.47, 7.53, 2.46, 6.29],
  [7.04, 6.72, 4.17, 2.88],
  [7.98, 6.4, 7.92, 2.6],
  [8.92, 6.69, 11.98, 2.36],
  [9.51, 7.48, 13.21, 6.23],
] as const;
</script>

<template>
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class="hmark">
    <g
      v-if="id === 'claude-code'"
      stroke="var(--logo-claude)"
      stroke-width="1.9"
      stroke-linecap="round"
    >
      <line v-for="(r, i) in RAYS" :key="i" :x1="r[0]" :y1="r[1]" :x2="r[2]" :y2="r[3]" />
    </g>
    <template v-else-if="id === 'codex'">
      <rect width="16" height="16" rx="4" fill="var(--foreground)" />
      <path
        d="M4.6 5.2 7.2 8l-2.6 2.8M8.6 10.9h3"
        fill="none"
        stroke="var(--card)"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>
    <rect v-else x="2" y="2" width="12" height="12" rx="3" fill="var(--k-harness)" />
  </svg>
</template>

<script setup lang="ts">
/** A dead end: the dashed mark, a pixel title, one line, and what to do next. Built on the kit's vh-empty. */
defineProps<{ title: string }>();
</script>

<template>
  <section data-slot="vh-empty" class="state">
    <svg
      class="glyph"
      viewBox="0 0 64 44"
      width="64"
      height="44"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-dasharray="3 3"
    >
      <rect x="1" y="1" width="34" height="42" rx="3" />
      <rect x="39" y="1" width="24" height="18" rx="3" />
      <rect x="39" y="23" width="10" height="20" rx="3" />
      <rect x="53" y="23" width="10" height="20" rx="3" />
    </svg>
    <h2 data-slot="vh-empty-title">{{ title }}</h2>
    <p data-slot="vh-empty-description"><slot /></p>
    <div data-slot="vh-empty-actions"><slot name="actions" /></div>
  </section>
</template>

<script setup lang="ts">
import { fmt, type Kind } from "../lib/report";

/** The map's key: a square per kind, its count and its tokens. `dead` and `harness` add the hatched keys. */
defineProps<{
  kinds: { id: Kind; many: string; count: number; tokens: number }[];
  dead?: { count: number; tokens: number };
  harness?: { name: string; tokens: number };
}>();
</script>

<template>
  <ul class="key" aria-label="Key">
    <li v-if="harness && harness.tokens > 0">
      <i class="k-h" />{{ harness.name }}<b class="num">{{ fmt(harness.tokens) }}</b>
    </li>
    <li v-for="k in kinds" :key="k.id">
      <i :class="`k-${k.id}`" />{{ k.many }} <em>{{ k.count }}</em
      ><b class="num">{{ fmt(k.tokens) }}</b>
    </li>
    <li v-if="dead && dead.count">
      <i class="k-dead" />Never used <em>{{ dead.count }}</em
      ><b class="num">{{ fmt(dead.tokens) }}</b>
    </li>
  </ul>
</template>

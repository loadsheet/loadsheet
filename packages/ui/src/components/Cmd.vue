<script setup lang="ts">
import CopyButton from "./CopyButton.vue";
import type { FixView } from "../lib/report";

/** A fix as you copy it: a command after a `$`, a setting and its file, or a request in words for your agent. */
defineProps<{ fix: FixView }>();
</script>

<template>
  <div class="cmd" :data-type="fix.type">
    <code v-if="fix.type === 'cmd'" :title="fix.text"
      ><span class="pr" aria-hidden="true">$</span>{{ fix.text }}</code
    >
    <code v-else-if="fix.type === 'set'"
      >{{ fix.text }}<span class="muted"> in {{ fix.file }}</span></code
    >
    <span v-else>{{ fix.text }}</span>
    <CopyButton
      :text="fix.text"
      :label="
        fix.type === 'cmd'
          ? 'Copy command'
          : fix.type === 'set'
            ? 'Copy setting'
            : 'Copy prompt for your agent'
      "
    />
  </div>
</template>

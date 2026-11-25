<script setup lang="ts">
import CopyIcon from "./CopyIcon.vue";
import { copied, copy } from "../lib/ui";

/** A square copy button that turns into a check for as long as the copy is confirmed. */
const props = withDefaults(defineProps<{ text: string; label?: string; said?: string }>(), {
  label: "Copy",
  said: "Copied",
});
</script>

<template>
  <button
    type="button"
    data-slot="button"
    data-size="sm"
    class="cp"
    :data-done="copied.key === props.text || undefined"
    :aria-label="label"
    @click="copy(text, said)"
  >
    <CopyIcon :done="copied.key === props.text" />
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { fixLine, fixText, type Finding } from "../lib/report";
import { copied, copy } from "../lib/ui";
import CopyIcon from "./CopyIcon.vue";

const props = defineProps<{ finding: Finding }>();
const t = computed(() => fixText(props.finding));
</script>

<template>
  <div v-if="t.cmd || t.note" class="cmd">
    <code v-if="t.cmd">{{ t.cmd }}</code>
    <span v-else class="note">{{ t.note }}</span>
    <button class="copy" aria-label="Copy fix" @click="copy(fixLine(finding), 'Fix copied')"><CopyIcon :done="copied.key === fixLine(finding)" /></button>
  </div>
</template>

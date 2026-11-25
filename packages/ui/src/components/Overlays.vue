<script setup lang="ts">
import { ToastRegion } from "@ui-sdk/vue/toast";
import { tip } from "../lib/ui";

/** The tooltip and the toasts every view uses; the host renders this once, after its page. */
</script>

<template>
  <div
    class="tip"
    :data-on="tip.on || undefined"
    :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    v-html="tip.html"
  />
  <ToastRegion side="bottom" align="center" />
</template>

<script setup lang="ts">
import { ToastRegion } from "@ui-sdk/vue/toast";
import { tip } from "./lib/ui";
</script>

<template>
  <RouterView />
  <div class="tip" :data-on="tip.on || undefined" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }" v-html="tip.html" />
  <ToastRegion side="bottom" align="center" />
</template>

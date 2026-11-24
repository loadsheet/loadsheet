<script setup lang="ts">
import { tip, toast } from "./lib/ui";
</script>

<template>
  <RouterView />
  <div class="tip" :data-on="tip.on || undefined" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }" v-html="tip.html" />
  <div class="toast" :data-on="toast.on || undefined" role="status">{{ toast.text }}</div>
</template>

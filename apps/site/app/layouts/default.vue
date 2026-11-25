<script setup lang="ts">
import { Overlays } from "@loadsheet/ui";
</script>

<template>
  <!-- loadsheet's scope root: its styles and the kit's apply only inside, so docs pages keep their own theme. -->
  <div class="ui-sdk loadsheet ls-page">
    <slot />
    <Overlays />
  </div>
</template>

<style>
.ls-page {
  min-height: 100dvh;
}
</style>

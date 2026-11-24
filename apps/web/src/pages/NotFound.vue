<script setup lang="ts">
import Logo from "../components/Logo.vue";
</script>

<template>
  <header class="top"><RouterLink class="brand" to="/"><Logo />loadsheet</RouterLink></header>
  <main class="page">
    <div class="card empty">
      <h3>This page doesn't exist</h3>
      <p>The link may be from an older loadsheet. The report and the pack checker are still here.</p>
      <div class="row"><RouterLink class="btn sm" to="/report">Open the report</RouterLink><RouterLink class="btn secondary sm" to="/">Home</RouterLink></div>
    </div>
  </main>
</template>

<style scoped>
.row { display: flex; gap: 8px; }
</style>

<script setup lang="ts">
import Logo from "../components/Logo.vue";
</script>

<template>
  <header class="top">
    <RouterLink class="brand" to="/"><Logo />loadsheet</RouterLink>
  </header>
  <main class="page">
    <div data-slot="vh-empty" data-variant="outline">
      <h3 data-slot="vh-empty-title">This page doesn't exist</h3>
      <p data-slot="vh-empty-description">
        The link may be from an older loadsheet. The report and the pack checker are still here.
      </p>
      <div data-slot="vh-empty-actions">
        <RouterLink data-slot="button" data-variant="solid" data-size="sm" to="/report"
          >Open the report</RouterLink
        ><RouterLink data-slot="button" data-size="sm" to="/">Home</RouterLink>
      </div>
    </div>
  </main>
</template>

<style scoped>
.row {
  display: flex;
  gap: 8px;
}
</style>

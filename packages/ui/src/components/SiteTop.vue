<script setup lang="ts">
import Logo from "./Logo.vue";
import ThemeToggle from "./ThemeToggle.vue";
import { usePickReport } from "../lib/open";

const pickReport = usePickReport();
</script>

<template>
  <header class="site w">
    <RouterLink :to="{ name: 'home' }" class="home-link" aria-label="loadsheet home"
      ><Logo :size="22" word
    /></RouterLink>
    <nav aria-label="Site">
      <button type="button" class="nav-link" @click="pickReport">Open a report</button>
      <a class="nav-link" href="https://github.com/loadsheet/loadsheet">GitHub</a>
      <ThemeToggle />
    </nav>
  </header>
</template>

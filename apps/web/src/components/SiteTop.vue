<script setup lang="ts">
import { useRouter } from "vue-router";
import Logo from "./Logo.vue";
import ThemeToggle from "./ThemeToggle.vue";
import { pickReport } from "../lib/open";

const router = useRouter();
</script>

<template>
  <header class="site w">
    <RouterLink to="/" class="home-link" aria-label="loadsheet home"
      ><Logo :size="22" word
    /></RouterLink>
    <nav aria-label="Site">
      <button type="button" class="nav-link" @click="pickReport(router)">Open a report</button>
      <a class="nav-link" href="https://github.com/loadsheet/loadsheet">GitHub</a>
      <ThemeToggle />
    </nav>
  </header>
</template>

<script setup lang="ts">
import { Landing } from "@loadsheet/ui";

definePageMeta({ name: "home" });

const description =
  "Every skill, CLAUDE.md, AGENTS.md and MCP server your coding agent loads, with the tokens each one costs. Runs on Claude Code, Codex and more.";
useSeoMeta({
  title: "See what your coding agent reads before you type · loadsheet",
  description,
  ogTitle: "See what your coding agent reads before you type",
  ogDescription: description,
});
</script>

<template>
  <Landing />
</template>

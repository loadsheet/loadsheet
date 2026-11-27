<script setup lang="ts">
import { Skills } from "@loadsheet/ui";
import { catalog, plain } from "~/skills/catalog";

definePageMeta({ name: "skills" });

const description = plain(catalog.copy.index.sub);
useSeoMeta({
  title: `${catalog.copy.index.title} · loadsheet`,
  description,
  ogTitle: catalog.copy.index.title,
  ogDescription: description,
});
</script>

<template>
  <Skills :catalog="catalog" />
</template>

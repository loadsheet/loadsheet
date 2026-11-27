<script setup lang="ts">
import { SkillCompare } from "@loadsheet/ui";
import { catalog, plain } from "~/skills/catalog";

definePageMeta({ name: "skill-compare" });

const job = String(useRoute().params.job);
const copy = catalog.copy.compare[job];
if (copy) {
  const description = plain(copy.sub);
  useSeoMeta({
    title: `${copy.title} · loadsheet`,
    description,
    ogTitle: copy.title,
    ogDescription: description,
  });
} else {
  useSeoMeta({ title: "No comparison for this job · loadsheet", robots: "noindex" });
  if (import.meta.server) setResponseStatus(useRequestEvent()!, 404);
}
</script>

<template>
  <SkillCompare :catalog="catalog" />
</template>

<script setup lang="ts">
import { SkillPack, packTotals } from "@loadsheet/ui";
import { catalog, filesOf, plain } from "~/skills/catalog";

definePageMeta({ name: "skill-pack" });

const route = useRoute();
const slug = [route.params.slug ?? []].flat().filter(Boolean).join("/");
const pack = catalog.packs.find((p) => p.slug === slug);
const copy = catalog.copy.packs[slug];
const { data: files } = await useAsyncData(`skill-files:${slug}`, async () =>
  pack ? ((await filesOf(slug)) ?? null) : null,
);

if (pack && copy) {
  const tokens = packTotals(pack).tokens.toLocaleString("en-US");
  const description = plain(copy.what);
  useSeoMeta({
    title: `${pack.title} (${slug}): ${tokens} tokens in every session · loadsheet`,
    description,
    ogTitle: `${slug}: ${tokens} tokens in every session`,
    ogDescription: description,
  });
} else {
  useSeoMeta({ title: "No review of this pack yet · loadsheet", robots: "noindex" });
  if (import.meta.server) setResponseStatus(useRequestEvent()!, 404);
}
</script>

<template>
  <SkillPack :catalog="catalog" :files="files ?? undefined" />
</template>

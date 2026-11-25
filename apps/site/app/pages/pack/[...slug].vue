<script setup lang="ts">
import { Pack, type PackError } from "@loadsheet/ui";
import { parseReport } from "@loadsheet/schema";

definePageMeta({ name: "pack" });

const route = useRoute();
/** `owner/repo[/dir]`, one route segment per folder. */
const source = computed(() => [route.params.slug ?? []].flat().filter(Boolean).join("/"));
// The server reads the pack while it renders the page, so its skills and descriptions are in the HTML.
const { data, pending, error, refresh } = await useFetch("/api/resolve", {
  query: { source },
  transform: (r) => parseReport(r),
});
const pack = computed(() =>
  data.value ? { report: data.value, title: source.value.split("/").at(-1)! } : undefined,
);
const failure = computed<PackError | undefined>(() => {
  const e = error.value;
  if (!e) return undefined;
  const code = e.status === 429 ? "rate-limited" : (e.data?.data?.code ?? "unknown");
  return { code, message: e.data?.message ?? e.message };
});
if (failure.value && import.meta.server)
  setResponseStatus(useRequestEvent()!, error.value!.status ?? 500);
</script>

<template>
  <Pack :pack="pack" :pending="pending" :error="failure" @retry="refresh()" />
</template>

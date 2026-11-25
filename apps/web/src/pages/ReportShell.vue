<script setup lang="ts">
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/vue/segmented-control";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import CopyIcon from "../components/CopyIcon.vue";
import ItemPanel from "../components/ItemPanel.vue";
import Logo from "../components/Logo.vue";
import StateBox from "../components/StateBox.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import CopyButton from "../components/CopyButton.vue";
import { useHarness } from "../lib/harness";
import { pickReport } from "../lib/open";
import { harnessName, linkError, report, shareLink } from "../lib/report";
import { copied, copy } from "../lib/ui";

const h = useHarness();
const route = useRoute();
const router = useRouter();
const tabs = computed(() => [
  { to: "/report", name: "Map" },
  { to: "/report/list", name: "List", n: h.sheet.value?.lines.length, quiet: true },
  { to: "/report/fixes", name: "Fixes", n: h.fixes.value.length },
]);
/** The item in `?item=`, on the Map and the List. */
const line = computed(() => {
  const id = route.query.item;
  return route.path === "/report/fixes" || typeof id !== "string"
    ? undefined
    : h.sheet.value?.lines.find((l) => l.item === id);
});
const close = () => router.replace({ query: { ...route.query, item: undefined } });
async function share() {
  copy(
    await shareLink(
      report.value,
      route.path,
      typeof route.query.h === "string" ? route.query.h : undefined,
    ),
    "Link copied. The report travels in the link itself",
    "share",
  );
}
</script>

<template>
  <header class="bar">
    <RouterLink to="/" class="home-link" aria-label="loadsheet home"
      ><Logo :size="19" word
    /></RouterLink>
    <nav class="tabs" aria-label="Views">
      <RouterLink
        v-for="t in tabs"
        :key="t.to"
        :to="{ path: t.to, query: { h: $route.query.h } }"
        :class="{ on: $route.path === t.to }"
        :aria-current="$route.path === t.to ? 'page' : undefined"
      >
        {{ t.name }}<i v-if="t.n" class="num" :data-quiet="t.quiet || undefined">{{ t.n }}</i>
      </RouterLink>
    </nav>
    <span class="grow" />
    <SegmentedControl
      v-if="h.all.value.length > 1"
      class="harness"
      aria-label="Harness"
      :value="h.current.value"
      @update:value="(v) => v && h.set(v)"
    >
      <SegmentedControlIndicator />
      <SegmentedControlItem
        v-for="x in h.all.value"
        :key="x.id"
        :value="x.id"
        :data-off="!x.sessions || undefined"
        >{{ harnessName(x.id) }}</SegmentedControlItem
      >
    </SegmentedControl>
    <button
      type="button"
      data-slot="button"
      data-size="sm"
      class="share"
      title="Copy a link that carries this report in the URL"
      @click="share"
    >
      <CopyIcon v-if="copied.key === 'share'" done />Share
    </button>
    <ThemeToggle />
  </header>
  <main v-if="linkError" class="pg-body">
    <StateBox title="This link doesn’t hold a report">
      The address is cut short or was made by a newer loadsheet. Ask for the link again, or open the
      JSON file.
      <template #actions>
        <button type="button" data-slot="button" data-variant="solid" @click="pickReport(router)">
          Open a report file
        </button>
        <RouterLink data-slot="button" to="/">Go home</RouterLink>
      </template>
    </StateBox>
  </main>
  <main v-else-if="h.empty.value" class="pg-body">
    <StateBox title="No sessions found">
      loadsheet found no agent sessions to read. Run your agent once, then run this again.
      <template #actions>
        <div class="cmd">
          <code><span class="pr" aria-hidden="true">$</span>npx loadsheet --ui</code>
          <CopyButton text="npx loadsheet --ui" label="Copy command" />
        </div>
      </template>
    </StateBox>
  </main>
  <div v-else class="shell" :data-panel="line ? '' : undefined">
    <ItemPanel
      v-if="line && h.sheet.value"
      :key="line.item"
      :line
      :sheet="h.sheet.value"
      @close="close"
    />
    <RouterView />
  </div>
</template>

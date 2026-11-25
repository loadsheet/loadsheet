<script setup lang="ts">
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/vue/segmented-control";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Legend from "../components/Legend.vue";
import NoSessions from "../components/NoSessions.vue";
import Treemap, { type Block } from "../components/Treemap.vue";
import { useHarness } from "../lib/harness";
import { fmt, harnessName, isDead, kindOf, plural, shortName } from "../lib/report";

const h = useHarness();
const route = useRoute();
const router = useRouter();
/** Starts on your setup, so the small blocks have room; Everything adds the harness's own tokens. */
const view = ref<"setup" | "all">("setup");
const name = computed(() => harnessName(h.current.value));
const all = computed(() => view.value === "all" && !!h.sum.value?.harness);

const blocks = computed<Block[]>(() => {
  const sheet = h.sheet.value;
  if (!sheet) return [];
  const lines = sheet.lines.map((l) => ({
    id: l.item,
    name: l.ref.name,
    label: shortName(l),
    value: h.cost.value(l),
    group: kindOf(l),
    dead: isDead(l),
  }));
  return all.value
    ? [
        {
          id: "harness",
          name: `${name.value} itself`,
          label: `${name.value} itself`,
          value: h.sum.value!.harness,
          group: "harness" as const,
        },
        ...lines,
      ]
    : lines;
});
const sub = computed(() => {
  const s = h.sum.value!;
  const setup = s.harness ? `${fmt(s.setup)} is your setup` : "";
  const dead = s.dead.tokens ? `${fmt(s.dead.tokens)} of that was never used` : "";
  return setup && dead ? `${setup}, and ${dead}.` : setup || dead ? `${setup || dead}.` : "";
});
const selected = computed(() =>
  typeof route.query.item === "string" ? route.query.item : undefined,
);
const select = (id: string) =>
  router.replace({ query: { ...route.query, item: selected.value === id ? undefined : id } });
</script>

<template>
  <NoSessions v-if="!h.sheet.value" />
  <main v-else class="pg-body">
    <div class="ph">
      <div>
        <h1 class="px">{{ fmt(h.sum.value!.total) }} tokens before you type</h1>
        <p v-if="sub" class="sub">{{ sub }}</p>
      </div>
      <RouterLink
        v-if="h.fixes.value.length"
        data-slot="button"
        data-variant="solid"
        data-size="lg"
        :to="{ path: '/report/fixes', query: { h: $route.query.h, r: $route.query.r } }"
        >Review {{ plural(h.fixes.value.length, "fix", "fixes")
        }}<span v-if="h.saving.value" class="num">−{{ fmt(h.saving.value) }}</span></RouterLink
      >
    </div>
    <div class="tools">
      <SegmentedControl
        v-if="h.sum.value!.harness"
        aria-label="What the map shows"
        :value="view"
        @update:value="(v) => v && (view = v as 'setup' | 'all')"
      >
        <SegmentedControlIndicator />
        <SegmentedControlItem value="setup">Your setup</SegmentedControlItem>
        <SegmentedControlItem value="all">Everything</SegmentedControlItem>
      </SegmentedControl>
      <Legend
        :kinds="h.sum.value!.kinds"
        :dead="h.sum.value!.dead"
        :harness="all ? { name: `${name} itself`, tokens: h.sum.value!.harness } : undefined"
      />
    </div>
    <Treemap
      class="tm-report"
      :blocks="blocks"
      :selected="selected"
      :unit="h.sheet.value.sessions ? 'tokens a session' : 'tokens'"
      @select="select"
    />
  </main>
</template>

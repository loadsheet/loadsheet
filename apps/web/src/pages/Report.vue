<script setup lang="ts">
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/vue/segmented-control";
import { computed, provide, reactive, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ContextBar from "../components/ContextBar.vue";
import ContextMap from "../components/ContextMap.vue";
import ContextTable from "../components/ContextTable.vue";
import NoSessions from "../components/NoSessions.vue";
import { VIEW, contextOf, freshView, short } from "../lib/context";
import { useHarness } from "../lib/harness";
import { fmt, plural } from "../lib/report";
import { hideTip, showTip } from "../lib/ui";

/** What a session started now loads before you type, against the model's window: a map, or the same as a table. */
const h = useHarness();
const route = useRoute();
const router = useRouter();
const ctx = computed(() => (h.sheet.value ? contextOf(h.sheet.value) : undefined));
const table = computed(() => route.query.view === "table");
const show = (v: "map" | "table") =>
  router.replace({ query: { ...route.query, view: v === "table" ? "table" : undefined } });

const st = reactive(freshView());
watch(h.current, () => Object.assign(st, freshView()));
/** Skills from one place only open straight onto their list. */
watch(
  ctx,
  (c) => {
    const skills = c?.segments.find((s) => s.id === "skill");
    const groups = new Set(skills?.items.filter((i) => i.tokens > 0).map((i) => i.group));
    if (groups.size === 1) st.src.add(`skill:${[...groups][0]}`);
  },
  { immediate: true },
);
provide(VIEW, {
  st,
  ctx: () => ctx.value!,
  harness: () => h.current.value,
  reveal(seg, { group, item, more }) {
    Object.assign(st, { sel: seg, all: false, q: "" });
    st.open.add(seg);
    if (seg === "skill" && group) st.src.add(`skill:${group}`);
    if (more) st.more.add(seg);
    if (item) st.desc.add(`${seg}:${item}`);
    st.flash = item ? `item:${seg}:${item}` : seg === "skill" && group ? `skill:${group}` : null;
    show("table");
    if (!st.flash) scrollTo({ top: 0 });
  },
});
function expandAll() {
  st.all = !st.all;
  st.flash = null;
  if (!st.all) st.src.clear();
}
const exact = (e: MouseEvent) =>
  showTip(e, `<b>${fmt(ctx.value!.total)} tokens</b> before you type`);
</script>

<template>
  <NoSessions v-if="!ctx" />
  <main v-else class="ctx">
    <h1 class="big" @mouseenter="exact" @mousemove="exact" @mouseleave="hideTip">
      {{ short(ctx.total) }}<span class="of">of {{ short(ctx.window) }} used before you type</span>
    </h1>
    <ContextBar />
    <div class="views">
      <RouterLink
        v-if="h.fixes.value.length"
        class="fixl"
        :to="{ path: '/report/fixes', query: { h: route.query.h, r: route.query.r } }"
        >{{ plural(h.fixes.value.length, "fix", "fixes") }}</RouterLink
      >
      <div v-if="table" class="ctools">
        <input
          v-model="st.q"
          type="search"
          class="inp"
          placeholder="Find a skill or file"
          aria-label="Find a skill, file or tool"
          autocomplete="off"
          spellcheck="false"
          @input="st.flash = null"
        />
        <button type="button" data-slot="button" data-variant="ghost" @click="expandAll">
          {{ st.all ? "Collapse all" : "Expand all" }}
        </button>
      </div>
      <SegmentedControl
        class="vsw"
        aria-label="View"
        :value="table ? 'table' : 'map'"
        @update:value="(v) => v && show(v as 'map' | 'table')"
      >
        <SegmentedControlIndicator />
        <SegmentedControlItem value="map">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="1" y="1" width="7" height="12" rx="1.5" fill="currentColor" />
            <rect x="9" y="1" width="4" height="7" rx="1" fill="currentColor" />
            <rect x="9" y="9" width="4" height="4" rx="1" fill="currentColor" />
          </svg>
          Map
        </SegmentedControlItem>
        <SegmentedControlItem value="table">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M1.5 3h11M1.5 7h11M1.5 11h11"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
          Table
        </SegmentedControlItem>
      </SegmentedControl>
    </div>
    <ContextTable v-if="table" />
    <ContextMap v-else />
  </main>
</template>

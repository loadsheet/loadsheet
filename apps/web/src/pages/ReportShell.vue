<script setup lang="ts">
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/vue/segmented-control";
import { computed } from "vue";
import { useRoute } from "vue-router";
import Logo from "../components/Logo.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import { useHarness } from "../lib/harness";
import { harnessName, isExample, linkError, report, shareLink, shared } from "../lib/report";
import { copied, copy } from "../lib/ui";

const h = useHarness();
const route = useRoute();
const tabs = [
  { to: "/report/overview", name: "Overview" },
  { to: "/report/map", name: "Map" },
  { to: "/report/skills", name: "Skills" },
  { to: "/report/fixes", name: "Fixes" },
];
const fixes = computed(() => report.value.findings.filter((f) => f.level !== "info").length);
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
  <header class="top">
    <nav aria-label="Report">
      <RouterLink class="brand" to="/"><Logo /><span>loadsheet</span></RouterLink>
    </nav>
    <i class="vr" />
    <nav class="tabs" aria-label="Views">
      <RouterLink v-for="t in tabs" :key="t.to" :to="{ path: t.to, query: $route.query }">
        {{ t.name }}<b v-if="t.name === 'Fixes' && fixes" class="n">{{ fixes }}</b>
      </RouterLink>
    </nav>
    <div v-if="isExample" class="notice">
      <span>Example report</span>
      <RouterLink data-slot="button" data-size="sm" to="/open">Open yours</RouterLink>
    </div>
    <div v-else-if="shared" class="notice">
      <span data-slot="vh-badge" data-size="sm">Shared report</span>
    </div>
    <div class="right">
      <SegmentedControl
        v-if="$route.path !== '/report/fixes' && h.all.value.length > 1"
        aria-label="Harness"
        :value="h.current.value"
        @update:value="(v) => v && h.set(v)"
      >
        <SegmentedControlIndicator />
        <SegmentedControlItem v-for="x in h.all.value" :key="x.id" :value="x.id">{{
          harnessName(x.id)
        }}</SegmentedControlItem>
      </SegmentedControl>
      <span
        v-for="m in report.machines"
        :key="m.name"
        class="host"
        :data-down="!m.reachable || undefined"
        :title="m.error ?? `Scanned ${m.scannedAt?.slice(0, 16).replace('T', ' ')}`"
        >{{ m.name }}</span
      >
      <button
        data-slot="button"
        data-size="sm"
        class="share"
        :title="'Copy a link that carries this report in the URL'"
        @click="share"
      >
        <span class="ci" :class="{ done: copied.key === 'share' }" aria-hidden="true">
          <svg
            class="a"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          >
            <path d="M6.75 9.25a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.75.75" />
            <path d="M9.25 6.75a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.75-.75" />
          </svg>
          <svg
            class="b"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 8.5 6.5 12 13 4.5" />
          </svg>
        </span>
        Share
      </button>
      <ThemeToggle />
    </div>
  </header>
  <p v-if="linkError" class="linkerr" role="alert">
    This link's report couldn't be read, maybe it was cut off when it was pasted. You're looking at
    the example.
  </p>
  <RouterView />
</template>

<style scoped>
.linkerr {
  padding: 8px 16px;
  border-bottom: 1px solid color-mix(in oklch, var(--bad) 30%, var(--border));
  background: var(--bad-tint);
  color: var(--bad);
  font-size: 0.75rem;
}
@media (max-width: 560px) {
  .share {
    display: none;
  }
}
</style>

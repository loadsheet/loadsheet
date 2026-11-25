<script setup lang="ts">
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/vue/segmented-control";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import CostVsUse from "../components/CostVsUse.vue";
import SkillGrid from "../components/SkillGrid.vue";
import { useHarness } from "../lib/harness";
import { harnessName, report } from "../lib/report";

const h = useHarness();
const route = useRoute();
const router = useRouter();
const view = computed(() => (route.query.view === "cost" ? "cost" : "grid"));
const setView = (v: string) =>
  router.replace({ query: { ...route.query, view: v === "grid" ? undefined : v } });
const lines = computed(
  () =>
    h.sheet.value?.lines.filter((l) => l.ref.kind === "skill" || l.ref.kind === "subagent") ?? [],
);
const skills = computed(() => lines.value.filter((l) => l.ref.kind === "skill"));
</script>

<template>
  <template v-if="lines.length">
    <SkillGrid v-if="view === 'grid'" :r="report" :lines="lines">
      <template #side>
        <SegmentedControl aria-label="View" :value="view" @update:value="(v) => v && setView(v)">
          <SegmentedControlIndicator />
          <SegmentedControlItem value="grid">Grid</SegmentedControlItem>
          <SegmentedControlItem value="cost">Cost vs use</SegmentedControlItem>
        </SegmentedControl>
      </template>
    </SkillGrid>
    <CostVsUse v-else :lines="skills">
      <template #top>
        <div class="row">
          <SegmentedControl aria-label="View" :value="view" @update:value="(v) => v && setView(v)">
            <SegmentedControlIndicator />
            <SegmentedControlItem value="grid">Grid</SegmentedControlItem>
            <SegmentedControlItem value="cost">Cost vs use</SegmentedControlItem>
          </SegmentedControl>
          <p class="muted small">
            One dot per {{ harnessName(h.current.value) }} skill: what it costs every session
            against how often it ran.
          </p>
        </div>
      </template>
    </CostVsUse>
  </template>
  <main v-else class="page">
    <div data-slot="vh-empty" data-variant="outline">
      <h3 data-slot="vh-empty-title">No skills read for {{ harnessName(h.current.value) }}</h3>
      <p data-slot="vh-empty-description">
        loadsheet has no sessions from it in this window, so it can't tell what it lists.
      </p>
      <div data-slot="vh-empty-actions">
        <button data-slot="button" data-size="sm" @click="h.set(h.all.value[0]!.id)">
          Show {{ harnessName(h.all.value[0]!.id) }}
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.side [data-slot="segmented-control"] {
  align-self: start;
}
.row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
</style>

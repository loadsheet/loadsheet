<script setup lang="ts">
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
const setView = (v: string) => router.replace({ query: { ...route.query, view: v === "grid" ? undefined : v } });
const lines = computed(() => h.sheet.value?.lines.filter((l) => l.ref.kind === "skill" || l.ref.kind === "subagent") ?? []);
const skills = computed(() => lines.value.filter((l) => l.ref.kind === "skill"));
</script>

<template>
  <template v-if="lines.length">
    <SkillGrid v-if="view === 'grid'" :r="report" :lines="lines">
      <template #side>
        <div class="seg" role="group" aria-label="View">
          <button aria-pressed="true">Grid</button>
          <button aria-pressed="false" @click="setView('cost')">Cost vs use</button>
        </div>
      </template>
    </SkillGrid>
    <CostVsUse v-else :lines="skills">
      <template #top>
        <div class="row">
          <div class="seg" role="group" aria-label="View">
            <button aria-pressed="false" @click="setView('grid')">Grid</button>
            <button aria-pressed="true">Cost vs use</button>
          </div>
          <p class="muted small">One dot per {{ harnessName(h.current.value) }} skill: what it costs every session against how often it ran.</p>
        </div>
      </template>
    </CostVsUse>
  </template>
  <main v-else class="page">
    <div class="card empty">
      <h3>No skills read for {{ harnessName(h.current.value) }}</h3>
      <p>loadsheet has no sessions from it in this window, so it can't tell what it lists.</p>
      <button class="btn secondary sm" @click="h.set(h.all.value[0]!.id)">Show {{ harnessName(h.all.value[0]!.id) }}</button>
    </div>
  </main>
</template>

<style scoped>
.side .seg { align-self: start; }
.row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
</style>

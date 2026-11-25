<script setup lang="ts">
import { computed } from "vue";
import StateBox from "./StateBox.vue";
import { useHarness } from "../lib/harness";
import { day, harnessName } from "../lib/report";
import { useLoadsheet } from "../lib/state";

/** The current harness is installed but has nothing on its sheet; offer the busiest one that has. */
const h = useHarness();
const { report } = useLoadsheet();
const busiest = computed(
  () => report.value.sheet.filter((s) => s.lines.length).sort((a, b) => b.sessions - a.sessions)[0],
);
const [from, to] = report.value.window;
</script>

<template>
  <main class="pg-body">
    <StateBox :title="`${harnessName(h.current.value)} has no sessions here`">
      No session ran between {{ day(from) }} and {{ day(to) }}.
      <template v-if="busiest" #actions>
        <button
          type="button"
          data-slot="button"
          data-variant="solid"
          @click="h.set(busiest.harness)"
        >
          Show {{ harnessName(busiest.harness) }}
        </button>
      </template>
    </StateBox>
  </main>
</template>

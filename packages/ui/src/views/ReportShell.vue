<script setup lang="ts">
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/vue/segmented-control";
import { computed } from "vue";
import { useRoute } from "vue-router";
import CopyIcon from "../components/CopyIcon.vue";
import HarnessMark from "../components/HarnessMark.vue";
import Logo from "../components/Logo.vue";
import StateBox from "../components/StateBox.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import CopyButton from "../components/CopyButton.vue";
import { useHarness } from "../lib/harness";
import { usePickReport } from "../lib/open";
import { harnessName, shareLink } from "../lib/report";
import { useLoadsheet } from "../lib/state";
import { copied, copy } from "../lib/ui";

const h = useHarness();
/** Harnesses with sessions; one with none shows only while it is the one in `?h=`. */
const shown = computed(() => h.all.value.filter((x) => x.sessions || x.id === h.current.value));
const route = useRoute();
const pickReport = usePickReport();
const { report, linkError, shareBase, shareForm } = useLoadsheet();
async function share() {
  copy(
    await shareLink(
      report.value,
      shareBase(),
      route.path,
      typeof route.query.h === "string" ? route.query.h : undefined,
      shareForm,
    ),
    "Link copied. The report travels in the link itself",
    "share",
  );
}
</script>

<template>
  <header class="bar">
    <RouterLink :to="{ name: 'home' }" class="home-link" aria-label="loadsheet home"
      ><Logo :size="19" word
    /></RouterLink>
    <SegmentedControl
      v-if="shown.length > 1"
      class="harness"
      aria-label="Harness"
      :value="h.current.value"
      @update:value="(v) => v && h.set(v)"
    >
      <SegmentedControlIndicator />
      <SegmentedControlItem v-for="x in shown" :key="x.id" :value="x.id"
        ><HarnessMark :id="x.id" />{{ harnessName(x.id) }}</SegmentedControlItem
      >
    </SegmentedControl>
    <div class="right">
      <button type="button" data-slot="button" data-size="sm" class="share" @click="share">
        <CopyIcon v-if="copied.key === 'share'" done />Share
      </button>
      <ThemeToggle />
    </div>
  </header>
  <main v-if="linkError" class="pg-body">
    <StateBox title="This link doesn’t hold a report">
      The address is cut short or was made by a newer loadsheet. Ask for the link again, or open the
      JSON file.
      <template #actions>
        <button type="button" data-slot="button" data-variant="solid" @click="pickReport">
          Open a report file
        </button>
        <RouterLink data-slot="button" :to="{ name: 'home' }">Go home</RouterLink>
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
  <RouterView v-else />
</template>

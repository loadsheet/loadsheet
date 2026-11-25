<script setup lang="ts">
import { computed, ref } from "vue";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/vue/tabs";
import { useRouter } from "vue-router";
import CopyButton from "../components/CopyButton.vue";
import Legend from "../components/Legend.vue";
import SiteTop from "../components/SiteTop.vue";
import Treemap, { type Block } from "../components/Treemap.vue";
import {
  costOn,
  exampleReport,
  fmt,
  harnessName,
  isDead,
  kindOf,
  packSlug,
  packTokens,
  packs,
  shortName,
  totals,
} from "../lib/report";

const PROMPT =
  "Run `npx loadsheet --json` and read the report. Tell me which skills, instruction files and MCP servers cost the most context and which never get used. Don't change anything until I pick the fixes.";
const at = ref("humans");

const router = useRouter();
const url = ref("");
function go() {
  router.push(`/pack/${packSlug(url.value) ?? "mattpocock/skills"}`);
}

// The map of the example report's busiest harness, with the harness itself in it.
const sheet = [...exampleReport.sheet].sort((a, b) => b.sessions - a.sessions)[0]!;
const harness = harnessName(sheet.harness);
const sum = totals(sheet);
const cost = costOn(sheet);
const blocks = computed<Block[]>(() => [
  {
    id: "harness",
    name: `${harness} itself`,
    label: `${harness} itself`,
    value: sum.harness,
    group: "harness",
  },
  ...sheet.lines.map((l) => ({
    id: l.item,
    name: l.ref.name,
    label: shortName(l),
    value: cost(l),
    group: kindOf(l),
    dead: isDead(l),
  })),
]);

const examples = [
  { to: "/report", label: `${harness} report`, title: `A month of ${harness}, an example report` },
  ...["mattpocock/skills", "cursor/plugins/pstack"].map((slug) => {
    const p = packs[slug]!;
    return {
      to: `/pack/${slug}`,
      label: slug,
      title: `${p.title}${p.by ? ` by ${p.by}` : ""}, ${fmt(packTokens(p.report))} tokens a session`,
    };
  }),
];
</script>

<template>
  <div class="land">
    <SiteTop />
    <main class="w mp">
      <div class="mp-l">
        <h1 class="px">See what your coding agent reads before you type.</h1>
        <Tabs v-model:value="at" class="start">
          <TabsList aria-label="How to run it">
            <TabsTab value="humans">For humans</TabsTab>
            <TabsTab value="agents">For agents</TabsTab>
          </TabsList>
          <TabsPanel value="humans" class="start-body">
            <div class="start-line">
              <code><span class="pr" aria-hidden="true">$</span>npx loadsheet --ui</code>
              <CopyButton text="npx loadsheet --ui" label="Copy command" said="Command copied" />
            </div>
            <p>Run it in a terminal. The report opens in your browser.</p>
          </TabsPanel>
          <TabsPanel value="agents" class="start-body">
            <div class="start-line">
              <code class="wrap">{{ PROMPT }}</code>
              <CopyButton
                :text="PROMPT"
                label="Copy prompt"
                said="Prompt copied, paste it into your agent"
              />
            </div>
            <p>Paste it into Claude Code, Codex or OpenCode.</p>
          </TabsPanel>
        </Tabs>
        <form class="pack" @submit.prevent="go">
          <label for="pack-url">Check a skill pack before you install it</label>
          <span class="pack-row">
            <input
              id="pack-url"
              v-model="url"
              class="inp"
              placeholder="github.com/owner/repo"
              spellcheck="false"
              autocomplete="off"
            />
            <button data-slot="button" data-variant="solid" data-size="lg">Inspect</button>
          </span>
        </form>
        <nav class="ex" aria-label="Examples">
          <span>Examples</span>
          <RouterLink v-for="e in examples" :key="e.to" :to="e.to" :title="e.title">{{
            e.label
          }}</RouterLink>
        </nav>
      </div>
      <div class="mp-r">
        <Treemap
          class="tm-land"
          :blocks="blocks"
          @select="(id) => router.push({ path: '/report', query: { item: id } })"
        />
        <Legend
          :kinds="sum.kinds"
          :dead="sum.dead"
          :harness="{ name: `${harness} itself`, tokens: sum.harness }"
        />
      </div>
    </main>
  </div>
</template>

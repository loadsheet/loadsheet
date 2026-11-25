<script setup lang="ts">
import { computed } from "vue";
import Cmd from "../components/Cmd.vue";
import StateBox from "../components/StateBox.vue";
import { useHarness } from "../lib/harness";
import {
  agentPrompt,
  coverage,
  evidence,
  findingName,
  fixView,
  fmt,
  plural,
  report,
  saved,
  type Finding,
} from "../lib/report";
import { copy } from "../lib/ui";

const h = useHarness();
const groups = computed(() =>
  [
    { level: "cut", name: "Cut" },
    { level: "fix", name: "Fix" },
  ]
    .map((g) => ({ ...g, fixes: h.fixes.value.filter((f) => f.level === g.level) }))
    .filter((g) => g.fixes.length),
);
const KIND = {
  skill: "Skill",
  mcp: "MCP server",
  subagent: "Subagent",
  instructions: "Instruction file",
};
const SQ = { skill: "skill", mcp: "mcp", subagent: "agent", instructions: "instr" };
const prefix = (f: Finding) => f.item?.split(":")[0] as keyof typeof KIND | undefined;
const kindOf = (f: Finding) =>
  f.rule === "dead-pack"
    ? `Plugin · ${plural(f.evidence.skills ?? 0, "skill")}`
    : (KIND[prefix(f)!] ?? "");
const sq = (f: Finding) => `k-${f.level === "cut" ? "dead" : (SQ[prefix(f)!] ?? "skill")}`;
const notes = computed(() => coverage(report.value));
</script>

<template>
  <main class="pg-body narrow">
    <template v-if="h.fixes.value.length">
      <div class="ph">
        <div>
          <h1 class="px">
            {{ plural(h.fixes.value.length, "fix", "fixes")
            }}<template v-if="h.saving.value"
              >, up to {{ fmt(h.saving.value) }} tokens back</template
            >
          </h1>
          <p class="sub">loadsheet never edits your files.</p>
        </div>
        <button
          type="button"
          data-slot="button"
          data-variant="solid"
          data-size="lg"
          @click="copy(agentPrompt(h.fixes.value), 'Copied. Paste it into your agent')"
        >
          Copy all for your agent
        </button>
      </div>
      <section v-for="g in groups" :key="g.level" class="fxg">
        <h2>{{ g.name }}</h2>
        <ul>
          <li v-for="f in g.fixes" :key="f.id" class="fx">
            <i class="sq" :class="sq(f)" />
            <div class="fx-m">
              <div>
                <b class="mono">{{ findingName(f) }}</b><span class="muted">{{ kindOf(f) }}</span>
              </div>
              <p>{{ evidence(f) }}</p>
            </div>
            <Cmd v-if="fixView(f)" :fix="fixView(f)!" />
            <b class="save num">{{ saved(f) ? `−${fmt(saved(f))}` : "" }}</b>
          </li>
        </ul>
      </section>
    </template>
    <StateBox v-else title="Nothing to fix">
      Everything your setup loads was used, and nothing is heavier than it needs to be.
      <template #actions>
        <RouterLink
          data-slot="button"
          :to="{ path: '/report', query: { h: $route.query.h, r: $route.query.r } }"
          >Back to the map</RouterLink
        >
      </template>
    </StateBox>
    <details v-if="notes.length" class="cov">
      <summary>What loadsheet checked</summary>
      <ul>
        <li v-for="n in notes" :key="n">{{ n }}</li>
      </ul>
    </details>
  </main>
</template>

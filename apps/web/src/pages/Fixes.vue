<script setup lang="ts">
import { computed, reactive } from "vue";
import CopyIcon from "../components/CopyIcon.vue";
import FixCmd from "../components/FixCmd.vue";
import {
  agentPrompt,
  evidence,
  findingName,
  fmt,
  harnessName,
  plural,
  report,
  ruleName,
  saves,
} from "../lib/report";
import { copied, copy } from "../lib/ui";

const LEVELS = [
  {
    id: "cut",
    title: "Cut",
    sub: "Things no session used. Removing them only saves tokens.",
    fold: 5,
  },
  {
    id: "fix",
    title: "Fix",
    sub: "Things that are used, or should be, but cost more than they need to or can't be found.",
    fold: 4,
  },
  { id: "info", title: "Worth a look", sub: "", fold: 20 },
] as const;
const open = reactive<Record<string, boolean>>({});
const all = computed(() => report.value.findings);
const actionable = computed(() => all.value.filter((f) => f.fixes.length));
const groups = computed(() =>
  LEVELS.map((lv) => ({
    ...lv,
    fs: all.value
      .filter((f) => f.level === lv.id)
      .sort((a, b) => (b.savesTokens?.value ?? 0) - (a.savesTokens?.value ?? 0)),
  })).filter((g) => g.fs.length),
);

const SIG = [
  ["listing", "Listing"],
  ["modelUse", "Model use"],
  ["userUse", "Your use"],
  ["tokens", "Tokens"],
] as const;
const coverage = computed(() => report.value.coverage.filter((c) => c.installed));
const WHY: Record<string, string> = {
  userUse: "it doesn't record who called a skill",
  listing: "it doesn't record which skills it listed",
  modelUse: "it doesn't record skill use",
};
const skipped = computed(() =>
  report.value.skipped.map((s) => ({
    rule: ruleName(s.rule),
    harness: harnessName(s.harness),
    why:
      s.reason === "not-enough-data"
        ? "not enough sessions yet"
        : s.missing?.[0] && WHY[s.missing[0]]
          ? WHY[s.missing[0]]
          : `missing ${s.missing?.join(", ")}`,
  })),
);
const down = computed(() => report.value.machines.filter((m) => !m.reachable));
</script>

<template>
  <main class="page">
    <div class="page-head">
      <div>
        <h1 class="num">
          {{ plural(actionable.length, "fix", "fixes") }} that save {{ fmt(saves(all)) }} tokens a
          session
        </h1>
        <p>
          loadsheet never edits anything. Copy a fix, or all of them, and your agent applies them
          after you say yes.
        </p>
      </div>
      <button
        data-slot="button"
        data-variant="solid"
        @click="copy(agentPrompt(all), 'Prompt copied, paste it into your agent', 'all')"
      >
        <CopyIcon :done="copied.key === 'all'" />Copy all {{ actionable.length }} for your agent
      </button>
    </div>
    <div class="fixes">
      <div class="groups">
        <section v-for="g in groups" :key="g.id" class="card fgroup">
          <header>
            <h2>{{ g.title }}</h2>
            <span class="s"
              >{{ g.fs.length
              }}<template v-if="saves(g.fs)">
                · {{ fmt(saves(g.fs)) }} tokens a session</template
              ></span
            >
            <button
              v-if="g.fs.some((f) => f.fixes.length)"
              data-slot="button"
              data-size="sm"
              @click="copy(agentPrompt(g.fs), 'Prompt copied, paste it into your agent', g.title)"
            >
              <CopyIcon :done="copied.key === g.title" />Copy
              {{ g.fs.filter((f) => f.fixes.length).length }}
            </button>
          </header>
          <p v-if="g.sub" class="sub">{{ g.sub }}</p>
          <div v-for="f in open[g.id] ? g.fs : g.fs.slice(0, g.fold)" :key="f.id" class="frow">
            <div class="who">
              <span
                ><span
                  data-slot="vh-badge"
                  data-size="sm"
                  :data-tone="f.level === 'cut' ? 'error' : f.level === 'fix' ? 'info' : undefined"
                  >{{ ruleName(f.rule) }}</span
                ></span
              >
              <b>{{ findingName(f) }}</b>
            </div>
            <div class="ev">
              <p>{{ evidence(f) }}</p>
              <FixCmd :finding="f" />
              <span v-if="f.where.length" class="where">{{
                f.where.map((w) => `${w.machine} · ${harnessName(w.harness)}`).join(", ")
              }}</span>
            </div>
            <div class="save">
              <template v-if="f.savesTokens"><b>{{ fmt(f.savesTokens.value) }}</b>tokens</template>
            </div>
          </div>
          <button
            v-if="g.fs.length > g.fold && !open[g.id]"
            class="more"
            @click="open[g.id] = true"
          >
            Show {{ g.fs.length - g.fold }} more
          </button>
        </section>
      </div>
      <div class="aside">
        <section class="card pad">
          <div class="card-h"><h2>What loadsheet could see</h2></div>
          <table class="cov">
            <thead>
              <tr>
                <th>Harness · sessions</th>
                <th v-for="[, n] in SIG" :key="n">{{ n }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in coverage" :key="`${c.machine}:${c.harness}`">
                <td>
                  <b>{{ harnessName(c.harness) }}</b><br /><span class="faint num"
                    >{{ c.machine }} · {{ fmt(c.sessions) }}</span
                  >
                </td>
                <td v-for="[k, n] in SIG" :key="k">
                  <span class="g" :data-g="c.signals[k]" :aria-label="`${n}: ${c.signals[k]}`" />
                </td>
              </tr>
            </tbody>
          </table>
          <div class="legend">
            <span class="g" data-g="exact">exact</span
            ><span class="g" data-g="inferred">inferred</span
            ><span class="g" data-g="none">not recorded</span>
          </div>
        </section>
        <section v-if="skipped.length || down.length" class="card pad">
          <div class="card-h"><h2>Not checked</h2></div>
          <ul class="notes">
            <li v-for="(s, i) in skipped" :key="i">
              <span><b>{{ s.rule }}</b> on {{ s.harness }}: {{ s.why }}.</span>
            </li>
            <li v-for="m in down" :key="m.name" :title="m.error">
              <span><b>{{ m.name }}</b> didn't answer, so its sessions aren't in this report.</span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.fixes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 20px;
  align-items: start;
}
.groups {
  display: grid;
  gap: 16px;
}
.aside {
  position: sticky;
  top: calc(var(--bar) + 20px);
  display: grid;
  gap: 16px;
}
.fgroup {
  padding: 2px 16px 4px;
}
.fgroup header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 14px 0 10px;
}
.fgroup header h2 {
  font-size: 0.875rem;
}
.fgroup header .s {
  color: var(--muted-foreground);
  font: 0.75rem var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.fgroup header [data-slot="button"] {
  margin-left: auto;
}
.sub {
  margin: -4px 0 6px;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.frow {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 80px;
  gap: 6px 16px;
  padding: 11px 0;
  border-top: 1px solid var(--border);
}
.who {
  display: grid;
  align-content: start;
  gap: 5px;
}
.who b {
  font: 500 0.8125rem/1.35 var(--font-mono);
  overflow-wrap: anywhere;
}
.ev {
  display: grid;
  align-content: start;
  gap: 6px;
  font-size: 0.875rem;
}
.where {
  color: var(--faint);
  font: 0.6875rem var(--font-mono);
}
.save {
  color: var(--faint);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  text-align: end;
}
.save b {
  display: block;
  color: var(--foreground);
  font: 500 1rem/1.2 var(--font-mono);
}
.more {
  display: block;
  width: 100%;
  padding: 12px 0;
  border: 0;
  border-top: 1px solid var(--border);
  background: none;
  color: var(--acc);
  font-size: 0.8125rem;
  font-weight: 500;
  text-align: start;
  cursor: pointer;
}
.cov {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.cov th {
  padding: 0 4px 8px;
  color: var(--muted-foreground);
  font: 500 0.75rem/1.3 var(--font-sans);
  text-align: center;
  vertical-align: bottom;
}
.cov th:first-child {
  padding-left: 0;
  text-align: start;
}
.cov td {
  padding: 7px 0;
  border-top: 1px solid var(--border);
  text-align: center;
}
.cov td:first-child {
  text-align: start;
  white-space: nowrap;
}
.cov b {
  font-weight: 600;
}
.legend {
  margin-top: 12px;
}
.g {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.g::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.g[data-g="exact"]::before {
  background: var(--good);
}
.g[data-g="inferred"]::before {
  box-shadow: inset 0 0 0 2px var(--acc);
}
.g[data-g="none"]::before {
  box-shadow: inset 0 0 0 1.5px var(--faint);
}
.g[data-g="none"] {
  color: var(--faint);
}
.notes {
  display: grid;
  gap: 8px;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.notes li {
  display: flex;
  gap: 8px;
}
.notes li::before {
  content: "";
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 8px;
  border-radius: 50%;
  background: var(--faint);
}
.notes b {
  color: var(--foreground);
  font-weight: 600;
}
@media (max-width: 1080px) {
  .fixes {
    grid-template-columns: 1fr;
  }
  .aside {
    position: static;
  }
}
@media (max-width: 640px) {
  .frow {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .ev {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .page-head {
    flex-direction: column;
    align-items: start;
  }
}
</style>

<script setup lang="ts">
import { computed, ref } from "vue";
import ContextBar from "../components/ContextBar.vue";
import CopyIcon from "../components/CopyIcon.vue";
import { useHarness } from "../lib/harness";
import {
  agentPrompt,
  day,
  fmt,
  harnessName,
  isUsed,
  K,
  pct,
  plural,
  report,
  saves,
  uses,
  type KindId,
} from "../lib/report";
import { copied, copy } from "../lib/ui";

const h = useHarness();
const picked = ref<KindId>("dead");
const ctx = h.ctx;
const name = computed(() => harnessName(h.current.value));
const findings = computed(() =>
  report.value.findings.filter((f) => f.where.some((w) => w.harness === h.current.value)),
);
const cut = computed(() => saves(findings.value.filter((f) => f.level === "cut")));
const dead = computed(() => ctx.value?.segments.find((s) => s.id === "dead"));
const seg = computed(
  () => ctx.value?.segments.find((s) => s.id === picked.value) ?? ctx.value?.segments.at(-1),
);
const sorted = computed(() => [...(ctx.value?.segments ?? [])].sort((a, b) => b.tokens - a.tokens));
const segFixes = computed(() =>
  seg.value
    ? report.value.findings.filter((f) =>
        seg.value!.lines.some(
          (l) => f.item === l.item || (f.rule === "dead-pack" && f.pack === l.pack),
        ),
      )
    : [],
);
const skipped = computed(() => report.value.skipped.filter((s) => s.harness === h.current.value));
const minSessions = computed(() => report.value.config.rules["dead-skill"].minSessions);
</script>

<template>
  <main class="page">
    <template v-if="ctx">
      <div class="page-head">
        <div>
          <h1 class="num">{{ fmt(ctx.fixed) }} tokens before you type</h1>
          <p>
            What every {{ name }} session sends first,
            {{
              ctx.basis === "measured"
                ? "measured from the first request"
                : "estimated from file sizes"
            }}. {{ fmt(ctx.yours) }} of it is your own setup.
          </p>
        </div>
        <span class="when"
          >{{ day(report.window[0]) }} – {{ day(report.window[1]) }} ·
          {{ fmt(h.sessions.value) }} sessions</span
        >
      </div>

      <div class="stats">
        <div class="card stat">
          <div class="k">Before you type</div>
          <div class="v">{{ fmt(ctx.fixed) }}</div>
          <div class="s">{{ ctx.basis }}, averaged over {{ fmt(ctx.sheet.sessions) }} sessions</div>
        </div>
        <div class="card stat">
          <div class="k">Your setup</div>
          <div class="v">{{ fmt(ctx.yours) }}</div>
          <div class="s">{{ ctx.sheet.lines.length }} skills, files, servers and agents</div>
        </div>
        <div class="card stat" :class="{ warm: dead?.lines.length }">
          <div class="k">Never used</div>
          <div class="v">{{ plural(dead?.lines.length ?? 0, "skill") }}</div>
          <div class="s">{{ fmt(dead?.tokens ?? 0) }} tokens every session</div>
        </div>
        <div class="card stat">
          <div class="k">Fixes</div>
          <div class="v">{{ findings.length }}</div>
          <div class="s">cutting saves {{ fmt(cut) }} tokens a session</div>
        </div>
      </div>

      <div class="card pad">
        <div class="card-h">
          <h2>Every session starts with this</h2>
          <span class="legend"
            ><span v-for="s in ctx.segments" :key="s.id"
              ><i class="dot" :style="{ background: `var(${s.color})` }" />{{ s.name }}</span
            ></span
          >
        </div>
        <ContextBar :ctx="ctx" :selected="picked" @pick="picked = $event" />
      </div>

      <div class="split">
        <div class="card pad" style="padding-inline: 10px">
          <table class="rows">
            <thead>
              <tr>
                <th style="padding-left: 10px">Kind</th>
                <th class="r">Tokens</th>
                <th style="width: 30%">Share of the start</th>
                <th class="r">Items</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in sorted"
                :key="s.id"
                :data-on="picked === s.id || undefined"
                tabindex="0"
                @click="picked = s.id"
                @keydown.enter="picked = s.id"
              >
                <td>
                  <span class="kind"
                    ><i class="dot" :style="{ background: `var(${s.color})` }" />{{ s.name }}</span
                  >
                </td>
                <td class="r">{{ fmt(s.tokens) }}</td>
                <td>
                  <div class="share">
                    <i
                      :style="{
                        width: `${(s.tokens / ctx.fixed) * 100}%`,
                        background: `var(${s.color})`,
                      }"
                    />
                  </div>
                </td>
                <td class="r muted">{{ s.lines.length || "–" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="seg" class="card pad peek">
          <div>
            <div class="eyebrow num">
              {{ fmt(seg.tokens) }} tokens · {{ pct(seg.tokens / ctx.fixed) }}
            </div>
            <h3>{{ seg.name }}</h3>
          </div>
          <p class="what">{{ seg.what }}</p>
          <ul v-if="seg.lines.length" class="items">
            <li v-for="l in seg.lines" :key="l.item">
              <span class="nm">{{ l.ref.name }}</span>
              <span class="n">{{
                l.ref.kind !== "instructions" && isUsed(l) ? `${uses(l)}×` : ""
              }}</span>
              <span
                class="n"
                :title="
                  l.exposure.share < 1
                    ? `${fmt(l.tokens.value)} tokens in ${pct(l.exposure.share)} of sessions`
                    : undefined
                "
                >{{ K(l.tokens.value * l.exposure.share) }}</span
              >
            </li>
          </ul>
          <div v-if="segFixes.length" class="fixbox">
            <p>
              {{ plural(segFixes.length, "fix", "fixes") }} here save
              {{ fmt(saves(segFixes)) }} tokens a session.
            </p>
            <button
              data-slot="button"
              data-variant="solid"
              data-size="sm"
              @click="copy(agentPrompt(segFixes), 'Prompt copied, paste it into your agent', 'seg')"
            >
              <CopyIcon :done="copied.key === 'seg'" />Copy for your agent
            </button>
          </div>
        </div>
      </div>
    </template>

    <div v-else data-slot="vh-empty" data-variant="outline">
      <h3 data-slot="vh-empty-title">
        {{
          h.sessions.value
            ? `Only ${plural(h.sessions.value, "session")} so far`
            : `No ${name} sessions in the last ${report.config.window} days`
        }}
      </h3>
      <p data-slot="vh-empty-description">
        loadsheet found {{ name }} installed, but
        {{
          h.sessions.value
            ? `it needs ${minSessions} sessions to judge what ${name} loads`
            : "there is nothing to price until you use it"
        }}.
        <template v-if="skipped.length">
          {{ plural(skipped.length, "rule") }} didn't run here; Fixes says why.</template
        >
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
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.stat {
  padding: 12px 14px;
}
.stat .k {
  color: var(--muted-foreground);
  font: 500 0.75rem var(--font-sans);
}
.stat .v {
  margin-top: 4px;
  font: 500 1.375rem/1.1 var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.stat .s {
  margin-top: 4px;
  color: var(--muted-foreground);
  font-size: 0.75rem;
}
.stat.warm .v {
  color: var(--warm-ink);
}
.card-h .legend {
  font-size: 0.75rem;
  gap: 4px 12px;
  justify-content: end;
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}
.rows th {
  padding: 0 10px 8px 0;
  color: var(--muted-foreground);
  font: 500 0.75rem var(--font-sans);
  text-align: start;
  white-space: nowrap;
}
.rows td {
  padding: 9px 10px 9px 0;
  border-top: 1px solid var(--border);
  vertical-align: middle;
}
.rows td:first-child {
  padding-left: 10px;
}
.rows .r {
  text-align: end;
}
.rows td.r {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}
.rows tbody tr {
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .rows tbody tr:hover td {
    background: var(--accent);
  }
}
.rows tr[data-on] td {
  background: var(--muted);
}
.rows tr[data-on] td:first-child {
  box-shadow: inset 2px 0 var(--ice);
}
.kind {
  display: inline-flex;
  align-items: center;
  gap: 9px;
}
.share {
  height: 6px;
  border-radius: 3px;
  background: var(--muted);
  overflow: hidden;
}
.share i {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.peek {
  display: grid;
  gap: 14px;
}
.peek h3 {
  margin-top: 2px;
  font-size: 1rem;
  line-height: 1.3;
}
.peek .what {
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.items {
  display: grid;
  max-height: 300px;
  overflow: auto;
}
.items li {
  display: grid;
  grid-template-columns: 1fr auto 3.5em;
  gap: 12px;
  align-items: center;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 0.875rem;
}
.items li:first-child {
  border-top: 0;
}
.items .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 0.8125rem var(--font-mono);
}
.items .n {
  color: var(--muted-foreground);
  font: 0.75rem var(--font-mono);
  font-variant-numeric: tabular-nums;
  text-align: end;
}
.fixbox {
  display: grid;
  justify-items: start;
  gap: 10px;
  padding: 12px;
  border: 1px solid color-mix(in oklch, var(--warm) 25%, var(--border));
  border-radius: var(--r-md);
  background: var(--warm-tint);
}
.fixbox p {
  color: var(--warm-ink);
  font-size: 0.8125rem;
  font-weight: 500;
}
@media (max-width: 960px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 560px) {
  .rows th:nth-child(3),
  .rows td:nth-child(3) {
    display: none;
  }
  .card-h .legend {
    justify-content: start;
  }
}
</style>

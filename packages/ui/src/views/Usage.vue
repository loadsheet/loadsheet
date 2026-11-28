<script setup lang="ts">
import {
  NO_REPOSITORY,
  unreadUsageStores,
  usageRange,
  usageTokens,
  usageTotals,
  type UsageRow,
} from "@loadsheet/core";
import { computed, reactive } from "vue";
import CopyButton from "../components/CopyButton.vue";
import StateBox from "../components/StateBox.vue";
import { fmt, plural } from "../lib/report";
import { useLoadsheet } from "../lib/state";
import { usageRows } from "../lib/usage";

/**
  Sessions, compactions and tokens over the days the usage holds, as `loadsheet usage` counts them: one table with every harness
  summed on top, then one row per organisation that opens onto its projects. A shared report carries no usage.
*/
const { report, shared } = useLoadsheet();
const totals = computed(() => usageTotals(report.value.usage));
const unread = computed(() => unreadUsageStores(report.value));
const counted = computed(
  () => !!(totals.value.all.sessions || totals.value.all.tokens || totals.value.subagentSessions),
);

const sub = computed(() => {
  const r = report.value;
  const read = r.machines.filter((m) => m.reachable).length;
  const machines =
    read === r.machines.length
      ? plural(read, "machine")
      : `${fmt(read)} of ${plural(r.machines.length, "machine")}`;
  const where = r.machines.length > 1 ? `on ${machines}` : "on this machine";
  return `By org and project, ${usageRange(r.usage)}, ${where}.`;
});

/** The days `loadsheet usage --days` bounded the usage to; empty when it holds every day. */
const bound = computed(() => {
  const days = report.value.config.usageWindow;
  return days === undefined ? "" : ` in the last ${plural(days, "day")}`;
});

const open = reactive(new Set<string>());
const more = reactive(new Set<string>());
const rows = computed(() => usageRows(totals.value, open, more));
function toggle(key: string) {
  if (open.has(key)) open.delete(key);
  else open.add(key);
}
function onKey(e: KeyboardEvent, go: () => void) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  go();
}
const percent = (row: UsageRow) =>
  `${row.sessions ? Math.round((row.compacted / row.sessions) * 100) : 0}%`;
</script>

<template>
  <main class="pg-body narrow">
    <RouterLink
      class="back"
      :to="{ name: 'report', query: { h: $route.query.h, r: $route.query.r }, hash: $route.hash }"
      >← Report</RouterLink
    >
    <p v-if="!shared && unread.length" role="status">
      Usage is incomplete. Could not read: {{ unread.join(", ") }}.
    </p>
    <template v-if="report.usage && counted">
      <div class="ph">
        <div>
          <h1 class="px">
            {{ plural(totals.all.sessions, "session") }},
            {{ usageTokens(totals.all.tokens) }} tokens
          </h1>
          <p class="sub">{{ sub }}</p>
        </div>
      </div>
      <div class="ccard">
        <table class="ctable ut">
          <thead>
            <tr>
              <th>Org</th>
              <th class="r">Sessions</th>
              <th class="r">Compacted</th>
              <th class="r">Tokens</th>
              <th class="r">Share</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in rows" :key="r.key">
              <tr
                v-if="r.t === 'grp'"
                class="grp"
                :class="{ open: r.open, all: r.key === 'all', nr: r.row.name === NO_REPOSITORY }"
                :tabindex="r.canOpen ? 0 : undefined"
                :aria-expanded="r.canOpen ? r.open : undefined"
                @click="r.canOpen && toggle(r.key)"
                @keydown="r.canOpen && onKey($event, () => toggle(r.key))"
              >
                <td>
                  <span class="car"
                    ><svg
                      v-if="r.canOpen"
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      aria-hidden="true"
                    >
                      <path
                        d="M4.5 2.5 8 6 4.5 9.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      /></svg></span
                  ><span class="nm">{{ r.label }}</span
                  ><span v-if="r.key === 'all' && totals.subagentSessions" class="note"
                    >plus {{ plural(totals.subagentSessions, "subagent session") }}</span
                  >
                </td>
                <td class="r num">{{ fmt(r.row.sessions) }}</td>
                <td class="r num">
                  <span class="cn">{{ fmt(r.row.compacted) }}</span
                  ><span class="pc muted">{{ percent(r.row) }}</span>
                </td>
                <td class="r num">{{ usageTokens(r.row.tokens) }}</td>
                <td class="r num muted">{{ r.row.share }}%</td>
              </tr>
              <tr v-else-if="r.t === 'it'" class="it l1" :class="{ h: r.key.startsWith('all:') }">
                <td>
                  <span class="nm">{{ r.label }}</span>
                </td>
                <td class="r num">{{ fmt(r.row.sessions) }}</td>
                <td class="r num">
                  <span class="cn">{{ fmt(r.row.compacted) }}</span
                  ><span class="pc muted">{{ percent(r.row) }}</span>
                </td>
                <td class="r num">{{ usageTokens(r.row.tokens) }}</td>
                <td class="r num muted">{{ r.row.share }}%</td>
              </tr>
              <tr v-else class="more-row l1">
                <td colspan="5">
                  <button type="button" class="more-b" @click="more.add(r.list)">
                    <span class="mi"
                      ><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path
                          d="M2.5 4.5 6 8l3.5-3.5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        /></svg
                    ></span>
                    Show {{ r.n }} more<span class="mv num"
                      >{{ usageTokens(r.tokens) }} tokens</span
                    >
                  </button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
    <StateBox v-else-if="shared" title="Usage stays on your machines">
      A shared link leaves out your projects and their sessions and tokens. Run this where your
      agents run to see them.
      <template #actions>
        <div class="cmd">
          <code><span class="pr" aria-hidden="true">$</span>npx loadsheet usage</code>
          <CopyButton text="npx loadsheet usage" label="Copy command" />
        </div>
      </template>
    </StateBox>
    <StateBox v-else-if="!unread.length" title="Nothing to count yet">
      No session{{ bound }} said its project or tokens.
    </StateBox>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import NoSessions from "../components/NoSessions.vue";
import { useHarness } from "../lib/harness";
import {
  KINDS,
  actionName,
  day,
  findingsFor,
  fmt,
  isDead,
  kindName,
  kindOf,
  report,
  type Kind,
  type Line,
} from "../lib/report";

const h = useHarness();
const route = useRoute();
const filter = ref<Kind | "dead" | "">("");
const q = ref("");

const lines = computed(() =>
  [...(h.sheet.value?.lines ?? [])].sort((a, b) => h.cost.value(b) - h.cost.value(a)),
);
const chips = computed(() => [
  ...KINDS.map((k) => ({
    id: k.id,
    name: k.many,
    n: lines.value.filter((l) => kindOf(l) === k.id).length,
  })).filter((c) => c.n),
  { id: "dead" as const, name: "Never used", n: lines.value.filter(isDead).length },
]);
const shown = computed(() =>
  lines.value.filter(
    (l) =>
      (!filter.value || (filter.value === "dead" ? isDead(l) : kindOf(l) === filter.value)) &&
      l.ref.name.toLowerCase().includes(q.value.trim().toLowerCase()),
  ),
);
const max = computed(() => Math.max(1, ...lines.value.map((l) => h.cost.value(l))));
const sq = (l: Line) => `k-${isDead(l) ? "dead" : kindOf(l)}`;
const fixOf = (l: Line) =>
  h.sheet.value ? findingsFor(report.value, h.current.value, l)[0] : undefined;
const open = (l: Line) => ({ query: { ...route.query, item: l.item } });
</script>

<template>
  <NoSessions v-if="!h.sheet.value" />
  <main v-else class="pg-body">
    <div class="ph">
      <h1 class="px">{{ lines.length }} things load with your setup</h1>
    </div>
    <div class="tools">
      <div class="fchips" role="group" aria-label="Show">
        <button type="button" class="fchip" :aria-pressed="!filter" @click="filter = ''">
          All <b class="num">{{ lines.length }}</b>
        </button>
        <template v-for="c in chips" :key="c.id">
          <button
            v-if="c.n"
            type="button"
            class="fchip"
            :aria-pressed="filter === c.id"
            @click="filter = filter === c.id ? '' : c.id"
          >
            <i :class="`k-${c.id}`" />{{ c.name }} <b class="num">{{ c.n }}</b>
          </button>
        </template>
      </div>
      <input
        v-model="q"
        class="inp search"
        type="search"
        placeholder="Filter by name"
        aria-label="Filter by name"
        spellcheck="false"
        autocomplete="off"
      />
    </div>
    <div class="lt-wrap">
      <table class="lt">
        <thead>
          <tr>
            <th>Name</th>
            <th class="c-kind">Kind</th>
            <th>{{ h.sheet.value.sessions ? "Tokens a session" : "Tokens" }}</th>
            <th class="c-num c-ses">Sessions</th>
            <th>Used</th>
            <th class="c-last">Last used</th>
            <th><span class="sr">Fix</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="l in shown"
            :key="l.item"
            :data-dead="isDead(l) || undefined"
            :aria-selected="$route.query.item === l.item"
          >
            <td>
              <RouterLink class="c-name" :to="open(l)"
                ><i class="sq" :class="sq(l)" /><b class="mono">{{ l.ref.name }}</b></RouterLink
              >
            </td>
            <td class="muted c-kind">{{ kindName(kindOf(l)) }}</td>
            <td class="c-tok">
              <span class="tb"
                ><i
                  :class="sq(l)"
                  :style="{ width: `${Math.max(1.5, (h.cost.value(l) / max) * 100)}%` }"
              /></span>
              <b class="num">{{ fmt(h.cost.value(l)) }}</b>
            </td>
            <td class="c-num c-ses num">{{ fmt(l.exposure.sessions) }}</td>
            <td>
              <span v-if="l.ref.kind === 'instructions'" class="muted"
                >read in every session that loads it</span
              >
              <span v-else-if="isDead(l)" class="chip no">never used</span>
              <span v-else-if="l.use.byModel || l.use.byUser" class="use">
                <template v-if="l.use.byModel"
                  ><b class="num">{{ fmt(l.use.byModel) }}</b> by the model</template
                >
                <template v-if="l.use.byModel && l.use.byUser"> · </template>
                <template v-if="l.use.byUser"
                  ><b class="num">{{ fmt(l.use.byUser) }}</b> by you</template
                >
              </span>
            </td>
            <td class="muted c-last">{{ l.use.lastUsed ? day(l.use.lastUsed) : "—" }}</td>
            <td class="c-fix">
              <RouterLink v-if="fixOf(l)" :to="open(l)">{{ actionName(fixOf(l)!) }}</RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>

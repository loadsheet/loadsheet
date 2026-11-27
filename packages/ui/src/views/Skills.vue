<script setup lang="ts">
import { computed, ref } from "vue";
import SiteTop from "../components/SiteTop.vue";
import { fmt } from "../lib/report";
import {
  BODY_NOTE,
  BUDGET,
  JOBS,
  LISTING_NOTE,
  type SkillCatalog,
  type SkillPack,
  kchars,
  longDescriptions,
  md,
  ofBudget,
  packTotals,
  packsFor,
  skillCompareRoute,
  skillPackRoute,
} from "../lib/skills";

/** The reviewed skill packs in one table, heaviest first, against the setup budget. */
const props = defineProps<{ catalog: SkillCatalog }>();

const rows = computed(() =>
  props.catalog.packs.map((p) => ({ p, ...packTotals(p), flags: longDescriptions(p).length })),
);
type Row = (typeof rows.value)[number];
type Key = "tokens" | "skills" | "body" | "flags" | "stars";
const job = ref("all");
const key = ref<Key>("tokens");
const desc = ref(true);
const val = (r: Row, k: Key) => (k === "stars" ? r.p.stars : r[k]);
const shown = computed(() =>
  rows.value
    .filter((r) => job.value === "all" || r.p.jobs.includes(job.value))
    .toSorted((a, b) => (val(b, key.value) - val(a, key.value)) * (desc.value ? 1 : -1)),
);
function sortBy(k: Key) {
  desc.value = key.value === k ? !desc.value : true;
  key.value = k;
}
const aria = (k: Key) => (key.value === k ? (desc.value ? "descending" : "ascending") : undefined);

const jobs = computed(() =>
  Object.keys(JOBS)
    .map((j) => ({ j, n: packsFor(props.catalog, j).length }))
    .filter((x) => x.n),
);
const compares = computed(() => Object.keys(props.catalog.copy.compare));
const what = (p: SkillPack) => props.catalog.copy.packs[p.slug]?.what ?? "";
</script>

<template>
  <div class="land">
    <SiteTop />
    <main class="w sk">
      <div class="ph">
        <div>
          <h1 class="px">{{ catalog.copy.index.title }}</h1>
          <p class="sub" v-html="md(catalog.copy.index.sub)" />
          <p class="muted sk-small">{{ LISTING_NOTE }} {{ BODY_NOTE }}</p>
        </div>
      </div>
      <div class="sk-tools">
        <div class="fchips" role="group" aria-label="Job">
          <button class="fchip" type="button" :aria-pressed="job === 'all'" @click="job = 'all'">
            All <b>{{ catalog.packs.length }}</b>
          </button>
          <button
            v-for="x in jobs"
            :key="x.j"
            class="fchip"
            type="button"
            :aria-pressed="job === x.j"
            @click="job = x.j"
          >
            {{ JOBS[x.j] }} <b>{{ x.n }}</b>
          </button>
        </div>
        <span v-if="compares.length" class="muted sk-small">
          Compare
          <template v-for="(j, i) in compares" :key="j"
            ><RouterLink class="sk-lnk" :to="skillCompareRoute(j)">{{ JOBS[j] ?? j }}</RouterLink
            >{{ i < compares.length - 1 ? " · " : "" }}</template
          >
          packs
        </span>
      </div>
      <div class="sk-table-wrap" role="region" aria-label="Sortable skill packs" tabindex="0">
        <table class="sk-t">
          <thead>
            <tr>
              <th>Pack</th>
              <th class="r" :aria-sort="aria('tokens')">
                <button type="button" class="sk-sort" @click="sortBy('tokens')">
                  Listing tokens
                </button>
              </th>
              <th class="r" :aria-sort="aria('skills')">
                <button type="button" class="sk-sort" @click="sortBy('skills')">Skills</button>
              </th>
              <th class="r" :aria-sort="aria('body')">
                <button type="button" class="sk-sort" @click="sortBy('body')">SKILL.md body</button>
              </th>
              <th class="r" :aria-sort="aria('flags')">
                <button type="button" class="sk-sort" @click="sortBy('flags')">Flags</button>
              </th>
              <th class="r" :aria-sort="aria('stars')">
                <button type="button" class="sk-sort" @click="sortBy('stars')">Stars</button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="r.p.slug">
              <td class="sk-nm">
                <RouterLink class="mono" :to="skillPackRoute(r.p.slug)">{{ r.p.slug }}</RouterLink>
                <span class="sk-what" v-html="md(what(r.p))" />
              </td>
              <td class="num r">
                <b>{{ fmt(r.tokens) }}</b>
                <span class="sk-bar"
                  ><i :style="{ width: `${Math.min(100, (r.tokens / BUDGET) * 100)}%` }"
                /></span>
                <span class="sk-pct muted">{{ ofBudget(r.tokens) }} of budget</span>
              </td>
              <td class="num r">
                {{ r.skills
                }}<span v-if="r.slashOnly" class="muted"> · {{ r.slashOnly }} slash-only</span>
              </td>
              <td class="num r">{{ kchars(r.body) }}</td>
              <td class="r">
                <span v-if="r.flags" class="chip sk-warn"
                  >{{ r.flags }} long description{{ r.flags === 1 ? "" : "s" }}</span
                >
                <span v-else class="chip">none</span>
              </td>
              <td class="num r muted">{{ fmt(r.p.stars) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="muted sk-small sk-foot">
        Measured {{ catalog.measuredAt }}.
        <template v-for="u in catalog.unmeasured" :key="u.slug">
          Not measured yet: <code>{{ u.slug }}</code>, {{ u.why }}.
        </template>
      </p>
    </main>
  </div>
</template>

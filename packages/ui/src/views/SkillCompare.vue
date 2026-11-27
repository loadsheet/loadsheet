<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import HelpTip from "../components/HelpTip.vue";
import SiteTop from "../components/SiteTop.vue";
import SkillBlocks from "../components/SkillBlocks.vue";
import StateBox from "../components/StateBox.vue";
import { fmt } from "../lib/report";
import {
  BODY_NOTE,
  BUDGET,
  LISTING_NOTE,
  type SkillCatalog,
  kchars,
  longDescriptions,
  md,
  ofBudget,
  packTotals,
  packsFor,
  skillPackRoute,
} from "../lib/skills";

/** The packs for one job side by side, from the route's `job`, with the review of which to pick. */
const props = defineProps<{ catalog: SkillCatalog }>();

const route = useRoute();
const job = computed(() => String(route.params.job ?? ""));
const c = computed(() => props.catalog.copy.compare[job.value]);
const cols = computed(() =>
  packsFor(props.catalog, job.value).map((p) => ({
    p,
    ...packTotals(p),
    flags: longDescriptions(p).length,
  })),
);
const low = computed(() => Math.min(...cols.value.map((x) => x.tokens)));
</script>

<template>
  <div class="land">
    <SiteTop />
    <main v-if="c" class="w sk">
      <RouterLink class="back" :to="{ name: 'skills' }">← All skill packs</RouterLink>
      <div class="ph">
        <div>
          <h1 class="px">{{ c.title }}</h1>
          <p class="sub" v-html="md(c.sub)" />
          <p class="muted sk-small">{{ LISTING_NOTE }}</p>
        </div>
      </div>
      <div class="sk-table-wrap" role="region" aria-label="Skill pack comparison" tabindex="0">
        <table class="sk-t sk-cmp">
          <thead>
            <tr>
              <th />
              <th v-for="x in cols" :key="x.p.slug">
                <RouterLink class="mono" :to="skillPackRoute(x.p.slug)">{{ x.p.slug }}</RouterLink>
                <span class="sk-by">{{ x.p.by }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Listing tokens</th>
              <td v-for="x in cols" :key="x.p.slug">
                <span class="num sk-big" :class="{ 'sk-lo': x.tokens === low }">{{
                  fmt(x.tokens)
                }}</span>
                <span class="muted"> tokens</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Budget</th>
              <td v-for="x in cols" :key="x.p.slug">
                <SkillBlocks :pack="x.p" :height="16" />
                <span class="muted num sk-small"
                  >{{ ofBudget(x.tokens) }} of {{ fmt(BUDGET) }}</span
                >
              </td>
            </tr>
            <tr>
              <th scope="row">Skills</th>
              <td v-for="x in cols" :key="x.p.slug" class="num">
                {{ x.skills
                }}<span v-if="x.slashOnly" class="muted"> · {{ x.slashOnly }} slash-only</span>
              </td>
            </tr>
            <tr>
              <th scope="row">
                <HelpTip :text="BODY_NOTE">SKILL.md body</HelpTip>
              </th>
              <td v-for="x in cols" :key="x.p.slug">
                <span class="num">{{ kchars(x.body) }}</span> <span class="muted">chars</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Flags</th>
              <td v-for="x in cols" :key="x.p.slug">
                <span v-if="x.flags" class="chip sk-warn"
                  >{{ x.flags }} long description{{ x.flags === 1 ? "" : "s" }}</span
                >
                <span v-else class="chip">none</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Heaviest skill</th>
              <td v-for="x in cols" :key="x.p.slug">
                <template v-if="x.p.items[0]">
                  <code>{{ x.p.items[0].name }}</code>
                  {{ " " }}<span class="num muted">{{ fmt(x.p.items[0].tokens) }}</span>
                </template>
              </td>
            </tr>
            <tr>
              <th scope="row">Stars</th>
              <td v-for="x in cols" :key="x.p.slug" class="num muted">{{ fmt(x.p.stars) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="sk-cols">
        <article class="sk-post"><p v-for="(x, i) in c.post" :key="i" v-html="md(x)" /></article>
        <aside>
          <h2 class="sk-h3">Who should pick which</h2>
          <ul class="sk-verdict">
            <li v-for="v in c.verdict" :key="v.slug">
              <RouterLink class="mono" :to="skillPackRoute(v.slug)">{{ v.slug }}</RouterLink>
              <span v-html="md(v.line)" />
            </li>
          </ul>
        </aside>
      </div>
    </main>
    <main v-else class="w pg-body">
      <StateBox title="No comparison for this job">
        loadsheet compares the packs for {{ Object.keys(catalog.copy.compare).join(" and ") }}.
        <template #actions>
          <RouterLink data-slot="button" data-variant="solid" :to="{ name: 'skills' }"
            >See all skill packs</RouterLink
          >
        </template>
      </StateBox>
    </main>
  </div>
</template>

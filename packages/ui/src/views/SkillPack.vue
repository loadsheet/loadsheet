<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import SiteTop from "../components/SiteTop.vue";
import SkillBlocks from "../components/SkillBlocks.vue";
import SkillFiles from "../components/SkillFiles.vue";
import StateBox from "../components/StateBox.vue";
import { fmt, packRoute } from "../lib/report";
import {
  BUDGET,
  JOBS,
  type SkillCatalog,
  type SkillFiles as Files,
  githubUrl,
  kchars,
  md,
  ofBudget,
  packTotals,
  skillCompareRoute,
} from "../lib/skills";

/**
  One reviewed pack: what it adds to every session against the budget, the review, and its files. The route's `slug`
  names the pack, one segment per folder; `files` is that pack's file list.
*/
const props = defineProps<{ catalog: SkillCatalog; files?: Files }>();

const route = useRoute();
const slug = computed(() => [route.params.slug ?? []].flat().filter(Boolean).join("/"));
const p = computed(() => props.catalog.packs.find((x) => x.slug === slug.value));
const c = computed(() => props.catalog.copy.packs[slug.value]);
const t = computed(() => (p.value ? packTotals(p.value) : undefined));
const compares = computed(() => p.value?.jobs.filter((j) => props.catalog.copy.compare[j]) ?? []);
</script>

<template>
  <div class="land">
    <SiteTop />
    <main v-if="p && c && t" class="w sk">
      <RouterLink class="back" :to="{ name: 'skills' }">← All skill packs</RouterLink>
      <div class="ph">
        <div>
          <p class="mono sk-slug">{{ p.slug }} <span class="muted">by {{ p.by }}</span></p>
          <h1 class="px">Adds {{ fmt(t.tokens) }} tokens to every session</h1>
          <p class="sub" v-html="md(c.what)" />
        </div>
        <a data-slot="button" data-size="lg" :href="githubUrl(p)">View on GitHub</a>
      </div>

      <SkillBlocks :pack="p" :height="32" label />

      <div class="sk-cols">
        <article class="sk-post">
          <p v-for="(x, i) in c.post" :key="i" v-html="md(x)" />
        </article>
        <aside>
          <p class="sk-pick" v-html="md(c.pick)" />
          <p class="sk-skip" v-html="md(c.skip)" />
          <dl class="sk-facts">
            <dt>Every session</dt>
            <dd class="num">{{ fmt(t.tokens) }} · {{ ofBudget(t.tokens) }} of {{ fmt(BUDGET) }}</dd>
            <dt>Skills</dt>
            <dd class="num">{{ t.skills }}</dd>
            <dt>Listed every session</dt>
            <dd class="num">{{ t.listed }}</dd>
            <dt>On use</dt>
            <dd class="num">{{ kchars(t.body) }} chars</dd>
            <dt>Stars</dt>
            <dd class="num">{{ fmt(p.stars) }}</dd>
            <dt>Last push</dt>
            <dd class="num">{{ p.pushed }}</dd>
            <dt>Measured at</dt>
            <dd class="num mono">{{ p.sha.slice(0, 7) }}</dd>
          </dl>
          <p v-if="compares.length" class="sk-also">
            Compare:
            <template v-for="(j, i) in compares" :key="j"
              ><RouterLink class="sk-lnk" :to="skillCompareRoute(j)"
                >{{ JOBS[j] ?? j }} packs</RouterLink
              >{{ i < compares.length - 1 ? " · " : "" }}</template
            >
          </p>
        </aside>
      </div>

      <template v-if="files">
        <h2 class="sk-h2">Skills <span class="num muted">{{ t.skills }}</span></h2>
        <SkillFiles :pack="p" :files="files" />
      </template>
    </main>
    <main v-else class="w pg-body">
      <StateBox title="No review of this pack yet">
        loadsheet reviews {{ catalog.packs.length }} skill packs. You can still weigh any pack on
        GitHub.
        <template #actions>
          <RouterLink data-slot="button" data-variant="solid" :to="{ name: 'skills' }"
            >See the reviewed packs</RouterLink
          >
          <RouterLink v-if="slug" data-slot="button" :to="packRoute(slug)"
            >Weigh it live</RouterLink
          >
        </template>
      </StateBox>
    </main>
  </div>
</template>

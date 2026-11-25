<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Legend from "../components/Legend.vue";
import SiteTop from "../components/SiteTop.vue";
import StateBox from "../components/StateBox.vue";
import Treemap, { type Block } from "../components/Treemap.vue";
import {
  findingName,
  fmt,
  kindOf,
  packSlug,
  packTokens,
  packs,
  saved,
  shortName,
  totals,
} from "../lib/report";

const route = useRoute();
const router = useRouter();
const slug = computed(() => String(route.params.slug ?? "").replace(/\/+$/, ""));
/** Without a server the page knows the packs bundled with it; any other URL shows the state for a pack it couldn't read. */
const pack = computed(() => packs[slug.value]);
const sheet = computed(() => pack.value?.report.sheet[0]);
const listed = computed(() => sheet.value?.lines.filter((l) => l.tokens.value > 0) ?? []);
const free = computed(() => sheet.value?.lines.filter((l) => l.tokens.value === 0) ?? []);
const sum = computed(() => (sheet.value ? totals(sheet.value) : undefined));
const blocks = computed<Block[]>(() =>
  listed.value.map((l) => ({
    id: l.item,
    name: l.ref.name,
    label: shortName(l),
    value: l.tokens.value,
    group: kindOf(l),
  })),
);
const max = computed(() => pack.value?.report.config.rules["expensive-description"].maxChars ?? 0);
const url = ref("");
watch(slug, (s) => (url.value = `github.com/${s}`), { immediate: true });
function go() {
  const s = packSlug(url.value);
  if (s) router.push(`/pack/${s}`);
}
</script>

<template>
  <div class="land">
    <SiteTop />
    <main class="w pk">
      <form class="pack" @submit.prevent="go">
        <span class="pack-row">
          <input
            v-model="url"
            class="inp"
            aria-label="Skill pack on GitHub"
            spellcheck="false"
            autocomplete="off"
          />
          <button data-slot="button" data-variant="solid" data-size="lg">Inspect</button>
        </span>
      </form>
      <template v-if="pack && sheet && sum">
        <div class="ph">
          <h1 class="px">Adds {{ fmt(packTokens(pack.report)) }} tokens to every session</h1>
        </div>
        <Legend v-if="sum.kinds.length > 1" class="pk-key" :kinds="sum.kinds" />
        <Treemap
          v-if="blocks.length"
          class="tm-pack"
          :blocks="blocks"
          unit="tokens"
          :interactive="false"
        />
        <div class="pk-2">
          <div v-if="free.length">
            <h3>Costs nothing until called <em class="num">{{ free.length }}</em></h3>
            <div class="hid">
              <span v-for="l in free" :key="l.item" class="mono">{{ l.ref.name }}</span>
            </div>
          </div>
          <div v-if="pack.report.findings.length">
            <h3>Worth knowing <em class="num">{{ pack.report.findings.length }}</em></h3>
            <ul class="pk-f">
              <li v-for="f in pack.report.findings" :key="f.id">
                <b class="mono">{{ findingName(f) }}</b>
                <p v-if="f.rule === 'expensive-description'">
                  Its description is {{ fmt(f.evidence.listedChars ?? 0) }} characters.<template
                    v-if="saved(f)"
                  >
                    Under {{ fmt(max) }} would save {{ fmt(saved(f)) }} tokens a session.</template
                  >
                </p>
                <p v-else>
                  {{
                    Object.entries(f.evidence)
                      .map(([k, v]) => `${k} ${fmt(v)}`)
                      .join(" · ")
                  }}
                </p>
              </li>
            </ul>
          </div>
        </div>
      </template>
      <StateBox v-else :title="`This page can’t read ${slug}`">
        It shows the packs below. To weigh any pack on GitHub, run
        <code>npx loadsheet &lt;GitHub URL&gt;</code> in a terminal.
        <template #actions>
          <RouterLink v-for="(p, s) in packs" :key="s" data-slot="button" :to="`/pack/${s}`">{{
            s
          }}</RouterLink>
        </template>
      </StateBox>
    </main>
  </div>
</template>

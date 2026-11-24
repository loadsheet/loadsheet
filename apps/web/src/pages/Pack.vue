<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Logo from "../components/Logo.vue";
import SkillGrid from "../components/SkillGrid.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import { fmt, harnessName, kinds, packSlug, packTokens, packs } from "../lib/report";

const route = useRoute();
const router = useRouter();
const slug = computed(() => String(route.params.slug ?? "").replace(/\/+$/, ""));
/** Without a server the page knows the packs bundled with it; any other URL shows the state for a pack it couldn't read. */
const pack = computed(() => packs[slug.value]);
const sheet = computed(() => pack.value?.report.sheet[0]);
const onDemand = computed(() => sheet.value?.lines.filter((l) => !l.chars.listed).length ?? 0);
const url = ref("");
watch(slug, (s) => (url.value = `github.com/${s}`), { immediate: true });
function go() {
  const s = packSlug(url.value);
  if (s) router.push(`/pack/${s}`);
}
</script>

<template>
  <header class="top">
    <nav aria-label="Pack">
      <RouterLink class="brand" to="/"><Logo /><span>loadsheet</span></RouterLink>
    </nav>
    <i class="vr" />
    <span class="crumb"><span class="muted">pack</span> <b>{{ pack?.title ?? slug }}</b></span>
    <div class="right">
      <form class="url" @submit.prevent="go">
        <input v-model="url" aria-label="Pack URL" spellcheck="false" autocomplete="off" />
        <button class="btn secondary sm">Inspect</button>
      </form>
      <ThemeToggle />
    </div>
  </header>
  <SkillGrid v-if="pack && sheet" :key="slug" :r="pack.report" :lines="sheet.lines" pack-mode>
    <template #side>
      <div>
        <div class="eyebrow">Adds to every session</div>
        <div class="big num">{{ fmt(packTokens(pack.report)) }}</div>
        <p class="muted small">
          tokens in every {{ harnessName(sheet.harness) }} session, from {{ kinds(sheet.lines) }}<template v-if="onDemand">, {{ onDemand }} of them on demand only</template>. Estimated from file sizes.
        </p>
      </div>
      <div class="src">
        <div class="eyebrow">Source</div>
        <a :href="pack.report.source" target="_blank" rel="noreferrer" class="mono">{{ slug }}</a>
        <span v-if="pack.by" class="muted small">by {{ pack.by }}</span>
      </div>
    </template>
    <template #side-end>
      <p class="card hint">Usage isn't measured for a pack. Install it, then run <code>npx loadsheet</code> after a few days to see what you use.</p>
    </template>
  </SkillGrid>
  <main v-else class="page">
    <div class="card empty">
      <div class="eyebrow">{{ slug }}</div>
      <h3>No skills found in {{ slug }}</h3>
      <p>loadsheet looks for <code>SKILL.md</code> files and agent definitions in the repository's default branch. Check the URL, or open one of these.</p>
      <div class="alts">
        <RouterLink v-for="(p, s) in packs" :key="s" class="btn secondary sm" :to="`/pack/${s}`">{{ s }}</RouterLink>
      </div>
    </div>
  </main>
</template>

<style scoped>
.big { margin-top: 4px; font: 500 1.625rem/1.1 var(--mono); }
.small { margin-top: 4px; }
.src { display: grid; gap: 3px; }
.src a { color: var(--ink); font: 0.75rem var(--mono); text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; transition: text-decoration-color 0.15s var(--ease); }
@media (hover: hover) and (pointer: fine) { .src a:hover { text-decoration-color: currentColor; } }
.hint { padding: 12px 14px; color: var(--muted); font-size: 0.8125rem; }
.crumb { min-width: 0; overflow: hidden; font-size: 0.8125rem; text-overflow: ellipsis; white-space: nowrap; }
.crumb b { font-weight: 500; }
.url { display: inline-flex; align-items: center; height: 32px; padding: 0 3px 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease); }
@media (hover: hover) and (pointer: fine) { .url:hover { border-color: color-mix(in oklch, var(--muted) 50%, var(--line-strong)); } }
.url:focus-within { border-color: var(--ice); box-shadow: 0 0 0 3px var(--ice-tint); }
.url input { width: 260px; border: 0; background: none; outline: none; font: 0.75rem var(--mono); }
.url .btn { min-height: 24px; }
.alts { display: flex; flex-wrap: wrap; gap: 6px; }
@media (max-width: 720px) { .url input { width: 130px; font-size: 1rem; } }
@media (max-width: 560px) { .crumb { display: none; } }
</style>

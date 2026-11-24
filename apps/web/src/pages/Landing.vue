<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useRouter } from "vue-router";
import CopyIcon from "../components/CopyIcon.vue";
import Logo from "../components/Logo.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import { fmt, harnessName, packSlug, packTokens, packs, report } from "../lib/report";
import { copied, copy } from "../lib/ui";

const PROMPT =
  "Run `npx loadsheet --json` and read the report. Tell me which skills, instruction files and MCP servers cost the most context and which never get used. Don't change anything until I pick the fixes.";
const tabs = [
  { id: "humans", name: "For humans", text: "npx loadsheet --ui", note: "Run it in a terminal. The report opens in your browser.", said: "Command copied" },
  { id: "agents", name: "For agents", text: PROMPT, note: "Paste it into Claude Code, Codex or OpenCode.", said: "Prompt copied, paste it into your agent" },
] as const;
const at = ref(0);
const tab = computed(() => tabs[at.value]!);
const tabEls = ref<HTMLButtonElement[]>([]);
/** Arrow keys move between the tabs and select, as the APG tabs pattern does. */
async function key(e: KeyboardEvent) {
  const step = { ArrowRight: 1, ArrowLeft: -1, Home: -at.value, End: tabs.length - 1 - at.value }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  at.value = (at.value + step + tabs.length) % tabs.length;
  await nextTick();
  tabEls.value[at.value]?.focus();
}

const router = useRouter();
const url = ref("");
function go() {
  router.push(`/pack/${packSlug(url.value) ?? "mattpocock/skills"}`);
}

const harness = harnessName(report.value.sheet[0]!.harness);
const examples = [
  { to: "/report", label: `${harness} report`, title: `A month of ${harness}, an example report` },
  ...["mattpocock/skills", "cursor/plugins/pstack"].map((slug) => {
    const p = packs[slug]!;
    return { to: `/pack/${slug}`, label: slug, title: `${p.title}${p.by ? ` by ${p.by}` : ""}, ${fmt(packTokens(p.report))} tokens a session` };
  }),
];
</script>

<template>
  <header class="top bare">
    <div class="right">
      <a class="btn quiet icon" href="https://github.com/loadsheet/loadsheet" aria-label="loadsheet on GitHub">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2Z" /></svg>
      </a>
      <ThemeToggle />
    </div>
  </header>

  <main class="home">
    <div class="mark"><Logo /><h1>loadsheet</h1></div>

    <section class="card start" aria-label="Get started">
      <div class="part">
        <div class="tabrow">
          <div class="seg" role="tablist" aria-label="How to run it" @keydown="key">
            <button
              v-for="(t, i) in tabs"
              :id="`tab-${t.id}`"
              :key="t.id"
              ref="tabEls"
              role="tab"
              :aria-selected="i === at"
              :aria-controls="`panel-${t.id}`"
              :tabindex="i === at ? 0 : -1"
              @click="at = i"
            >
              {{ t.name }}
            </button>
          </div>
          <button class="btn secondary icon" :aria-label="tab.id === 'humans' ? 'Copy command' : 'Copy prompt'" @click="copy(tab.text, tab.said, tab.id)">
            <CopyIcon :done="copied.key === tab.id" />
          </button>
        </div>
        <div :id="`panel-${tab.id}`" role="tabpanel" :aria-labelledby="`tab-${tab.id}`" class="panel">
          <p v-if="tab.id === 'humans'" class="well cmdline"><span class="faint" aria-hidden="true">$</span> {{ tab.text }}</p>
          <p v-else class="well">{{ tab.text }}</p>
          <p class="muted small">{{ tab.note }}</p>
        </div>
      </div>
      <form class="part" @submit.prevent="go">
        <label class="label" for="pack-url">Check a skill pack before you install it</label>
        <span class="url">
          <input id="pack-url" v-model="url" placeholder="github.com/owner/repo" spellcheck="false" autocomplete="off" />
          <button class="btn secondary sm">Inspect</button>
        </span>
      </form>
    </section>

    <nav class="examples" aria-label="Examples">
      <span class="faint small">Examples</span>
      <RouterLink v-for="e in examples" :key="e.to" class="pill" :to="e.to" :title="e.title">{{ e.label }}</RouterLink>
    </nav>
  </main>
</template>

<style scoped>
.bare { border-bottom: 0; background: transparent; }
.home { display: grid; justify-items: center; width: min(600px, 100%); margin: 0 auto; padding: 14vh 16px 48px; }
.mark { display: inline-flex; align-items: center; gap: 14px; }
.mark svg { width: 40px; height: 40px; }
.mark h1 { font: 500 2.75rem/1 var(--mono); letter-spacing: -0.04em; }
.start { display: grid; width: 100%; margin-top: 36px; }
.part { display: grid; gap: 10px; padding: 14px 16px 16px; }
.part + .part { border-top: 1px solid var(--line); }
.tabrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.panel { display: grid; gap: 8px; }
.well { min-height: 40px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--paper-2); font: 0.8125rem/1.6 var(--mono); overflow-wrap: anywhere; }
.cmdline { white-space: nowrap; overflow-x: auto; }
.label { color: var(--muted); font-size: 0.75rem; font-weight: 500; }
.url { display: flex; align-items: center; height: 36px; padding: 0 4px 0 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease); }
@media (hover: hover) and (pointer: fine) { .url:hover { border-color: color-mix(in oklch, var(--muted) 50%, var(--line-strong)); } }
.url:focus-within { border-color: var(--ice); box-shadow: 0 0 0 3px var(--ice-tint); }
.url input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font: 0.8125rem var(--mono); }
.url input::placeholder { color: var(--faint); }

/* Examples are plain chips under the card: a round hairline, mono text a step back, full ink on hover. */
.examples { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; margin-top: 18px; }
.examples > span { margin-right: 2px; }
.pill { position: relative; display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); font: 0.6875rem var(--mono); text-decoration: none; white-space: nowrap; transition: color 0.15s var(--ease), border-color 0.15s var(--ease), background-color 0.15s var(--ease), transform 0.12s var(--ease); }
.pill::after { content: ""; position: absolute; inset: -6px -2px; }
.pill:active { transform: scale(0.96); }
@media (hover: hover) and (pointer: fine) { .pill:hover { border-color: var(--line-strong); color: var(--ink); } }
@media (pointer: coarse) { .pill { min-height: 36px; } }
@media (max-width: 560px) {
  .home { padding-top: 72px; }
  .mark h1 { font-size: 2.125rem; }
  .mark svg { width: 30px; height: 30px; }
  .url input { font-size: 1rem; }
}
</style>

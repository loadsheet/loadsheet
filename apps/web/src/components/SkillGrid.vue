<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { agentPrompt, bodyTokens, evidence, findingsFor, fmt, isUsed, K, kinds, perSession, plural, ruleName, shortName, uses, type Line, type Report } from "../lib/report";
import { copied, copy } from "../lib/ui";
import CopyIcon from "./CopyIcon.vue";
import FixCmd from "./FixCmd.vue";

const props = defineProps<{ r: Report; lines: Line[]; packMode?: boolean }>();
const OWN = "Your own";
const packOf = (l: Line) => l.pack ?? OWN;
const flagged = (l: Line) => findingsFor(props.r, l).length > 0;

const show = ref<"all" | "dead" | "flag">("all");
const sort = ref<"listed" | "use" | "body" | "name">("listed");
const packs = computed(() => [...new Set(props.lines.map(packOf))]);
const off = ref(new Set<string>());
const open = ref<string>();
watch(() => props.lines, () => { open.value = undefined; off.value = new Set(); });

const list = computed(() =>
  props.lines
    .filter((l) => !off.value.has(packOf(l)))
    .filter((l) => show.value === "all" || (show.value === "dead" ? !isUsed(l) : flagged(l)))
    .sort((a, b) =>
      sort.value === "name" ? a.ref.name.localeCompare(b.ref.name)
      : sort.value === "use" ? uses(b) - uses(a)
      : sort.value === "body" ? b.chars.body - a.chars.body
      : b.tokens.value - a.tokens.value),
);
const groups = computed(() =>
  packs.value
    .map((p) => ({ name: p, lines: list.value.filter((l) => packOf(l) === p) }))
    .filter((g) => g.lines.length)
    .map((g) => ({ ...g, tokens: g.lines.reduce((n, l) => n + (props.packMode ? l.tokens.value : perSession(l)), 0) }))
    .sort((a, b) => b.tokens - a.tokens),
);
const dead = computed(() => (props.packMode ? [] : list.value.filter((l) => !isUsed(l))));
const deadFixes = computed(() => [...new Set(dead.value.flatMap((l) => findingsFor(props.r, l)))]);
const toggle = (p: string, on: boolean) => {
  const s = new Set(off.value);
  if (on) s.delete(p);
  else s.add(p);
  off.value = s;
};

const line = computed(() => props.lines.find((l) => l.item === open.value));
const fs = computed(() => (line.value ? findingsFor(props.r, line.value) : []));
const sessions = computed(() => props.r.sheet.find((s) => s.lines.includes(line.value!))?.sessions ?? 0);
const longChars = (l: Line) => findingsFor(props.r, l).find((f) => f.rule === "expensive-description")?.evidence.listedChars;
</script>

<template>
  <div class="body2">
    <aside class="side">
      <slot name="side" />
      <div>
        <h4>Show</h4>
        <label class="opt"><input v-model="show" type="radio" value="all" /> All <span class="n">{{ lines.length }}</span></label>
        <label v-if="!packMode" class="opt"><input v-model="show" type="radio" value="dead" /> Never used <span class="n">{{ lines.filter((l) => !isUsed(l)).length }}</span></label>
        <label class="opt"><input v-model="show" type="radio" value="flag" /> {{ packMode ? "Long description" : "Has a fix" }} <span class="n">{{ lines.filter(flagged).length }}</span></label>
      </div>
      <div v-if="packs.length > 1">
        <h4>Packs</h4>
        <label v-for="p in packs" :key="p" class="opt"><input type="checkbox" :checked="!off.has(p)" @change="toggle(p, ($event.target as HTMLInputElement).checked)" /> <span class="pk">{{ p }}</span> <span class="n">{{ lines.filter((l) => packOf(l) === p).length }}</span></label>
      </div>
      <div>
        <h4>Sort</h4>
        <select v-model="sort" aria-label="Sort">
          <option value="listed">Cost per session</option>
          <option v-if="!packMode" value="use">Times used</option>
          <option value="body">Cost when used</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div class="legend">
        <span><i class="dot" style="background: var(--k-used)" />listed: name and description, every session</span>
        <span><i class="dot" style="background: var(--k-harness)" />body: the SKILL.md, only when used</span>
      </div>
      <slot name="side-end" />
    </aside>

    <div class="gridmain" :class="{ narrow: line }">
      <slot name="top" />
      <div v-if="dead.length" class="banner">
        <div class="v">{{ fmt(dead.reduce((n, l) => n + perSession(l), 0)) }}</div>
        <p>tokens every session go to {{ plural(dead.length, "skill") }} here that no session used.</p>
        <button v-if="deadFixes.length" class="btn sm" @click="copy(agentPrompt(deadFixes), 'Prompt copied, paste it into your agent', 'dead')"><CopyIcon :done="copied.key === 'dead'" />Copy fixes for your agent</button>
      </div>
      <section v-for="g in groups" :key="g.name" class="group">
        <h3>{{ g.name }} <span>{{ kinds(g.lines) }} · {{ fmt(g.tokens) }} tokens a session</span></h3>
        <div class="cards">
          <button v-for="l in g.lines" :key="l.item" class="sk" :class="{ dead: !packMode && !isUsed(l) }" :data-on="open === l.item || undefined" @click="open = open === l.item ? undefined : l.item">
            <span class="nm" :title="l.ref.name">{{ shortName(l) }}</span>
            <span v-if="packMode && l.description" class="desc">{{ l.description }}</span>
            <span class="chips">
              <span v-if="packMode && !l.chars.listed" class="chip" title="Hidden from the model until you call it by name">on demand</span>
              <span v-else class="chip"><b>{{ fmt(l.tokens.value) }}</b> listed</span>
              <span class="chip">{{ K(bodyTokens(l)) }} body</span>
              <template v-if="packMode"><span v-if="longChars(l)" class="chip warm">{{ fmt(longChars(l)!) }}-char description</span></template>
              <span v-else-if="isUsed(l)" class="chip"><b>{{ uses(l) }}×</b> used</span>
              <span v-else class="chip warm"><b>never</b> used</span>
            </span>
          </button>
        </div>
      </section>
      <p v-if="!groups.length" class="muted">Nothing matches. Try “All”.</p>
    </div>

    <Transition name="drawer">
      <aside v-if="line" class="drawer" :aria-label="line.ref.name">
        <button class="btn quiet icon x" aria-label="Close" @click="open = undefined">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
        <div>
          <div class="eyebrow">{{ packOf(line) }}<template v-if="line.managedBy"> · {{ line.managedBy }}</template></div>
          <h2>{{ line.ref.name }}</h2>
        </div>
        <p v-if="packMode && line.description" class="descfull">{{ line.description }}</p>
        <div>
          <div class="costbar"><i :style="{ flexGrow: line.tokens.value, background: 'var(--k-used)' }" /><i :style="{ flexGrow: bodyTokens(line), background: 'var(--k-harness)' }" /></div>
          <p class="verdict">
            <template v-if="packMode && !line.chars.listed">Not listed to the model, so it costs nothing until you call it by name. Then it loads about {{ fmt(bodyTokens(line)) }} tokens.</template>
            <template v-else-if="packMode">{{ fmt(line.tokens.value) }} tokens in every session once installed, and about {{ fmt(bodyTokens(line)) }} more each time it runs.</template>
            <template v-else-if="isUsed(line)">{{ fmt(line.tokens.value) }} tokens in each of {{ fmt(line.exposure.sessions) }} sessions bought {{ plural(uses(line), "use") }}.</template>
            <template v-else>{{ fmt(line.tokens.value) }} tokens in each of {{ fmt(line.exposure.sessions) }} sessions, and none used it.</template>
          </p>
        </div>
        <dl class="kv">
          <dt>Listed</dt><dd>{{ fmt(line.tokens.value) }} tokens, {{ line.tokens.basis }}</dd>
          <dt>Body</dt><dd>about {{ fmt(bodyTokens(line)) }} tokens, when used</dd>
          <template v-if="!packMode">
            <dt>Used</dt><dd>{{ isUsed(line) ? `${line.use.byModel} by the model, ${line.use.byUser} by you` : "never" }}</dd>
            <dt>Listed in</dt><dd>{{ fmt(line.exposure.sessions) }} of {{ fmt(sessions) }} sessions<template v-if="line.exposure.bare">, {{ fmt(line.exposure.bare) }} without its description</template></dd>
            <template v-if="line.machines.length"><dt>On</dt><dd>{{ line.machines.join(", ") }}</dd></template>
          </template>
          <template v-if="line.path"><dt>File</dt><dd class="mono">{{ line.path }}</dd></template>
        </dl>
        <div v-for="f in fs" :key="f.id" class="fnd">
          <span><span class="tag" :class="f.level === 'cut' ? 'warm' : 'ice'">{{ ruleName(f.rule) }}</span></span>
          <p>{{ evidence(f) }}<template v-if="f.savesTokens"> Saves {{ fmt(f.savesTokens.value) }} tokens a session.</template></p>
          <FixCmd :finding="f" />
        </div>
        <button v-if="fs.length" class="btn end" @click="copy(agentPrompt(fs), 'Prompt copied, paste it into your agent', 'drawer')"><CopyIcon :done="copied.key === 'drawer'" />Copy for your agent</button>
        <p v-else class="muted small end">Nothing to fix here.</p>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.gridmain { min-width: 0; }
/* The open drawer floats on the right; the cards move over instead of hiding under it. */
.gridmain.narrow { padding-right: 380px; }
@media (max-width: 900px) { .gridmain.narrow { padding-right: 12px; } }
/* The morning banner: a red-tinted strip with the number large. */
.banner { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-bottom: 20px; padding: 10px 10px 10px 14px; border: 1px solid color-mix(in oklch, var(--warm) 25%, var(--line)); border-radius: var(--r-lg); background: var(--warm-tint); }
.banner .v { font: 500 1.5rem/1 var(--mono); color: var(--warm-ink); font-variant-numeric: tabular-nums; }
.banner p { flex: 1 1 220px; color: var(--ink); font-size: 0.8125rem; }
.banner .btn { margin-left: auto; }
.group + .group { margin-top: 24px; }
.group h3 { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin-bottom: 8px; font: 500 0.75rem/1.3 var(--mono); }
.group h3 span { color: var(--muted); font: 400 0.75rem var(--sans); font-variant-numeric: tabular-nums; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.sk { display: grid; align-content: start; gap: 7px; padding: 9px 10px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); text-align: start; cursor: pointer; }
.sk { transition: box-shadow 0.15s var(--ease), border-color 0.15s var(--ease), transform 0.12s var(--ease); }
.sk:active { transform: scale(0.98); }
@media (hover: hover) and (pointer: fine) { .sk:hover { border-color: var(--line-strong); box-shadow: 0 1px 2px oklch(0 0 0 / 0.05); } .sk.dead:hover { border-color: var(--warm); } }
.sk[data-on], .sk[data-on]:hover { border-color: var(--ice); box-shadow: 0 0 0 3px var(--ice-tint); }
/* Never used: the first inspector's dashed outline, in the cut colour. */
.sk.dead { border-style: dashed; border-color: color-mix(in oklch, var(--warm) 50%, var(--line)); }
.sk.dead[data-on], .sk.dead[data-on]:hover { border-style: solid; border-color: var(--warm); box-shadow: 0 0 0 3px var(--warm-tint); }
.sk .nm { overflow: hidden; font: 500 0.78125rem/1.3 var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.sk .desc { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 0.8125rem; line-height: 1.45; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
/* The morning detail panel: pinned to the right edge under the bar, bordered off, a soft shadow to the left. */
.drawer { position: fixed; top: var(--bar); right: 0; bottom: 0; z-index: 6; display: flex; flex-direction: column; gap: 16px; width: min(360px, 100vw); padding: 16px; border-left: 1px solid var(--line); background: var(--surface); box-shadow: var(--side-shadow); overflow: auto; }
.drawer-enter-active { transition: translate 0.24s var(--ease), opacity 0.24s var(--ease); }
.drawer-leave-active { transition: translate 0.16s ease-in, opacity 0.16s ease-in; }
.drawer-enter-from, .drawer-leave-to { translate: 16px 0; opacity: 0; }
.x { position: absolute; top: 10px; right: 10px; }
.drawer h2 { margin-top: 2px; padding-right: 36px; font: 500 1rem/1.3 var(--mono); overflow-wrap: anywhere; }
.descfull { color: var(--muted); font-size: 0.875rem; }
.costbar { display: flex; gap: 2px; height: 10px; overflow: hidden; border-radius: 4px; }
.costbar i { display: block; flex-basis: 0; height: 100%; }
.verdict { margin-top: 8px; color: var(--muted); font-size: 0.875rem; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; font-size: 0.875rem; }
.kv dt { color: var(--muted); }
.kv dd { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.kv dd.mono { font-size: 0.8125rem; }
.fnd { display: grid; gap: 8px; }
.fnd p { font-size: 0.875rem; }
.end { margin-top: auto; }
@media (max-width: 900px) { .drawer { top: 0; z-index: 20; width: 100vw; border-left: 0; } }
</style>

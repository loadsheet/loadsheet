<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { agentPrompt, bodyTokens, findingsFor, fmt, isUsed, K, perSession, report, uses, type Line } from "../lib/report";
import { copied, copy, esc, hideTip, showTip } from "../lib/ui";
import CopyIcon from "./CopyIcon.vue";

const props = defineProps<{ lines: Line[] }>();
const W = 900, H = 640, m = { l: 64, r: 20, t: 24, b: 56 };
const maxD = computed(() => Math.max(1, ...props.lines.map((l) => l.tokens.value)) * 1.06);
const ly = (u: number) => Math.log10(u + 1);
const maxU = computed(() => Math.max(ly(10), ly(Math.max(...props.lines.map(uses)))) * 1.06);
const X = (d: number) => m.l + (d / maxD.value) * (W - m.l - m.r);
const Y = (u: number) => H - m.b - (ly(u) / maxU.value) * (H - m.t - m.b);
const R = (l: Line) => Math.min(12, 3.5 + Math.sqrt(bodyTokens(l)) / 9);
/** Never-used dots sit on the floor; spread them a little so they don't stack. */
const jit = (l: Line) => ([...l.ref.name].reduce((n, c) => n + c.charCodeAt(0), 0) % 13) - 6;
const cy = (l: Line) => Y(uses(l)) + (isUsed(l) ? 0 : jit(l) * 2.2 - 10);
const xMid = computed(() => X(report.value.config.rules["expensive-description"].maxChars / 4));
const yMid = computed(() => Y(1));
const ticksY = computed(() => [0, 1, 3, 10, 30, 100, 300, 1000].filter((u) => ly(u) <= maxU.value));
const ticksX = computed(() => {
  const step = maxD.value > 400 ? 100 : maxD.value > 160 ? 50 : 25;
  return Array.from({ length: Math.floor(maxD.value / step) + 1 }, (_, i) => i * step);
});
const labels = computed(() => {
  const placed: number[][] = [];
  const out: { x: number; y: number; end: boolean; name: string }[] = [];
  const cand = props.lines.filter(isUsed).sort((a, b) => uses(b) + b.tokens.value - (uses(a) + a.tokens.value));
  for (const l of cand) {
    const x = X(l.tokens.value), y = Y(uses(l)), w = l.ref.name.length * 6.4, end = x > W - 170;
    const x0 = end ? x - R(l) - 4 - w : x + R(l) + 4;
    const box = [x0 - 2, y - 9, x0 + w + 2, y + 7];
    const hit = placed.some((p) => box[0]! < p[2]! && box[2]! > p[0]! && box[1]! < p[3]! && box[3]! > p[1]!);
    const dot = props.lines.some((o) => o !== l && isUsed(o) && Math.abs(X(o.tokens.value) - (box[0]! + box[2]!) / 2) < w / 2 + R(o) && Math.abs(Y(uses(o)) - y) < 8 + R(o));
    if (hit || dot || out.length >= 14) continue;
    placed.push(box);
    out.push({ x: end ? x - R(l) - 4 : x + R(l) + 4, y: y + 4, end, name: l.ref.name });
  }
  return out;
});

const dead = computed(() => props.lines.filter((l) => !isUsed(l)).sort((a, b) => b.tokens.value - a.tokens.value));
const picked = ref(new Set<string>());
watch(dead, (d) => (picked.value = new Set(d.filter((l) => l.tokens.value >= 40).map((l) => l.item))), { immediate: true });
const hover = ref<string>();
const chosen = computed(() => dead.value.filter((l) => picked.value.has(l.item)));
const prompt = computed(() => {
  const fs = [...new Set(chosen.value.flatMap((l) => findingsFor(report.value, l)))];
  return agentPrompt(fs);
});
const pick = (id: string, on: boolean) => {
  const s = new Set(picked.value);
  if (on) s.add(id);
  else s.delete(id);
  picked.value = s;
};
function tipFor(e: MouseEvent, l: Line) {
  showTip(e, `<b>${esc(l.ref.name)}</b>${l.pack ? ` · ${esc(l.pack)}` : ""}<br>${fmt(l.tokens.value)} tokens a session · ${K(bodyTokens(l))} when used<br>${isUsed(l) ? `used ${uses(l)}×` : "never used"}`);
}
</script>

<template>
  <div class="body3">
    <div class="plot">
      <slot name="top" />
      <svg :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="Each skill's cost per session against the times it was used" @mouseleave="hideTip">
        <rect :x="xMid" :y="yMid" :width="W - m.r - xMid" :height="H - m.b - yMid + 10" rx="10" fill="var(--warm-tint)" />
        <line :x1="xMid" :x2="xMid" :y1="m.t" :y2="H - m.b" stroke="var(--input)" stroke-dasharray="3 4" />
        <line :x1="m.l" :x2="W - m.r" :y1="yMid" :y2="yMid" stroke="var(--input)" stroke-dasharray="3 4" />
        <text class="quad" :x="m.l + 12" :y="m.t + 14">Cheap · used</text>
        <text class="quad" :x="W - m.r - 12" :y="m.t + 14" text-anchor="end">Expensive · used · shorten it</text>
        <text class="quad warm" :x="W - m.r - 12" :y="H - m.b - 12" text-anchor="end">Never used · remove</text>
        <text v-for="u in ticksY" :key="`y${u}`" class="ax" :x="m.l - 10" :y="Y(u) + 4" text-anchor="end">{{ u }}</text>
        <text v-for="d in ticksX" :key="`x${d}`" class="ax" :x="X(d)" :y="H - m.b + 20" text-anchor="middle">{{ d }}</text>
        <text class="axl" :x="(m.l + W - m.r) / 2" :y="H - 12" text-anchor="middle">tokens it costs every session →</text>
        <text class="axl" :transform="`translate(18 ${(m.t + H - m.b) / 2}) rotate(-90)`" text-anchor="middle">times used, log scale →</text>
        <circle
          v-for="l in lines"
          :key="l.item"
          class="pt"
          :cx="X(l.tokens.value)"
          :cy="cy(l)"
          :r="R(l) + (hover === l.item ? 5 : 0)"
          :fill="`var(${isUsed(l) ? '--k-used' : '--k-dead'})`"
          :fill-opacity="isUsed(l) ? 0.55 : 0.6"
          :stroke="`var(${isUsed(l) ? '--k-used' : '--k-dead'})`"
          :stroke-width="hover === l.item ? 3 : 1"
          @mousemove="tipFor($event, l)"
        />
        <text v-for="t in labels" :key="t.name" class="lbl" :x="t.x" :y="t.y" :text-anchor="t.end ? 'end' : 'start'">{{ t.name }}</text>
      </svg>
      <div class="legend">
        <span><i class="dot round" style="background: var(--k-used)" />used</span>
        <span><i class="dot round" style="background: var(--k-dead)" />never used</span>
        <span class="faint">dot size: the SKILL.md body</span>
      </div>
    </div>
    <aside class="qlist">
      <div>
        <div class="eyebrow">Never used, priciest first</div>
        <div class="v">{{ fmt(dead.reduce((n, l) => n + perSession(l), 0)) }}</div>
        <p class="muted small">tokens every session spends on skills no session used</p>
      </div>
      <ol>
        <li v-for="l in dead" :key="l.item" :data-on="hover === l.item || undefined" @mouseenter="hover = l.item" @mouseleave="hover = undefined">
          <label><input type="checkbox" :checked="picked.has(l.item)" @change="pick(l.item, ($event.target as HTMLInputElement).checked)" />{{ l.ref.name }}<span class="n">{{ fmt(l.tokens.value) }}</span></label>
        </li>
      </ol>
      <button data-slot="button" data-variant="solid" :disabled="!chosen.length" :data-disabled="!chosen.length || undefined" @click="copy(prompt, 'Prompt copied, paste it into your agent', 'chosen')">
        <CopyIcon :done="copied.key === 'chosen'" />Copy {{ chosen.length }} for your agent · saves {{ fmt(chosen.reduce((n, l) => n + perSession(l), 0)) }}
      </button>
    </aside>
  </div>
</template>

<style scoped>
.body3 { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; padding: 16px 20px 28px; }
.plot { display: grid; align-content: start; gap: 8px; padding: 16px 18px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--card); }
.plot svg { width: 100%; height: auto; max-height: calc(100dvh - 200px); }
.pt { cursor: pointer; transition: r 0.12s var(--ease); }
.quad { font: 500 11px var(--font-mono); fill: var(--faint); }
.quad.warm { fill: var(--warm-ink); }
.ax { font: 12px var(--font-sans); fill: var(--faint); font-variant-numeric: tabular-nums; }
.axl { font: 500 13px var(--font-sans); fill: var(--muted-foreground); }
.lbl { font: 500 11.5px var(--font-sans); fill: var(--muted-foreground); }
.legend { padding-left: 64px; }
.dot.round { border-radius: 50%; }
.qlist { position: sticky; top: calc(var(--bar) + 16px); display: flex; flex-direction: column; gap: 14px; max-height: calc(100dvh - var(--bar) - 32px); padding: 16px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--card); }
.qlist .v { margin-top: 4px; font: 500 1.625rem/1.1 var(--font-mono); color: var(--warm-ink); font-variant-numeric: tabular-nums; }
.qlist ol { flex: 0 1 auto; min-height: 0; margin-inline: -8px; overflow: auto; }
.qlist li label { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 8px; border-radius: var(--r-sm); font-size: 0.875rem; cursor: pointer; }
.qlist li[data-on] label { background: var(--muted); }
.qlist li input { margin: 0; accent-color: var(--ice); }
.qlist li .n { margin-left: auto; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.qlist [data-slot="button"][data-disabled] { pointer-events: none; }
@media (max-width: 960px) {
  .body3 { grid-template-columns: 1fr; }
  .body3 { padding: 14px 12px 24px; }
  .qlist { position: static; max-height: none; }
}
</style>

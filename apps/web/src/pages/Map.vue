<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useHarness } from "../lib/harness";
import { fmt, isUsed, K, pct, perSession, uses, type Line } from "../lib/report";
import { squarify } from "../lib/squarify";
import { esc, hideTip, showTip } from "../lib/ui";

interface Node {
  name: string;
  value: number;
  color: string;
  kids?: Node[];
  line?: Line;
  dead?: boolean;
}

const h = useHarness();
const withHarness = ref(true);
const byUse = ref(false);
const path = ref<string[]>([]);
watch(h.current, () => (path.value = []));

function byPack(lines: Line[], color: string): Node[] {
  const m = new Map<string, Line[]>();
  for (const l of lines) m.set(l.pack ?? "Your own", [...(m.get(l.pack ?? "Your own") ?? []), l]);
  return [...m].map(([name, ls]) => ({
    name,
    color,
    value: ls.reduce((n, l) => n + perSession(l), 0),
    kids: ls.map((l) => ({ name: l.ref.name, value: perSession(l), color, line: l })),
  }));
}
const tree = computed<Node | undefined>(() => {
  const ctx = h.ctx.value;
  if (!ctx) return undefined;
  const kids = ctx.segments
    .filter((s) => withHarness.value || s.id !== "harness")
    .map((s) => ({
      name: s.name,
      value: s.tokens,
      color: s.color,
      dead: s.id === "dead",
      kids:
        s.id === "used" || s.id === "dead"
          ? byPack(s.lines, s.color)
          : s.lines.length
            ? s.lines.map((l) => ({
                name: l.ref.name,
                value: perSession(l),
                color: s.color,
                line: l,
              }))
            : undefined,
    }));
  return { name: "Before you type", value: kids.reduce((n, k) => n + k.value, 0), color: "", kids };
});
const node = computed(() => {
  let n = tree.value;
  for (const p of path.value) n = n?.kids?.find((k) => k.name === p) ?? n;
  return n;
});

const host = ref<HTMLElement>();
const box = ref({ w: 980, h: 640 });
let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver(
    ([e]) => e && (box.value = { w: e.contentRect.width, h: e.contentRect.height }),
  );
  ro.observe(host.value!);
});
onBeforeUnmount(() => ro?.disconnect());

const colorOf = (n: Node) => {
  if (!byUse.value) return n.color;
  if (n.line)
    return n.line.ref.kind === "skill" ? (isUsed(n.line) ? "--k-used" : "--k-dead") : "--k-harness";
  return n.dead ? "--k-dead" : n.color === "--k-used" ? "--k-used" : "--k-harness";
};
const rects = computed(() => squarify(node.value?.kids ?? [], 0, 0, box.value.w, box.value.h));
const total = computed(() => h.ctx.value?.fixed ?? 1);
function tipFor(e: MouseEvent, n: Node) {
  const use =
    n.line?.ref.kind === "skill"
      ? `<br>${isUsed(n.line) ? `used ${uses(n.line)}×` : "never used"}`
      : "";
  showTip(
    e,
    `<b>${esc(n.name)}</b><br>${fmt(n.value)} tokens · ${pct(n.value / total.value)} of the start${use}${n.kids ? "<br>click to open" : ""}`,
  );
}
const open = (n: Node) => n.kids && path.value.push(n.name);
</script>

<template>
  <div class="body2">
    <aside class="side">
      <div>
        <h4>Count</h4>
        <label class="opt"
          ><input v-model="withHarness" type="checkbox" /> What the harness sends itself</label
        >
      </div>
      <div>
        <h4>Colour by</h4>
        <label class="opt"><input v-model="byUse" type="radio" :value="false" /> Kind</label>
        <label class="opt"
          ><input v-model="byUse" type="radio" :value="true" /> Used or never used</label
        >
      </div>
      <div v-if="node" class="card selbox">
        <div class="eyebrow">Showing</div>
        <div class="nm">{{ node.name }}</div>
        <div class="k">
          {{ fmt(node.value) }} tokens · {{ pct(node.value / total) }} of the start
        </div>
      </div>
      <div class="legend">
        <template v-if="byUse">
          <span><i class="dot" style="background: var(--k-used)" />used at least once</span>
          <span><i class="dot" style="background: var(--k-dead)" />never used</span>
          <span><i class="dot" style="background: var(--k-harness)" />not a skill</span>
        </template>
        <template v-else>
          <span v-for="s in h.ctx.value?.segments" :key="s.id"
            ><i class="dot" :style="{ background: `var(${s.color})` }" />{{ s.name }}</span
          >
        </template>
      </div>
    </aside>
    <div class="mapcol">
      <nav class="crumbs" aria-label="Path">
        <button @click="path = []">Before you type</button>
        <template v-for="(p, i) in path" :key="p"
          ><span aria-hidden="true">/</span
          ><button @click="path = path.slice(0, i + 1)">{{ p }}</button></template
        >
        <span class="num total">{{ fmt(node?.value ?? 0) }} tokens</span>
      </nav>
      <div ref="host" class="tm" @mouseleave="hideTip">
        <component
          :is="r.item.kids ? 'button' : 'div'"
          v-for="r in rects"
          :key="r.item.name"
          class="n"
          :class="{ lt: colorOf(r.item) === '--k-harness' }"
          :style="{
            left: `${r.x + 1.5}px`,
            top: `${r.y + 1.5}px`,
            width: `${Math.max(0, r.w - 3)}px`,
            height: `${Math.max(0, r.h - 3)}px`,
            background: `var(${colorOf(r.item)})`,
          }"
          @mousemove="tipFor($event, r.item)"
          @click="open(r.item)"
        >
          <template v-if="r.w > 54 && r.h > 34"
            ><span class="t">{{ r.item.name }}</span
            ><span class="kk">{{ K(r.item.value) }}</span></template
          >
        </component>
        <p v-if="!rects.length" class="muted">Nothing to show for this harness.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mapcol {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--card);
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  color: var(--muted-foreground);
  font: 0.75rem var(--font-mono);
}
.crumbs button {
  padding: 2px 4px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--ice);
  font: inherit;
  cursor: pointer;
}
.crumbs button:last-of-type {
  color: var(--foreground);
}
.crumbs .total {
  margin-left: auto;
}
.tm {
  position: relative;
  height: max(420px, calc(100dvh - var(--bar) - 100px));
  margin: 10px;
}
.n {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: start;
  overflow: hidden;
  padding: 6px 7px;
  border: 0;
  border-radius: 3px;
  color: var(--on-k);
  font-size: 0.75rem;
  line-height: 1.25;
  text-align: start;
  box-shadow: inset 0 0 0 1px oklch(1 0 0 / 0.12);
  transition: filter 0.12s var(--ease);
}
button.n {
  cursor: pointer;
}
.n.lt {
  color: var(--foreground);
}
.n:hover {
  filter: brightness(1.08);
  box-shadow: inset 0 0 0 2px var(--foreground);
}
.t {
  max-width: 100%;
  overflow: hidden;
  font-family: var(--font-mono);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kk {
  opacity: 0.85;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.selbox {
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: var(--muted);
}
.selbox .nm {
  margin-top: 2px;
  font: 500 0.9375rem/1.3 var(--font-mono);
  overflow-wrap: anywhere;
}
.selbox .k {
  margin-top: 2px;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}
</style>

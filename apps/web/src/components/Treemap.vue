<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { esc, hideTip, showTip } from "../lib/ui";
import { fmt, type Kind } from "../lib/report";
import { squarify } from "../lib/squarify";

export interface Block {
  id: string;
  /** The full name, always in the DOM so search and screen readers find it. */
  name: string;
  /** What the block shows when it has room. */
  label: string;
  value: number;
  group: Kind | "harness";
  dead?: boolean;
}

/**
  The map: one block per loaded thing, its area its tokens. Blocks group by kind, never-used ones cluster at the end of
  their kind, and both levels are squarified. A block too small to label keeps its name as hidden text and stays a button.
*/
const props = withDefaults(
  defineProps<{ blocks: Block[]; selected?: string; unit?: string; interactive?: boolean }>(),
  { unit: "tokens a session", interactive: true },
);
const emit = defineEmits<{ select: [id: string] }>();

const el = ref<HTMLElement>();
const size = ref({ w: 0, h: 0 });
let ro: ResizeObserver | undefined;
onMounted(() => {
  const measure = () => {
    const r = el.value!.getBoundingClientRect();
    size.value = { w: r.width, h: r.height };
  };
  measure();
  ro = new ResizeObserver(measure);
  ro.observe(el.value!);
});
onBeforeUnmount(() => ro?.disconnect());

const GAP = 3;
/** Groups sit this much further apart than blocks inside one. */
const GROUP = 4;
const ORDER = ["harness", "mcp", "instr", "skill", "agent"] as const;

/** A narrow kind stacks its blocks as full-width rows, so each name gets the whole width. */
function strips<T extends { value: number }>(
  items: T[],
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const total = items.reduce((n, i) => n + i.value, 0);
  let top = y;
  return items.map((item) => {
    const ih = (item.value / total) * h;
    const r = { item, x, y: top, w, h: ih };
    top += ih;
    return r;
  });
}

const rects = computed(() => {
  // Before the first measure, lay out at a nominal size so the names are in the DOM from the first render.
  const W = size.value.w || 960;
  const H = size.value.h || 480;
  const total = props.blocks.reduce((n, b) => n + b.value, 0);
  if (!total) return [];
  // A floor of about 8×8px keeps every block clickable, however few tokens it adds.
  const floor = (total * 64) / (W * H);
  const leaf = (b: Block) => ({ b, value: Math.max(b.value, floor) });
  // Inside a kind, the used blocks come first, largest first, and the never-used ones follow, so they cluster at its end.
  const groups = ORDER.map((g) => {
    const mine = props.blocks
      .filter((b) => b.group === g && b.value > 0)
      .map(leaf)
      .sort((a, b) => Number(!!a.b.dead) - Number(!!b.b.dead) || b.value - a.value);
    return { items: mine, value: mine.reduce((n, x) => n + x.value, 0) };
  });
  const out: { b: Block; x: number; y: number; w: number; h: number; mode: "" | "s" | "t" }[] = [];
  const pad = GAP / 2 + GROUP / 2;
  for (const g of squarify(groups, -pad, -pad, W + pad * 2, H + pad * 2)) {
    const gi = GROUP / 2;
    const [x, y, w, h] = [g.x + gi, g.y + gi, g.w - gi * 2, g.h - gi * 2];
    for (const r of w < 200 && h > w * 1.5
      ? strips(g.item.items, x, y, w, h)
      : squarify(g.item.items, x, y, w, h, true)) {
      const w = r.w - GAP;
      const h = r.h - GAP;
      out.push({
        b: r.item.b,
        x: r.x + GAP / 2,
        y: r.y + GAP / 2,
        w,
        h,
        mode: w >= 56 && h >= 50 ? "" : h >= 16 && w >= 64 ? "s" : "t",
      });
    }
  }
  return out;
});

const kindClass = (b: Block) => `k-${b.group === "harness" ? "h" : b.dead ? "dead" : b.group}`;
const tipFor = (e: MouseEvent, b: Block) =>
  showTip(e, `<b>${esc(b.name)}</b> · ${fmt(b.value)} ${props.unit}`);
</script>

<template>
  <div ref="el" class="tm" :data-sel="(selected && interactive) || undefined">
    <template v-for="r in rects" :key="r.b.id">
      <div
        v-if="r.b.group === 'harness' || !interactive"
        class="b"
        :class="[kindClass(r.b), r.mode]"
        :style="{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }"
        @mousemove="tipFor($event, r.b)"
        @mouseleave="hideTip"
      >
        <template v-if="r.mode !== 't'">
          <b>{{ r.b.label }}</b><span class="num">{{ fmt(r.b.value) }}</span>
        </template>
        <span v-if="r.mode === 't' || r.b.label !== r.b.name" class="sr">{{ r.b.name }}</span>
      </div>
      <button
        v-else
        type="button"
        class="b"
        :class="[kindClass(r.b), r.mode]"
        :style="{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }"
        :aria-label="`${r.b.name}, ${fmt(r.b.value)} ${unit}${r.b.dead ? ', never used' : ''}`"
        :aria-pressed="selected === r.b.id"
        @click="emit('select', r.b.id)"
        @mousemove="tipFor($event, r.b)"
        @mouseleave="hideTip"
      >
        <template v-if="r.mode !== 't'">
          <b>{{ r.b.label }}</b><span class="num">{{ fmt(r.b.value) }}</span>
        </template>
        <span v-if="r.mode === 't' || r.b.label !== r.b.name" class="sr">{{ r.b.name }}</span>
      </button>
    </template>
  </div>
</template>

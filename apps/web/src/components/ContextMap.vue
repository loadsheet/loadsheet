<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  type CItem,
  type Segment,
  HDOC,
  KVAR,
  VIEW,
  count,
  groupName,
  short,
  tok,
} from "../lib/context";
import { squarify } from "../lib/squarify";
import { esc, hideTip, showTip } from "../lib/ui";

/**
  The window's used part as a treemap: one box per segment, its items inside. The harness can't be trimmed, so it
  sits apart as a strip along the bottom; the rest share the space above in importance order.
*/
const view = inject(VIEW)!;
const st = view.st;
const el = ref<HTMLElement>();
const W = ref(0);
const H = ref(0);
let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver(([e]) => {
    W.value = Math.round(e!.contentRect.width);
    H.value = Math.round(e!.contentRect.height);
  });
  ro.observe(el.value!);
});
onBeforeUnmount(() => ro?.disconnect());

const G = 6;
const STRIP = 36;
const TOP = 22;
const MIN_AREA = 1800;
const RANK = ["skill", "pskill", "instructions", "mcp", "subagent"];

interface Tile {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cls: Record<string, boolean>;
  name?: string;
  sub?: string;
  /** A group tile's "Open table" button, in its corner or under its name. */
  open?: "corner" | "mid";
  tip: string;
  click?: () => void;
}
interface Box {
  seg: Segment;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: { label: string; num: string };
  tiles: Tile[];
}
type Node = { value: number; item?: CItem; rest?: CItem[]; name?: string; group?: string };

const harness = computed(() => view.ctx().segments.find((s) => s.id === "harness"));
const doc = computed(() => HDOC[view.harness()]);
const segTip = (s: Segment) => `${esc(s.label)} · <b>${tok(s.tokens)}</b><br>${s.sub}`;

function title(s: Segment, w: number) {
  const room = w - 26;
  const fits = (a: string, b: string) => a.length * 7.4 + b.length * 6.9 <= room;
  const L = s.label;
  const S = s.short ?? s.label;
  const T = tok(s.tokens);
  const T2 = `${short(s.tokens)} tok`;
  const pairs: [string, string][] = [
    [L, T],
    [L, T2],
    [S, T],
    [S, T2],
    [S, ""],
  ];
  const [label, num] = pairs.find(([a, b]) => fits(a, b)) ?? [S, ""];
  return { label, num };
}

function inner(s: Segment, w: number, h: number): Tile[] {
  const ih = h - TOP;
  const k = (w * ih) / s.tokens;
  let nodes: Node[] = s.items
    .filter((i) => i.tokens > 0)
    .map((i) => ({ value: i.tokens, item: i }));
  let side: Node[] = [];
  if (s.id === "skill") {
    const by = new Map<string, CItem[]>();
    for (const n of nodes) by.set(n.item!.group, [...(by.get(n.item!.group) ?? []), n.item!]);
    nodes = nodes.filter((n) => n.item!.group === "personal").sort((a, b) => b.value - a.value);
    side = [...by]
      .filter(([g]) => g !== "personal")
      .map(([g, rest]) => ({
        rest,
        group: g,
        name: groupName(g),
        value: rest.reduce((n, i) => n + i.tokens, 0),
      }))
      .sort((a, b) => b.value - a.value);
    if (!nodes.length) [nodes, side] = [side, []];
  } else {
    const small = nodes
      .filter((n, j) => !n.item!.project && (j >= 30 || n.value * k < MIN_AREA))
      .map((n) => n.item!);
    if (small.length > 1) {
      nodes = nodes.filter((n) => !small.includes(n.item!));
      nodes.push({
        rest: small,
        name: `+${small.length} more`,
        value: small.reduce((n, i) => n + i.tokens, 0),
      });
    }
  }
  const sv = side.reduce((n, i) => n + i.value, 0);
  const nv = nodes.reduce((n, i) => n + i.value, 0);
  const sw = side.length ? Math.round((w * sv) / (sv + nv)) : 0;
  const cells = [
    ...squarify(nodes, 0, TOP, w - sw, ih, true),
    ...squarify(side, w - sw, TOP, sw, ih, true),
  ];
  return cells.map((c, j): Tile => {
    const n = c.item;
    const box = {
      x: c.x + 1,
      y: c.y + 1,
      w: Math.max(c.w - 2, 1),
      h: Math.max(c.h - 2, 1),
    };
    const tiny = c.w < 12 || c.h < 12;
    if (n.rest) {
      const many = s.id === "skill";
      const tokens = tok(n.value);
      const label = many ? `${tokens} · ${count(n.rest.length, s.id)}` : tokens;
      const corner = c.w >= 300 && c.h >= 58;
      const center = !corner && c.w >= 96 && c.h >= 30;
      const top5 = n.rest
        .slice(0, 5)
        .map((r) => `${esc(r.name)} · ${tok(r.tokens)}`)
        .join("<br>");
      return {
        key: `g:${n.name}`,
        ...box,
        cls: { group: true, "more-tile": !many, tiny, stack: center },
        name: corner || (center && c.h >= 52) ? n.name : undefined,
        sub: corner || (center && c.h >= 74) ? (corner || c.w >= 150 ? label : tokens) : undefined,
        open: corner ? "corner" : center ? "mid" : undefined,
        tip: `<b>${esc(n.name!)}</b> · ${count(n.rest.length, s.id)} · ${tokens}<br><span class="dim">${top5}${n.rest.length > 5 ? "<br>…" : ""}</span>`,
        click: () => view.reveal(s.id, many ? { group: n.group } : { more: true }),
      };
    }
    const i = n.item!;
    const jumps = s.id === "skill" || s.id === "pskill";
    return {
      key: `i:${i.id}:${j}`,
      ...box,
      cls: { tiny, proj: i.project, jumps },
      name: c.w >= 46 && c.h > 20 ? i.name : undefined,
      sub:
        c.w >= 46 && c.h > 36
          ? c.w < 72
            ? short(i.tokens)
            : c.w < 110
              ? `${short(i.tokens)} tok`
              : tok(i.tokens)
          : undefined,
      tip: `<b>${esc(i.name)}</b> · ${tok(i.tokens)}${i.project ? "<br>from this project" : ""}`,
      click: jumps ? () => view.reveal(s.id, { group: i.group, item: i.id }) : undefined,
    };
  });
}

const boxes = computed<Box[]>(() => {
  if (!W.value || !H.value) return [];
  const segs = view
    .ctx()
    .segments.filter((s) => s.id !== "harness")
    .sort((a, b) => RANK.indexOf(a.id) - RANK.indexOf(b.id));
  const all = segs.reduce((n, s) => n + s.tokens, 0);
  const floor = all * 0.07;
  const h0 = H.value - (harness.value ? STRIP : 0);
  const cells = squarify(
    segs.map((seg) => ({ seg, value: Math.max(seg.tokens, floor) })),
    0,
    0,
    W.value,
    h0,
    true,
  );
  const out: Box[] = [];
  for (const r of cells) {
    const s = r.item.seg;
    const x = r.x + G / 2;
    const y = r.y + G / 2;
    const w = r.w - G;
    const h = r.h - G;
    if (w < 3 || h < 3) continue;
    const titled = h > 46 && w > 60;
    const head = titled && h > 64 && w > 90;
    if (head) {
      out.push({ seg: s, x, y, w, h, title: title(s, w), tiles: inner(s, w, h) });
      continue;
    }
    const solo: Tile = {
      key: "solo",
      x: 0,
      y: titled ? TOP : 0,
      w,
      h: titled ? h - TOP : h,
      cls: { solo: true },
      tip: segTip(s),
    };
    if (!titled && w > 40 && h > 34) {
      solo.name = w < 110 && s.short ? s.short : s.label;
      solo.sub = tok(s.tokens);
    }
    out.push({ seg: s, x, y, w, h, title: titled ? title(s, w) : undefined, tiles: [solo] });
  }
  return out;
});

/** Names break after - : / _ . so a long skill name wraps at its parts. */
const breakable = (n: string) => esc(n).replace(/([-:/_.])/g, "$1<wbr>");
const pick = (s: Segment) => (st.sel = st.sel === s.id ? null : s.id);
const tipOn = (e: MouseEvent, html: string) => showTip(e, html);
function go(e: MouseEvent, t: Tile) {
  if (!t.click) return;
  e.stopPropagation();
  hideTip();
  t.click();
}
const harnessTip = computed(() => {
  const s = harness.value;
  if (!s) return "";
  const name = esc(s.label);
  return `${name} · <b>${tok(s.tokens)}</b><br>${doc.value?.what ?? s.sub}<br><span class="dim">ships with ${name}, you can’t trim it</span>`;
});

/** A tile too short for its token line drops it rather than clip the name. */
watch(
  boxes,
  () => {
    for (const t of el.value?.querySelectorAll<HTMLElement>(".tile:not(.group)") ?? []) {
      const tt = t.querySelector<HTMLElement>(".tt");
      if (!tt) continue;
      tt.hidden = false;
      if (t.scrollHeight > t.clientHeight + 1) tt.hidden = true;
    }
  },
  { flush: "post" },
);
</script>

<template>
  <div ref="el" class="cmap" role="img" :aria-label="`Map of what loads before you type`">
    <div
      v-for="b in boxes"
      :key="b.seg.id"
      class="mseg"
      :class="{ on: st.sel === b.seg.id, dim: st.sel && st.sel !== b.seg.id }"
      :style="{
        left: `${b.x}px`,
        top: `${b.y}px`,
        width: `${b.w}px`,
        height: `${b.h}px`,
        '--k': KVAR[b.seg.id],
      }"
      @click="pick(b.seg)"
    >
      <div
        v-if="b.title"
        class="mh"
        @mouseenter="tipOn($event, segTip(b.seg))"
        @mousemove="tipOn($event, segTip(b.seg))"
        @mouseleave="hideTip"
      >
        <span class="sw" />{{ b.title.label
        }}<span v-if="b.title.num" class="num">{{ b.title.num }}</span>
      </div>
      <div
        v-for="t in b.tiles"
        :key="t.key"
        class="tile"
        :class="t.cls"
        :style="{ left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px` }"
        @mouseenter="tipOn($event, t.tip)"
        @mousemove="tipOn($event, t.tip)"
        @mouseleave="hideTip"
        @click="go($event, t)"
      >
        <template v-if="t.cls.solo">
          <span v-if="t.name" class="tn"><span v-if="b.w >= 80" class="sw" />{{ t.name }}</span>
          <span v-if="t.sub" class="tt num">{{ t.sub }}</span>
        </template>
        <template v-else-if="t.cls.group">
          <span
            v-if="t.name"
            class="tn"
            :style="t.open === 'corner' ? { paddingRight: '96px' } : undefined"
            >{{ t.name }}</span
          >
          <span v-if="t.sub" class="tt num">{{ t.sub }}</span>
          <button
            v-if="t.open"
            type="button"
            class="open-t"
            :class="{ mid: t.open === 'mid' }"
            :aria-label="`Open ${t.name ?? 'this group'} in the table`"
            @click.stop="go($event, t)"
          >
            Open table
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2 5h6M5.5 2.5 8 5 5.5 7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </template>
        <template v-else>
          <span v-if="t.name" class="tn brk" v-html="breakable(t.name)" />
          <span v-if="t.sub" class="tt num">{{ t.sub }}</span>
        </template>
      </div>
    </div>
    <div
      v-if="harness && W"
      class="mseg fixed"
      :class="{ on: st.sel === 'harness', dim: st.sel && st.sel !== 'harness' }"
      :style="{
        left: `${G / 2}px`,
        top: `${H - STRIP + G / 2}px`,
        width: `${W - G}px`,
        height: `${STRIP - G}px`,
        '--k': KVAR.harness,
      }"
      @click="pick(harness)"
      @mouseenter="tipOn($event, harnessTip)"
      @mousemove="tipOn($event, harnessTip)"
      @mouseleave="hideTip"
    >
      <span class="sw" /><b>{{ harness.label }}</b><span class="num">{{ tok(harness.tokens) }}</span
      ><span class="fxs">{{ harness.sub }}, fixed</span>
      <a v-if="doc" class="doc" :href="doc.url" target="_blank" rel="noopener" @click.stop
        >{{ doc.label }} ↗</a
      >
    </div>
  </div>
</template>

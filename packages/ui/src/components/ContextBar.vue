<script setup lang="ts">
import { computed, inject } from "vue";
import { type Segment, KVAR, VIEW, share, short, ticks, tok } from "../lib/context";
import { esc, hideTip, showTip } from "../lib/ui";

/** The whole context window as one bar, each segment at its true share of it, and a scale beneath. */
const view = inject(VIEW)!;
const st = view.st;
const bars = computed(() => {
  const { segments, window } = view.ctx();
  let x = 0;
  return segments.map((s) => {
    const left = (x / window) * 100;
    x += s.tokens;
    return { s, left, width: (s.tokens / window) * 100 };
  });
});
const scale = computed(() => {
  const win = view.ctx().window;
  return ticks(win).map((v) => ({ v, left: (v / win) * 100, end: v === win }));
});
const tip = (s: Segment) => {
  const win = view.ctx().window;
  const pj = s.items.filter((i) => i.project).reduce((n, i) => n + i.tokens, 0);
  return `${esc(s.label)} · <b>${tok(s.tokens)}</b><br>${share(s.tokens, win)} of the window${pj ? `<br>${tok(pj)} from this project` : ""}`;
};
function pick(s: Segment) {
  st.sel = st.sel === s.id ? null : s.id;
  if (st.sel) st.open.add(s.id);
}
</script>

<template>
  <div>
    <div class="cbar">
      <button
        v-for="b in bars"
        :key="b.s.id"
        type="button"
        class="s"
        :class="{ on: st.sel === b.s.id, dim: st.sel && st.sel !== b.s.id }"
        :style="{ left: `${b.left}%`, width: `${b.width}%`, background: KVAR[b.s.id] }"
        :aria-label="`${b.s.label}, ${tok(b.s.tokens)}`"
        :aria-pressed="st.sel === b.s.id"
        @click="pick(b.s)"
        @mouseenter="showTip($event, tip(b.s))"
        @mousemove="showTip($event, tip(b.s))"
        @mouseleave="hideTip"
      />
    </div>
    <div class="cscale num" aria-hidden="true">
      <span v-for="t in scale" :key="t.v" :class="{ end: t.end }" :style="{ left: `${t.left}%` }">{{
        short(t.v)
      }}</span>
    </div>
  </div>
</template>

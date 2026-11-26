<script setup lang="ts">
import { computed, inject } from "vue";
import { type Segment, KVAR, VIEW, share, tok } from "../lib/context";
import { esc, hideTip, showTip } from "../lib/ui";

/** The whole context window as one bar, each segment at its true share of it, and a key beneath that names each colour. */
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
const free = computed(() => view.ctx().window - view.ctx().total);
const name = (s: Segment) => (s.id === "harness" ? `${s.label}, built-in` : s.label);
const tip = (s: Segment) => {
  const win = view.ctx().window;
  const pj = s.items.filter((i) => i.project).reduce((n, i) => n + i.tokens, 0);
  return `${esc(s.label)} · <b>${tok(s.tokens)}</b><br>${share(s.tokens, win)} of the window${pj ? `<br>${tok(pj)} from this project` : ""}<br><span class="dim">${s.about}</span>`;
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
    <ul class="ckey" aria-label="Key">
      <li v-for="b in bars" :key="b.s.id">
        <span class="sw" :style="{ '--k': KVAR[b.s.id] }" />{{ name(b.s)
        }}<small class="num">{{ tok(b.s.tokens) }}</small>
      </li>
      <li class="free">
        <span class="sw free" />Free for your chat<small class="num">{{ tok(free) }}</small>
      </li>
    </ul>
  </div>
</template>

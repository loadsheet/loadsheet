<script setup lang="ts">
import { computed, inject, nextTick, watch } from "vue";
import {
  type CItem,
  type Segment,
  HDOC,
  KVAR,
  VIEW,
  firstSentence,
  groupName,
  groupNote,
  share,
  short,
  sourceFile,
  tok,
} from "../lib/context";
import { harnessName } from "../lib/report";
import { esc, hideTip, showTip } from "../lib/ui";

/**
  The same segments as rows. Skills open into where they come from; every list shows its top five and folds the
  rest behind one full-width row. An item with a description shows its first sentence, and the whole of it on click.
*/
/** `free: false` leaves out the last row, the window left free, where there is no session to fill it (a pack). */
const props = withDefaults(defineProps<{ free?: boolean }>(), { free: true });
const view = inject(VIEW)!;
const st = view.st;
const TOP = 5;

type Row =
  | { t: "grp"; key: string; s: Segment; open: boolean; canOpen: boolean; n: number }
  | {
      t: "src";
      key: string;
      s: Segment;
      name: string;
      note: string;
      tokens: number;
      n: number;
      open: boolean;
      off: boolean;
    }
  | { t: "it"; key: string; s: Segment; i: CItem; lvl: number; desc?: string; open: boolean }
  | { t: "more"; key: string; list: string; lvl: number; n: number; tokens: number }
  | { t: "fewer"; key: string; list: string; lvl: number }
  | { t: "free"; key: string; tokens: number | undefined }
  | { t: "none"; key: string };

const rows = computed<Row[]>(() => {
  const { segments } = view.ctx();
  const q = st.q.trim().toLowerCase();
  const hit = (i: CItem) => !q || i.name.toLowerCase().includes(q);
  const out: Row[] = [];
  const list = (s: Segment, items: CItem[], key: string, lvl: number) => {
    const full = st.all || !!q || st.more.has(key) || items.length <= TOP + 1;
    const shown = full ? items : items.slice(0, TOP);
    const flashed = !full && items.find((i) => st.flash === `item:${s.id}:${i.id}`);
    if (flashed && !shown.includes(flashed)) shown.push(flashed);
    for (const i of shown) {
      const k = `${s.id}:${i.id}`;
      const desc = i.description;
      out.push({ t: "it", key: `it:${k}`, s, i, lvl, desc, open: !!desc && st.desc.has(k) });
    }
    if (!full) {
      const rest = items.filter((i) => !shown.includes(i));
      out.push({
        t: "more",
        key: `more:${key}`,
        list: key,
        lvl,
        n: rest.length,
        tokens: rest.reduce((n, i) => n + i.tokens, 0),
      });
    } else if (st.more.has(key) && !st.all && !q && items.length > TOP + 1)
      out.push({ t: "fewer", key: `fewer:${key}`, list: key, lvl });
  };
  for (const s of segments) {
    const loaded = s.items.filter((i) => i.tokens > 0);
    const off = s.items.filter((i) => i.tokens === 0);
    const canOpen = s.items.length > 0;
    const open = canOpen && (st.all || !!q || st.open.has(s.id));
    const n = q ? s.items.filter(hit).length : loaded.length;
    if (q && !n) continue;
    out.push({ t: "grp", key: `grp:${s.id}`, s, open, canOpen, n });
    if (!open) continue;
    if (s.id !== "skill") {
      list(s, s.items.filter(hit), s.id, 1);
      continue;
    }
    const by = new Map<string, CItem[]>();
    for (const i of loaded) by.set(i.group, [...(by.get(i.group) ?? []), i]);
    const groups = [...by]
      .map(([g, items]) => ({
        g,
        items,
        off: false,
        tokens: items.reduce((n, i) => n + i.tokens, 0),
      }))
      .sort((a, b) => b.tokens - a.tokens);
    if (off.length) groups.push({ g: "off", items: off, off: true, tokens: 0 });
    for (const g of groups) {
      const items = g.items.filter(hit);
      if (q && !items.length) continue;
      const key = `${s.id}:${g.g}`;
      const gopen = st.all || !!q || st.src.has(key);
      out.push({
        t: "src",
        key: `src:${key}`,
        s,
        name: g.off ? "Installed, not loaded" : groupName(g.g),
        note: g.off
          ? "slash-only skills, they cost nothing until you call them"
          : groupNote(g.g, g.items),
        tokens: g.tokens,
        n: items.length,
        open: gopen,
        off: g.off,
      });
      if (gopen) list(s, items, key, 2);
    }
  }
  if (q && !out.length) out.push({ t: "none", key: "none" });
  else if (!q && props.free) out.push({ t: "free", key: "free", tokens: view.ctx().free });
  return out;
});

const max = computed(() => Math.max(1, ...view.ctx().segments.map((s) => s.tokens)));
const barWidth = (v: number) => `${Math.max((v / max.value) * 100, v ? 0.4 : 0)}%`;
const win = computed(() => view.ctx().window);
const doc = computed(() => HDOC[view.harness()]);

function toggleGrp(s: Segment, canOpen: boolean) {
  if (!canOpen) {
    st.sel = st.sel === s.id ? null : s.id;
    return;
  }
  st.all = false;
  if (st.open.has(s.id)) st.open.delete(s.id);
  else st.open.add(s.id);
  st.sel = st.open.has(s.id) ? s.id : null;
}
function toggle(set: Set<string>, key: string) {
  st.all = false;
  st.flash = null;
  if (set.has(key)) set.delete(key);
  else set.add(key);
}
function onKey(e: KeyboardEvent, go: () => void) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  go();
}
const why = (s: Segment, i: CItem) => {
  const file = sourceFile(i);
  const what = s.id === "subagent" ? "hand work to this agent" : "use this skill";
  return `${esc(harnessName(view.harness()))} puts this description in every session so the agent knows when to ${what}.${file ? `<br><span class="dim">From the frontmatter of ${esc(file)}</span>` : ""}`;
};
function helpFocus(e: FocusEvent, html: string) {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  showTip({ clientX: r.right, clientY: r.bottom } as MouseEvent, html);
}

/** The map sent you to a row: bring it into view. */
watch(
  () => st.flash,
  async (f) => {
    if (!f) return;
    await nextTick();
    document.querySelector(".ctable tr.flash")?.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  },
  { immediate: true, flush: "post" },
);
</script>

<template>
  <div class="ccard">
    <table class="ctable">
      <thead>
        <tr>
          <th>What loads</th>
          <th class="r">Tokens</th>
          <th class="c-bar"><span class="sr">Share</span></th>
          <th class="r">Of window</th>
          <th class="r c-n">Count</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="r in rows" :key="r.key">
          <tr
            v-if="r.t === 'grp'"
            class="grp"
            :class="{ open: r.open, on: st.sel === r.s.id }"
            tabindex="0"
            :aria-expanded="r.canOpen ? r.open : undefined"
            @click="toggleGrp(r.s, r.canOpen)"
            @keydown="onKey($event, () => toggleGrp(r.s, r.canOpen))"
          >
            <td>
              <span class="car"
                ><svg
                  v-if="r.canOpen"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                >
                  <path
                    d="M4.5 2.5 8 6 4.5 9.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  /></svg></span
              ><span class="sw" :style="{ background: KVAR[r.s.id] }" />{{ r.s.label }}
              <template v-if="r.s.id === 'harness'"
                ><span class="note">{{ r.s.sub }}</span
                ><a
                  v-if="doc"
                  class="doc"
                  :href="doc.url"
                  target="_blank"
                  rel="noopener"
                  @click.stop
                  >{{ doc.label }} ↗</a
                ></template
              >
            </td>
            <td class="r num">{{ short(r.s.tokens) }}</td>
            <td class="c-bar">
              <div class="mini">
                <i :style="{ width: barWidth(r.s.tokens), background: KVAR[r.s.id] }" />
              </div>
            </td>
            <td class="r num muted">{{ share(r.s.tokens, win) }}</td>
            <td class="r num muted c-n">{{ r.canOpen ? r.n : "" }}</td>
          </tr>
          <tr
            v-else-if="r.t === 'src'"
            class="src"
            :class="{ open: r.open, off: r.off, flash: st.flash === r.key.slice(4) }"
            tabindex="0"
            :aria-expanded="r.open"
            @click="toggle(st.src, r.key.slice(4))"
            @keydown="onKey($event, () => toggle(st.src, r.key.slice(4)))"
          >
            <td>
              <span class="car"
                ><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M4.5 2.5 8 6 4.5 9.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  /></svg></span
              >{{ r.name }}<span v-if="r.note" class="note">{{ r.note }}</span>
            </td>
            <td class="r num">{{ r.off ? "0" : short(r.tokens) }}</td>
            <td class="c-bar">
              <div v-if="!r.off" class="mini">
                <i :style="{ width: barWidth(r.tokens), background: KVAR[r.s.id] }" />
              </div>
            </td>
            <td class="r num muted">{{ r.off ? "" : share(r.tokens, win) }}</td>
            <td class="r num muted c-n">{{ r.n }}</td>
          </tr>
          <tr
            v-else-if="r.t === 'it'"
            class="it"
            :class="[
              `l${r.lvl}`,
              {
                off: r.i.tokens === 0,
                'has-d': r.desc,
                'd-open': r.open,
                flash: st.flash === `item:${r.s.id}:${r.i.id}`,
              },
            ]"
            :tabindex="r.desc ? 0 : undefined"
            :aria-expanded="r.desc ? r.open : undefined"
            @click="r.desc && toggle(st.desc, `${r.s.id}:${r.i.id}`)"
            @keydown="r.desc && onKey($event, () => toggle(st.desc, `${r.s.id}:${r.i.id}`))"
          >
            <td>
              <span v-if="r.desc" class="car ic"
                ><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M4.5 2.5 8 6 4.5 9.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  /></svg></span
              ><span class="nm">{{ r.i.name }}</span
              ><span
                v-if="r.i.project && r.s.id !== 'pskill'"
                class="tag"
                :style="{ background: KVAR[r.s.id] }"
                >project</span
              ><span v-if="r.i.tokens === 0" class="note">only when you type /{{ r.i.name }}</span>
              <span v-if="r.desc && r.open" class="dfull"
                >{{ r.desc
                }}<button
                  type="button"
                  class="dhelp"
                  aria-label="What is this text?"
                  @click.stop
                  @mouseenter="showTip($event, why(r.s, r.i))"
                  @mousemove="showTip($event, why(r.s, r.i))"
                  @mouseleave="hideTip"
                  @focus="helpFocus($event, why(r.s, r.i))"
                  @blur="hideTip"
                >
                  ?
                </button></span
              >
              <span v-else-if="r.desc" class="desc">{{ firstSentence(r.desc) }}</span>
            </td>
            <td class="r num">{{ r.i.tokens === 0 ? "0" : short(r.i.tokens) }}</td>
            <td class="c-bar">
              <div class="mini">
                <i :style="{ width: barWidth(r.i.tokens), background: KVAR[r.s.id] }" />
              </div>
            </td>
            <td class="r num faint">{{ r.i.tokens === 0 ? "" : share(r.i.tokens, win) }}</td>
            <td class="c-n" />
          </tr>
          <tr v-else-if="r.t === 'more' || r.t === 'fewer'" class="more-row" :class="`l${r.lvl}`">
            <td colspan="5">
              <button
                type="button"
                class="more-b"
                @click="
                  r.t === 'more' ? st.more.add(r.list) : st.more.delete(r.list);
                  st.flash = null;
                "
              >
                <span class="mi" :class="{ up: r.t === 'fewer' }"
                  ><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M2.5 4.5 6 8l3.5-3.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    /></svg
                ></span>
                <template v-if="r.t === 'more'"
                  >Show {{ r.n }} more<span class="mv num">{{ tok(r.tokens) }}</span></template
                >
                <template v-else>Show fewer</template>
              </button>
            </td>
          </tr>
          <tr v-else-if="r.t === 'free'">
            <td>
              <span class="car" /><span class="sw free" />{{
                r.tokens === undefined ? "Free for your chat is unknown" : "Free"
              }}
            </td>
            <td class="r num">{{ r.tokens === undefined ? "—" : short(r.tokens) }}</td>
            <td class="c-bar" />
            <td class="r num muted">{{ r.tokens === undefined ? "—" : share(r.tokens, win) }}</td>
            <td class="c-n" />
          </tr>
          <tr v-else>
            <td colspan="5" class="muted empty">Nothing loaded matches “{{ st.q }}”.</td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

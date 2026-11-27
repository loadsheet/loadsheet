<script setup lang="ts">
import { computed, nextTick, reactive, useId } from "vue";
import CopyIcon from "./CopyIcon.vue";
import { copied, esc, hideTip, tipUnder } from "../lib/ui";
import {
  andList,
  type McpCheckDiagnostic,
  mcpAnchor,
  mcpDocs,
  mcpHash,
  type McpProblem,
  problemTitle,
  sharedFix,
  sharedHead,
} from "../lib/mcp";

/**
  One problem: its title and Diagnostic Code, the clients it hits (unfolding to what each one does), then each fix once
  above the tools that take it, as one wrapped line of names. Tools that differ only in a quoted value (`sharedFix()`)
  show the fix with "…" and their own fix on hover or through a disclosure; a sentence every fix starts with (`sharedHead()`) shows once above
  all the tools, and what some add shows above those. `target` is the anchor a shared link points at inside it, and
  `link` asks the view to copy the link to an anchor. A fix every one of the server's `tools` takes says so instead of
  naming them, unless each tool has its own value.
*/
const props = defineProps<{
  problem: McpProblem;
  labels: Record<string, string>;
  tools?: number;
  target?: string;
}>();
const emit = defineEmits<{ link: [anchor: string] }>();

// Past this many tools, all but the first FIRST fold away.
const FOLD = 40;
const FIRST = 30;

const md = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const hits = computed(() => [...props.problem.clients.entries()]);
const label = (id: string) => props.labels[id] ?? id;

type Section = { fix?: string; rows: McpCheckDiagnostic[]; tip?: boolean };
const items = computed(() => props.problem.items);
const same = computed(() => new Set(items.value.map((d) => d.fix)).size === 1);
function groupFixes(rows: McpCheckDiagnostic[], fixes: string[], skipEmpty = false) {
  const groups = new Map<string, McpCheckDiagnostic[]>();
  rows.forEach((row, index) => {
    const fix = fixes[index]!;
    if (skipEmpty && !fix) return;
    const group = groups.get(fix);
    if (group) group.push(row);
    else groups.set(fix, [row]);
  });
  return groups;
}
/**
  The tools in sections, each under the fix they share. With no fix shared by several tools, `fix` is undefined and
  each tool shows its own beside it.
*/
const sections = computed<Section[]>(() => {
  const all = items.value;
  if (same.value) return [{ fix: all[0]!.fix, rows: all }];
  const fixes = all.map((d) => d.fix);
  const s = sharedFix(fixes);
  if (s) return [{ fix: s.fix, rows: all, tip: true }];
  const h = sharedHead(fixes);
  if (h) {
    const more = groupFixes(all, h.rest, true);
    return [{ fix: h.head, rows: all }, ...[...more].map(([fix, rows]) => ({ fix, rows }))];
  }
  const byFix = groupFixes(all, fixes);
  if (byFix.size < all.length) return [...byFix].map(([fix, rows]) => ({ fix, rows }));
  return [{ rows: all }];
});
// A problem about the server alone, with one fix, has no tools to list.
const listed = computed(() => !(same.value && items.value.every((d) => d.tool === undefined)));

const own = computed(() =>
  items.value.length === 1 ? mcpAnchor(items.value[0]!) : props.problem.code,
);
const everyTool = (sec: Section) =>
  !!sec.fix &&
  !sec.tip &&
  (props.tools ?? 0) > 1 &&
  sec.rows.every((row) => row.tool !== undefined) &&
  new Set(sec.rows.map((row) => row.tool)).size === props.tools;
const selected = (row: McpCheckDiagnostic) => props.target === mcpAnchor(row);
const lists = computed(() => {
  const groups = sections.value.map((sec) => ({ ...sec, summary: everyTool(sec) }));
  if (!props.target) return groups.map((sec) => (sec.summary ? { ...sec, rows: [] } : sec));
  const named = new Set(groups.filter((sec) => !sec.summary).flatMap((sec) => sec.rows));
  return groups.map((sec) =>
    sec.summary
      ? { ...sec, rows: sec.rows.filter((row) => selected(row) && !named.has(row)) }
      : sec,
  );
});
// A tool can sit under the shared sentence and under what its own fix adds; its id goes on the first that names it.
const firstIn = computed(() => {
  const at = new Map<McpCheckDiagnostic, number>();
  lists.value.forEach((sec, index) => sec.rows.forEach((row) => at.has(row) || at.set(row, index)));
  return at;
});
const rowId = (d: McpCheckDiagnostic, n: number) =>
  d.tool === undefined || firstIn.value.get(d) !== n ? undefined : mcpAnchor(d);
const on = (d: McpCheckDiagnostic, n: number) =>
  selected(d) && firstIn.value.get(d) === n ? "" : undefined;
const unfolded = reactive(new Set<number>());
const exact = reactive(new Set<McpCheckDiagnostic>());
const prefix = useId();
const exactId = (row: McpCheckDiagnostic) => `${prefix}-fix-${encodeURIComponent(mcpAnchor(row))}`;
function toggleFix(row: McpCheckDiagnostic) {
  if (!exact.delete(row)) exact.add(row);
}
/** A section's tools on screen: past FOLD, the first FIRST until unfolded or a shared link points past them. */
const shown = (sec: Section, n: number) =>
  sec.rows.length <= FOLD || unfolded.has(n) || sec.rows.slice(FIRST).some(selected)
    ? sec.rows
    : sec.rows.slice(0, FIRST);
async function showAll(index: number, event: MouseEvent) {
  const list = (event.currentTarget as HTMLButtonElement).closest("ul");
  unfolded.add(index);
  await nextTick();
  const first = list?.querySelector<HTMLElement>(`:scope > li:nth-child(${FIRST + 1})`);
  (first?.querySelector<HTMLElement>("a, button") ?? first)?.focus();
}
</script>

<template>
  <li class="mc-prob" :class="`s-${problem.severity}`" :data-on="target ? '' : undefined">
    <div class="mc-pt">
      <i class="mc-dot" :class="`s-${problem.severity}`" />
      <b>{{ problemTitle(problem.code) }}</b>
      <a class="mc-code" :href="mcpDocs(problem.code)" target="_blank" rel="noopener">{{
        problem.code
      }}</a>
      <button
        type="button"
        data-slot="button"
        data-size="sm"
        class="cp"
        :data-done="copied.key === `link:${own}` || undefined"
        :aria-label="`Copy a link to ${problem.code}`"
        @click="emit('link', own)"
      >
        <CopyIcon link :done="copied.key === `link:${own}`" />
      </button>
    </div>
    <details v-if="hits.length" class="mc-why">
      <summary>{{ andList(hits.map(([id]) => label(id))) }}</summary>
      <ul>
        <li v-for="[id, f] in hits" :key="id">
          <b>{{ label(id) }}</b>: <span v-html="md(f.message)" />
          <template v-if="f.source?.url">
            <a :href="f.source.url" target="_blank" rel="noopener">Source</a>
          </template>
        </li>
      </ul>
    </details>
    <p v-else class="mc-who">The MCP spec, before any client</p>
    <template v-for="(sec, n) in lists" :key="n">
      <p v-if="sec.fix" class="mc-fix" v-html="md(sec.fix)" />
      <p v-if="listed && sec.summary" class="mc-tools">All {{ tools }} tools</p>
      <ul v-if="listed && sec.rows.length" :class="sec.fix ? 'mc-tools' : 'mc-per'">
        <li
          v-for="d in shown(sec, n)"
          :id="rowId(d, n)"
          :key="mcpAnchor(d)"
          :data-on="on(d, n)"
          :tabindex="d.tool === undefined ? -1 : undefined"
        >
          <a
            v-if="d.tool !== undefined"
            class="mc-tn"
            :href="mcpHash(mcpAnchor(d))"
            :aria-describedby="sec.tip ? exactId(d) : undefined"
            @click.prevent="emit('link', mcpAnchor(d))"
            @mouseenter="sec.tip && tipUnder($event, md(d.fix))"
            @mouseleave="hideTip"
            >{{ d.tool }}</a
          ><span v-else class="mc-tn">server</span>
          <template v-if="sec.tip">
            <button
              type="button"
              class="mc-link mc-exact-toggle"
              :aria-label="`Fix for ${d.tool ?? 'the server'}`"
              :aria-expanded="exact.has(d)"
              :aria-controls="exactId(d)"
              @click="toggleFix(d)"
            >
              Fix
            </button>
            <p v-show="exact.has(d)" :id="exactId(d)" class="mc-exact" v-html="md(d.fix)" />
          </template>
          <span v-if="!sec.fix" v-html="md(d.fix)" />
        </li>
        <li v-if="shown(sec, n).length < sec.rows.length">
          <button type="button" class="mc-link" @click="showAll(n, $event)">
            {{ sec.rows.length - FIRST }} more
          </button>
        </li>
      </ul>
    </template>
  </li>
</template>

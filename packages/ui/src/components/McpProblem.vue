<script setup lang="ts">
import { computed, reactive } from "vue";
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
  show the fix with "…" and their own fix on hover; a sentence every fix starts with (`sharedHead()`) shows once above
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
    const more = Map.groupBy(
      all.filter((_, i) => h.rest[i]),
      (d) => h.rest[all.indexOf(d)]!,
    );
    return [{ fix: h.head, rows: all }, ...[...more].map(([fix, rows]) => ({ fix, rows }))];
  }
  const byFix = Map.groupBy(all, (d) => d.fix);
  if (byFix.size < all.length) return [...byFix].map(([fix, rows]) => ({ fix, rows }));
  return [{ rows: all }];
});
// A problem about the server alone, with one fix, has no tools to list.
const listed = computed(() => !(same.value && items.value.every((d) => d.tool === undefined)));

const own = computed(() =>
  items.value.length === 1 ? mcpAnchor(items.value[0]!) : props.problem.code,
);
const everyTool = (sec: Section) =>
  !!sec.fix && !sec.tip && (props.tools ?? 0) > 1 && sec.rows.length === props.tools;
// A tool can sit under the shared sentence and under what its own fix adds; its id goes on the first that names it.
const firstIn = computed(() => {
  const at = new Map<McpCheckDiagnostic, number>();
  sections.value.forEach(
    (sec, n) => everyTool(sec) || sec.rows.forEach((d) => at.has(d) || at.set(d, n)),
  );
  return at;
});
const rowId = (d: McpCheckDiagnostic, n: number) =>
  d.tool === undefined || firstIn.value.get(d) !== n ? undefined : mcpAnchor(d);
const on = (d: McpCheckDiagnostic) => (props.target === mcpAnchor(d) ? "" : undefined);
const unfolded = reactive(new Set<number>());
/** A section's tools on screen: past FOLD, the first FIRST until unfolded or a shared link points past them. */
const shown = (sec: Section, n: number) =>
  sec.rows.length <= FOLD ||
  unfolded.has(n) ||
  sec.rows.slice(FIRST).some((d) => props.target === mcpAnchor(d))
    ? sec.rows
    : sec.rows.slice(0, FIRST);
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
    <template v-for="(sec, n) in sections" :key="n">
      <p v-if="sec.fix" class="mc-fix" v-html="md(sec.fix)" />
      <p v-if="listed && everyTool(sec)" class="mc-tools">All {{ tools }} tools</p>
      <ul v-else-if="listed" :class="sec.fix ? 'mc-tools' : 'mc-per'">
        <li v-for="d in shown(sec, n)" :id="rowId(d, n)" :key="mcpAnchor(d)" :data-on="on(d)">
          <a
            v-if="d.tool !== undefined"
            class="mc-tn"
            :href="mcpHash(mcpAnchor(d))"
            @click.prevent="emit('link', mcpAnchor(d))"
            @mouseenter="sec.tip && tipUnder($event, md(d.fix))"
            @mouseleave="hideTip"
            @focus="sec.tip && tipUnder($event, md(d.fix))"
            @blur="hideTip"
            >{{ d.tool }}</a
          ><span v-else class="mc-tn">server</span><span v-if="!sec.fix" v-html="md(d.fix)" />
        </li>
        <li v-if="shown(sec, n).length < sec.rows.length">
          <button type="button" class="mc-link" @click="unfolded.add(n)">
            {{ sec.rows.length - FIRST }} more
          </button>
        </li>
      </ul>
    </template>
  </li>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CopyIcon from "./CopyIcon.vue";
import { copied, esc } from "../lib/ui";
import {
  andList,
  type McpCheckDiagnostic,
  mcpAnchor,
  mcpDocs,
  mcpHash,
  type McpProblem,
  problemTitle,
  sharedFix,
} from "../lib/mcp";

/**
  One problem: its title and Diagnostic Code, the clients it hits (unfolding to what each one does), and a row per tool
  under the fix it takes. A fix several tools share shows once above them, and so does one fix with a value per tool
  (`sharedFix()`), each row then holding only the tool and its value. `target` is the anchor a shared link points at inside it, and `link`
  asks the view to copy the link to an anchor.
*/
const props = defineProps<{
  problem: McpProblem;
  labels: Record<string, string>;
  target?: string;
}>();
const emit = defineEmits<{ link: [anchor: string] }>();

// Past this many rows, all but the first FIRST fold away.
const FOLD = 16;
const FIRST = 12;

const md = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const hits = computed(() => [...props.problem.clients.entries()]);
const label = (id: string) => props.labels[id] ?? id;

const items = computed(() => props.problem.items);
const same = computed(() => new Set(items.value.map((d) => d.fix)).size === 1);
const shared = computed(() => (same.value ? undefined : sharedFix(items.value.map((d) => d.fix))));
/**
  The rows in sections, each under the fix its rows share: one section when every tool takes the same fix or the same
  fix with its own value, one per fix when several tools share each, else one section whose rows carry their own fix.
*/
const sections = computed(() => {
  const all = items.value;
  if (same.value) return [{ fix: all[0]!.fix, rows: all.map((d) => ({ d, text: "" })) }];
  const s = shared.value;
  if (s) return [{ fix: s.fix, rows: all.map((d, i) => ({ d, text: s.values[i]! })) }];
  const byFix = Map.groupBy(all, (d) => d.fix);
  if (byFix.size < all.length)
    return [...byFix].map(([fix, ds]) => ({ fix, rows: ds.map((d) => ({ d, text: "" })) }));
  return [{ fix: undefined, rows: all.map((d) => ({ d, text: d.fix })) }];
});
// A problem about the server alone, with one fix, has no rows to list.
const listed = computed(() => !(same.value && items.value.every((d) => d.tool === undefined)));

const own = computed(() =>
  items.value.length === 1 ? mcpAnchor(items.value[0]!) : props.problem.code,
);
const rowId = (d: McpCheckDiagnostic) => (d.tool === undefined ? undefined : mcpAnchor(d));
const on = (d: McpCheckDiagnostic) => (props.target === mcpAnchor(d) ? "" : undefined);
const moreOpen = (rows: { d: McpCheckDiagnostic }[]) =>
  rows.slice(FIRST).some((r) => props.target === mcpAnchor(r.d));
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
        <CopyIcon :done="copied.key === `link:${own}`" />
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
      <template v-if="listed">
        <ul class="mc-per" :class="{ long: !sec.fix }">
          <li
            v-for="(r, i) in sec.rows.length > FOLD ? sec.rows.slice(0, FIRST) : sec.rows"
            :id="rowId(r.d)"
            :key="i"
            :data-on="on(r.d)"
          >
            <a
              v-if="r.d.tool !== undefined"
              class="mc-tn"
              :href="mcpHash(mcpAnchor(r.d))"
              @click.prevent="emit('link', mcpAnchor(r.d))"
              >{{ r.d.tool }}</a
            ><span v-else class="mc-tn">server</span><span v-if="r.text" v-html="md(r.text)" />
          </li>
        </ul>
        <details v-if="sec.rows.length > FOLD" class="mc-why" :open="moreOpen(sec.rows)">
          <summary>{{ sec.rows.length - FIRST }} more tools</summary>
          <ul class="mc-per" :class="{ long: !sec.fix }">
            <li
              v-for="(r, i) in sec.rows.slice(FIRST)"
              :id="rowId(r.d)"
              :key="i"
              :data-on="on(r.d)"
            >
              <a
                v-if="r.d.tool !== undefined"
                class="mc-tn"
                :href="mcpHash(mcpAnchor(r.d))"
                @click.prevent="emit('link', mcpAnchor(r.d))"
                >{{ r.d.tool }}</a
              ><span v-else class="mc-tn">server</span><span v-if="r.text" v-html="md(r.text)" />
            </li>
          </ul>
        </details>
      </template>
    </template>
  </li>
</template>

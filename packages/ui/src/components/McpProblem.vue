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
  One problem: its title and Diagnostic Code, the clients it hits (unfolding to what each one does), the fix, and a row
  per tool. When every tool takes the same fix, or the same fix with its own value (`sharedFix()`), the fix shows once
  and each row holds only the tool and its value. `target` is the anchor a shared link points at inside it, and `link`
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
const fix = computed(() => (same.value ? items.value[0]!.fix : shared.value?.fix));
const rows = computed(() =>
  items.value.map((d, i) => ({
    d,
    text: same.value ? "" : (shared.value?.values[i] ?? d.fix),
  })),
);
// A problem about the server alone, with one fix, has no rows to list.
const listed = computed(() => !(same.value && items.value.every((d) => d.tool === undefined)));
const folded = computed(() => rows.value.length > FOLD);
const shown = computed(() => (folded.value ? rows.value.slice(0, FIRST) : rows.value));

const own = computed(() =>
  items.value.length === 1 ? mcpAnchor(items.value[0]!) : props.problem.code,
);
const rowId = (d: McpCheckDiagnostic) => (d.tool === undefined ? undefined : mcpAnchor(d));
const on = (d: McpCheckDiagnostic) => (props.target === mcpAnchor(d) ? "" : undefined);
const moreOpen = computed(() =>
  rows.value.slice(FIRST).some((r) => props.target === mcpAnchor(r.d)),
);
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
    <p v-if="fix" class="mc-fix" v-html="md(fix)" />
    <template v-if="listed">
      <ul class="mc-per" :class="{ long: !fix }">
        <li v-for="(r, i) in shown" :id="rowId(r.d)" :key="i" :data-on="on(r.d)">
          <a
            v-if="r.d.tool !== undefined"
            class="mc-tn"
            :href="mcpHash(mcpAnchor(r.d))"
            @click.prevent="emit('link', mcpAnchor(r.d))"
            >{{ r.d.tool }}</a
          ><span v-else class="mc-tn">server</span><span v-if="r.text" v-html="md(r.text)" />
        </li>
      </ul>
      <details v-if="folded" class="mc-why" :open="moreOpen">
        <summary>{{ rows.length - FIRST }} more tools</summary>
        <ul class="mc-per" :class="{ long: !fix }">
          <li v-for="(r, i) in rows.slice(FIRST)" :id="rowId(r.d)" :key="i" :data-on="on(r.d)">
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
  </li>
</template>

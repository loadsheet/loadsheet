<script setup lang="ts">
import { computed } from "vue";
import CopyIcon from "./CopyIcon.vue";
import { copied, esc } from "../lib/ui";
import {
  type McpCheckDiagnostic,
  mcpAnchor,
  mcpDocs,
  mcpHash,
  type McpProblem,
  plural,
  problemTitle,
} from "../lib/mcp";

/**
  One problem: its title and Diagnostic Code, the clients it hits, the fix, and what each client does. `target` is
  the anchor a shared link points at inside it, and `link` asks the view to copy the link to an anchor.
*/
const props = defineProps<{
  problem: McpProblem;
  labels: Record<string, string>;
  target?: string;
}>();
const emit = defineEmits<{ link: [anchor: string] }>();

const md = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const hits = computed(() => [...props.problem.clients.entries()]);
const tools = computed(() => [
  ...new Set(props.problem.items.map((d) => d.tool).filter((t): t is string => !!t)),
]);
const oneFix = computed(() => new Set(props.problem.items.map((d) => d.fix)).size === 1);
const toolLine = computed(() => {
  const t = tools.value;
  const names = t.slice(0, 6).map((n) => (n.length > 40 ? `${n.slice(0, 39)}…` : n));
  return `${plural(t.length, "tool")}: ${names.join(", ")}${t.length > 6 ? `, +${t.length - 6} more` : ""}`;
});
const label = (id: string) => props.labels[id] ?? id;

const own = computed(() =>
  props.problem.items.length === 1 ? mcpAnchor(props.problem.items[0]!) : props.problem.code,
);
const rowId = (d: McpCheckDiagnostic) => (d.tool === undefined ? undefined : mcpAnchor(d));
const on = (d: McpCheckDiagnostic) => (props.target === mcpAnchor(d) ? "" : undefined);
const moreOpen = computed(() =>
  props.problem.items.slice(4).some((d) => props.target === mcpAnchor(d)),
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
    <div class="mc-hits">
      <template v-if="hits.length">
        <span v-for="[id, f] in hits" :key="id" class="mc-cl" :class="`s-${f.severity}`"
          ><i />{{ label(id) }}</span
        >
      </template>
      <span v-else>The MCP spec, before any client</span>
    </div>
    <template v-if="oneFix">
      <p class="mc-fix"><span>Fix: </span><span v-html="md(problem.items[0]!.fix)" /></p>
      <p v-if="tools.length" class="mc-tools">{{ toolLine }}</p>
    </template>
    <template v-else>
      <p class="mc-small">Fix each tool:</p>
      <ul class="mc-per">
        <li v-for="(d, i) in problem.items.slice(0, 4)" :id="rowId(d)" :key="i" :data-on="on(d)">
          <a
            v-if="d.tool !== undefined"
            class="mc-tn"
            :href="mcpHash(mcpAnchor(d))"
            @click.prevent="emit('link', mcpAnchor(d))"
            >{{ d.tool }}</a
          ><span v-else class="mc-tn">server</span><span v-html="md(d.fix)" />
        </li>
      </ul>
      <details v-if="problem.items.length > 4" class="mc-why" :open="moreOpen">
        <summary>{{ problem.items.length - 4 }} more tools</summary>
        <ul class="mc-per">
          <li v-for="(d, i) in problem.items.slice(4)" :id="rowId(d)" :key="i" :data-on="on(d)">
            <a
              v-if="d.tool !== undefined"
              class="mc-tn"
              :href="mcpHash(mcpAnchor(d))"
              @click.prevent="emit('link', mcpAnchor(d))"
              >{{ d.tool }}</a
            ><span v-else class="mc-tn">server</span><span v-html="md(d.fix)" />
          </li>
        </ul>
      </details>
    </template>
    <details v-if="hits.length" class="mc-why">
      <summary>What each client does</summary>
      <ul>
        <li v-for="[id, f] in hits" :key="id">
          <b>{{ label(id) }}</b>: <span v-html="md(f.message)" />
          <template v-if="f.source?.url">
            <a :href="f.source.url" target="_blank" rel="noopener">Source</a>
          </template>
        </li>
      </ul>
    </details>
  </li>
</template>

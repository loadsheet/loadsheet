<script setup lang="ts">
import { computed } from "vue";
import { esc } from "../lib/ui";
import { mcpDocs, type McpProblem, plural, problemTitle } from "../lib/mcp";

/** One problem: its title and Diagnostic Code, the clients it hits, the fix, and what each client does. */
const props = defineProps<{ problem: McpProblem; labels: Record<string, string> }>();

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
</script>

<template>
  <li class="mc-prob" :class="`s-${problem.severity}`">
    <div class="mc-pt">
      <i class="mc-dot" :class="`s-${problem.severity}`" />
      <b>{{ problemTitle(problem.code) }}</b>
      <a class="mc-code" :href="mcpDocs(problem.code)" target="_blank" rel="noopener">{{
        problem.code
      }}</a>
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
        <li v-for="(d, i) in problem.items.slice(0, 4)" :key="i">
          <span class="mc-tn">{{ d.tool ?? "server" }}</span><span v-html="md(d.fix)" />
        </li>
      </ul>
      <details v-if="problem.items.length > 4" class="mc-why">
        <summary>{{ problem.items.length - 4 }} more tools</summary>
        <ul class="mc-per">
          <li v-for="(d, i) in problem.items.slice(4)" :key="i">
            <span class="mc-tn">{{ d.tool ?? "server" }}</span><span v-html="md(d.fix)" />
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

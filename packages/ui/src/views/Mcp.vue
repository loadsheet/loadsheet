<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Cmd from "../components/Cmd.vue";
import CopyIcon from "../components/CopyIcon.vue";
import McpClientMark from "../components/McpClientMark.vue";
import McpProblem from "../components/McpProblem.vue";
import SiteTop from "../components/SiteTop.vue";
import {
  type McpCheck,
  type McpCheckError,
  type McpProblem as McpProblemGroup,
  anchorOf,
  andList,
  clientStatus,
  hostOf,
  localCommand,
  mcpFailure,
  mcpFixPrompt,
  mcpHash,
  mcpProblems,
  mcpTarget,
  mcpUrl,
  mcpVerdict,
  plural,
  shortUrl,
} from "../lib/mcp";
import { copied, copy, esc, hideTip, showTip } from "../lib/ui";

/**
  Checks an MCP server against every client. The host runs the check: it gets `check` with the URL, then passes the
  `url` it checked with `pending`, then `result` or `error`. A URL fragment such as `#MCP0001-get-blog-post`
  (`mcpAnchor()`) scrolls to that diagnostic once the result is on screen and marks it.
*/
const props = defineProps<{
  url?: string;
  pending?: boolean;
  result?: McpCheck;
  error?: McpCheckError;
}>();
const emit = defineEmits<{ check: [url: string] }>();

// What happens in a client that has a problem, beside its name.
const SAYS: Record<string, string> = { warn: "problem", error: "drops tools" };

const TRY = ["https://mcp.deepwiki.com/mcp", "https://nuxt.com/mcp", "https://mcp.linear.app/mcp"];

const draft = ref(props.url ?? "");
watch(
  () => props.url,
  (u) => u && (draft.value = u),
);
function check(value = draft.value) {
  const url = mcpUrl(value);
  draft.value = url;
  emit("check", url);
}

const r = computed(() => (props.pending ? undefined : props.result));
const labels = computed(() =>
  Object.fromEntries(r.value?.clients.map((c) => [c.id, c.label]) ?? []),
);
const status = computed(() => (r.value ? clientStatus(r.value) : {}));
// Clients with a problem get a row each; the rest, notes included, sit together as marks that name themselves on hover.
const hit = computed(() => r.value?.clients.filter((c) => SAYS[status.value[c.id] ?? "ok"]) ?? []);
const fine = computed(
  () => r.value?.clients.filter((c) => !SAYS[status.value[c.id] ?? "ok"]) ?? [],
);
function tipAt(e: MouseEvent | FocusEvent, label: string) {
  const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showTip({ clientX: at.left, clientY: at.bottom - 8 } as MouseEvent, esc(label));
}
const problems = computed(() => (r.value ? mcpProblems(r.value) : []));
const real = computed(() => problems.value.filter((p) => p.severity !== "info"));
const notes = computed(() => problems.value.filter((p) => p.severity === "info"));
const verdict = computed(() => (r.value ? mcpVerdict(r.value) : undefined));
const prompt = computed(() =>
  r.value && props.url ? mcpFixPrompt(r.value, props.url, problems.value) : "",
);
const serverLine = computed(() => {
  const s = r.value?.server;
  const name = `${s?.name ?? "Server"}${s?.version ? ` ${s.version}` : ""}`;
  return [name, plural(r.value?.toolCount ?? 0, "tool"), props.url && shortUrl(props.url)]
    .filter(Boolean)
    .join(" · ");
});

// The problem the URL fragment points at: marked, unfolded and scrolled to whenever a result lands or the fragment changes.
// Shallow, so `target.problem` stays the very object `problems` holds and the cards can compare against it.
const target = shallowRef<ReturnType<typeof mcpTarget>>();
// A card's id is its code, on the first card of each code: notes on a code can follow its problems.
const cardIds = computed(() => {
  const ids = new Map<McpProblemGroup, string>();
  for (const p of problems.value) if (![...ids.values()].includes(p.code)) ids.set(p, p.code);
  return ids;
});
async function aim() {
  target.value = r.value ? mcpTarget(problems.value, anchorOf(location.hash)) : undefined;
  if (!target.value) return;
  await nextTick();
  const el =
    document.querySelector(".mc-prob[data-on] li[data-on]") ??
    document.querySelector(".mc-prob[data-on]");
  el?.scrollIntoView({
    block: "center",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}
watch(r, aim, { flush: "post" });
onMounted(() => {
  window.addEventListener("hashchange", aim);
  if (r.value) void aim();
});
onBeforeUnmount(() => window.removeEventListener("hashchange", aim));
/** Puts an anchor in the address bar and copies the whole link, the server's URL with it. */
function link(anchor: string) {
  history.replaceState(history.state, "", mcpHash(anchor));
  target.value = mcpTarget(problems.value, anchor);
  copy(location.href, "Link copied", `link:${anchor}`);
}

const failed = computed(() => (props.pending ? undefined : props.error));
const failure = computed(() => (failed.value ? mcpFailure(failed.value) : undefined));
const host = computed(() => (props.url ? hostOf(props.url) : ""));
const ask = computed(
  () =>
    `Run \`${failed.value?.command}\` with my token for ${host.value} in TOKEN, then fix what it reports in my MCP server's tools/list.`,
);
</script>

<template>
  <div class="land">
    <SiteTop />
    <main class="w mc">
      <div class="mc-head">
        <h1 class="px">Does your MCP server work in every client?</h1>
        <p class="mc-lede">
          Paste its URL. We read its tools once and show what Claude, ChatGPT, Cursor and 6 other
          clients do with them.
        </p>
      </div>
      <form class="mc-check" @submit.prevent="check()">
        <label for="mcp-url" class="sr">MCP server URL</label>
        <input
          id="mcp-url"
          v-model="draft"
          class="inp"
          inputmode="url"
          placeholder="https://mcp.example.com/mcp"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
        />
        <button data-slot="button" data-variant="solid" data-size="lg" :disabled="pending">
          {{ pending ? "Checking…" : "Check" }}
        </button>
      </form>
      <p class="mc-try">
        Try
        <button v-for="u in TRY" :key="u" type="button" class="mc-link" @click="check(u)">
          {{ shortUrl(u) }}
        </button>
      </p>

      <div aria-live="polite">
        <div v-if="pending" class="mc-loading">
          <span class="mc-sp" aria-hidden="true" />Reading tools/list from {{ host }}…
        </div>

        <div v-else-if="r && verdict" class="mc-res">
          <aside class="mc-side">
            <p class="mc-srv mono">{{ serverLine }}</p>
            <h2 class="px" :class="{ 's-error': verdict.breaks }">{{ verdict.title }}</h2>
            <button
              v-if="real.length"
              type="button"
              data-slot="button"
              data-variant="solid"
              :data-done="copied.key === prompt || undefined"
              @click="copy(prompt, 'Prompt copied, paste it into your agent')"
            >
              <CopyIcon :done="copied.key === prompt" />Copy fix prompt
            </button>
            <ul v-if="hit.length" class="mc-clients" aria-label="Clients with problems">
              <li v-for="c in hit" :key="c.id" class="mc-cl" :class="`s-${status[c.id]}`">
                <McpClientMark :id="c.id" :label="c.label" />{{ c.label
                }}<span>{{ SAYS[status[c.id]!] }}</span>
              </li>
            </ul>
            <div v-if="fine.length" class="mc-fine">
              <ul
                data-slot="vh-avatar-group"
                :aria-label="`Fine in ${andList(fine.map((c) => c.label))}`"
              >
                <li
                  v-for="c in fine"
                  :key="c.id"
                  data-slot="avatar"
                  tabindex="0"
                  @mouseenter="tipAt($event, c.label)"
                  @mouseleave="hideTip"
                  @focus="tipAt($event, c.label)"
                  @blur="hideTip"
                >
                  <McpClientMark :id="c.id" :label="c.label" />
                </li>
              </ul>
              <span v-if="hit.length">{{ fine.length }} fine</span>
            </div>
            <details v-if="r.ci" class="mc-fold">
              <summary>Run in CI</summary>
              <Cmd :fix="{ type: 'cmd', text: r.ci }" />
            </details>
          </aside>
          <div class="mc-main">
            <ol v-if="real.length" class="mc-probs">
              <McpProblem
                v-for="p in real"
                :id="cardIds.get(p)"
                :key="p.code"
                :problem="p"
                :labels="labels"
                :target="target?.problem === p ? target.anchor : undefined"
                @link="link"
              />
            </ol>
            <p v-else class="mc-none">Nothing to fix.</p>
            <template v-if="notes.length">
              <h3 class="mc-notes">Notes on client behavior</h3>
              <ol class="mc-probs">
                <McpProblem
                  v-for="p in notes"
                  :id="cardIds.get(p)"
                  :key="p.code"
                  :problem="p"
                  :labels="labels"
                  :target="target?.problem === p ? target.anchor : undefined"
                  @link="link"
                />
              </ol>
            </template>
          </div>
        </div>

        <div v-else-if="failed?.code === 'auth-required' && failed.command" class="mc-state">
          <h2 class="px">This server needs a token</h2>
          <p>
            {{ host }} answered HTTP 401. loadsheet.dev never asks for your token, so run the same
            check on your machine:
          </p>
          <Cmd :fix="{ type: 'cmd', text: failed.command }" />
          <p class="mc-small">
            Set <code>TOKEN</code> to an API key for this server first. You get the same report in
            your terminal.
          </p>
          <div>
            <button
              type="button"
              data-slot="button"
              :data-done="copied.key === ask || undefined"
              @click="copy(ask, 'Prompt copied, paste it into your agent')"
            >
              <CopyIcon :done="copied.key === ask" />Copy prompt for your agent
            </button>
          </div>
        </div>

        <div v-else-if="failure" class="mc-state err">
          <h2 class="px">{{ failure.title }}</h2>
          <p>{{ failure.text }}</p>
          <p v-if="failure.said" class="mc-said mono">The server said: {{ failure.said }}</p>
          <Cmd v-if="failure.local && url" :fix="{ type: 'cmd', text: localCommand(url) }" />
        </div>
      </div>
    </main>
  </div>
</template>

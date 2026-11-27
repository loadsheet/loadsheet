<script setup lang="ts">
import { Mcp, type McpCheck, type McpCheckError, mcpUrl, shortUrl } from "@loadsheet/ui";

definePageMeta({ name: "mcp" });

/**
  `/mcp?url=<server URL>` is the shareable link to a report: opening it checks that server again, live, and checking
  one from the input puts its URL in the query. A `#MCP0001-get-blog-post` fragment points at one diagnostic (the
  view handles it). Stored snapshots will live at `/mcp/r/<id>`.
*/
const route = useRoute();
const router = useRouter();
const queried = () => {
  const q = route.query.url;
  return mcpUrl((Array.isArray(q) ? q[0] : q) ?? "");
};

const url = ref(queried());
const pending = ref(!!url.value);
const result = ref<McpCheck>();
const error = ref<McpCheckError>();
let run = 0;

const description =
  "Paste an MCP server's URL and see what Claude, ChatGPT, Cursor and 6 other clients do with its tools, worst problem first.";
const server = computed(() => (url.value ? shortUrl(url.value) : ""));
useSeoMeta({
  title: () =>
    server.value
      ? `${server.value} in every MCP client · loadsheet`
      : "Check an MCP server in every client · loadsheet",
  description,
  ogTitle: () =>
    server.value
      ? `Does ${server.value} work in every MCP client?`
      : "Does your MCP server work in every client?",
  ogDescription: description,
});

onMounted(() => {
  if (url.value) void scan(url.value);
});
// Back and forward between checks, or a link to another server's report.
watch(queried, (next) => {
  if (next && next !== url.value) void scan(next);
});

/** A check from the input: its URL goes into the address bar, which drops the old fragment, then it runs. */
function check(next: string) {
  if (next !== queried()) void router.replace({ query: { ...route.query, url: next } });
  void scan(next);
}

async function scan(next: string) {
  const id = ++run;
  url.value = next;
  pending.value = true;
  result.value = error.value = undefined;
  try {
    const r = await $fetch<McpCheck>("/api/mcp", { method: "POST", body: { url: next } });
    if (id === run) result.value = r;
  } catch (e) {
    if (id !== run) return;
    const res = e as {
      status?: number;
      data?: { error?: string; message?: string; command?: string };
    };
    const body = res.data ?? {};
    error.value = {
      code: res.status === 429 ? "rate-limited" : (body.error ?? "unknown"),
      ...(body.message ? { message: body.message } : {}),
      ...(body.command ? { command: body.command } : {}),
    };
  } finally {
    if (id === run) pending.value = false;
  }
}
</script>

<template>
  <Mcp :url="url" :pending="pending" :result="result" :error="error" @check="check" />
</template>

<script setup lang="ts">
import { Mcp, type McpCheck, type McpCheckError } from "@loadsheet/ui";

definePageMeta({ name: "mcp" });

const description =
  "Paste an MCP server's URL and see what Claude, ChatGPT, Cursor and 6 other clients do with its tools, worst problem first.";
useSeoMeta({
  title: "Check an MCP server in every client · loadsheet",
  description,
  ogTitle: "Does your MCP server work in every client?",
  ogDescription: description,
});

const url = ref("");
const pending = ref(false);
const result = ref<McpCheck>();
const error = ref<McpCheckError>();
let run = 0;

async function check(next: string) {
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

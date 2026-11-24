<script setup lang="ts">
import { SchemaError } from "@loadsheet/schema";
import { ref } from "vue";
import { useRouter } from "vue-router";
import Logo from "../components/Logo.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import { openFile } from "../lib/report";

const router = useRouter();
const over = ref(false);
const error = ref<{ title: string; issues: { path: string; message: string }[] }>();
async function take(file?: File) {
  over.value = false;
  if (!file) return;
  try {
    await openFile(file);
    router.push("/report/overview");
  } catch (e) {
    error.value =
      e instanceof SchemaError
        ? { title: `${file.name} isn't a loadsheet report this page can read`, issues: e.issues.slice(0, 8) }
        : { title: `${file.name} isn't JSON`, issues: [{ path: "", message: e instanceof Error ? e.message : String(e) }] };
  }
}
</script>

<template>
  <header class="top">
    <RouterLink class="brand" to="/"><Logo />loadsheet</RouterLink>
    <div class="right"><RouterLink class="btn quiet sm" to="/report">Back to the example</RouterLink><ThemeToggle /></div>
  </header>
  <main class="page narrow">
    <label class="drop card" :data-over="over || undefined" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="take($event.dataTransfer?.files[0])">
      <input type="file" accept="application/json,.json" class="sr" @change="take(($event.target as HTMLInputElement).files?.[0])" />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></svg>
      <h1>Open a report</h1>
      <p>Drop the file <code>npx loadsheet --json &gt; report.json</code> wrote, or click to pick it. It stays in this tab; nothing is uploaded.</p>
    </label>
    <div v-if="error" class="card pad err" role="alert">
      <h2>{{ error.title }}</h2>
      <ul>
        <li v-for="(i, n) in error.issues" :key="n"><code v-if="i.path">{{ i.path }}</code> {{ i.message }}</li>
      </ul>
      <p class="muted small">A report from a newer loadsheet may need a newer page. Run <code>npx loadsheet@latest --ui</code> to open it.</p>
    </div>
  </main>
</template>

<style scoped>
.narrow { max-width: 680px; padding-top: 48px; }
.drop { display: grid; justify-items: center; gap: 10px; padding: 48px 32px; text-align: center; cursor: pointer; transition: box-shadow 0.15s var(--ease); }
.drop { border-style: dashed; border-color: var(--line-strong); }
@media (hover: hover) and (pointer: fine) { .drop:hover { border-color: var(--muted); } }
.drop[data-over], .drop:focus-within { border-style: solid; border-color: var(--ice); box-shadow: 0 0 0 3px var(--ice-tint); }
.drop svg { width: 32px; height: 32px; color: var(--muted); }
.drop h1 { font-size: 1.375rem; }
.drop p { max-width: 44ch; color: var(--muted); }
.err { display: grid; gap: 10px; border-color: color-mix(in oklch, var(--warm) 40%, var(--line)); box-shadow: inset 3px 0 var(--warm); }
.err h2 { font-size: 1.125rem; }
.err ul { display: grid; gap: 4px; font-size: 0.875rem; }
.err code { color: var(--warm-ink); }
</style>

<script setup lang="ts">
import { Tree } from "@ui-sdk/vue/tree";
import { computed, onMounted, reactive, ref, watch } from "vue";
import SkillTreeRows, { type FileNode } from "./SkillTreeRows.vue";
import { fmt } from "../lib/report";
import {
  type SkillFiles,
  type SkillItem,
  type SkillPack,
  blobUrl,
  isLong,
  rawUrl,
} from "../lib/skills";

/**
  Every file of the pack's skills, laid out as the repository has them, and the one picked. The list comes with the
  page; a file's text comes from GitHub at the commit the pack was measured at, when it is opened.
*/
const props = defineProps<{ pack: SkillPack; files: SkillFiles }>();

/** Larger files open on GitHub instead. */
const MAX_TEXT = 256 * 1024;

const byPath = computed(() => new Map(props.files.files.map((f) => [f.path, f])));
const dirOf = (s: SkillItem) => (s.path === "SKILL.md" ? "" : s.path);
const skillAt = computed(() => new Map(props.pack.items.map((s) => [dirOf(s), s])));
const skillMd = (dir: string) => (dir ? `${dir}/SKILL.md` : "SKILL.md");

const tree = computed<FileNode[]>(() => {
  const root: FileNode[] = [];
  const dirs = new Map<string, FileNode>();
  for (const { path } of props.files.files) {
    const parts = path.split("/");
    let level = root;
    for (let i = 0; i < parts.length; i++) {
      const value = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        level.push({ value, label: parts[i]! });
        break;
      }
      let dir = dirs.get(value);
      if (!dir) {
        const s = skillAt.value.get(value);
        dir = {
          value,
          label: parts[i]!,
          children: [],
          ...(s ? { skill: { tokens: s.tokens, long: isLong(props.pack, s.name) } } : {}),
        };
        dirs.set(value, dir);
        level.push(dir);
      }
      level = dir.children!;
    }
  }
  // Folders first, then files, as an editor lists them.
  const order = (ns: FileNode[]) => {
    ns.sort(
      (a, b) => Number(!!b.children) - Number(!!a.children) || a.label.localeCompare(b.label),
    );
    for (const n of ns) if (n.children) order(n.children);
    return ns;
  };
  return order(root);
});

const value = ref<string | null>(null);
const expanded = ref<string[]>([]);
const shown = ref<string | null>(null);
function open(path: string) {
  const parts = path.split("/");
  const up = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  expanded.value = [...new Set([...expanded.value, ...up])];
  value.value = path;
  shown.value = path;
}
// The heaviest skill's SKILL.md is open when the page loads.
watch(
  () => props.pack.slug,
  () => {
    expanded.value = [];
    const top = props.pack.items[0];
    if (top) open(skillMd(dirOf(top)));
  },
  { immediate: true },
);
// Picking a skill's folder shows its SKILL.md.
watch(value, (v) => {
  if (!v) return;
  if (byPath.value.has(v)) shown.value = v;
  else if (byPath.value.has(skillMd(v))) shown.value = skillMd(v);
});

const file = computed(() => (shown.value ? byPath.value.get(shown.value) : undefined));
const skill = computed(() => {
  const path = shown.value;
  if (!path || !(path === "SKILL.md" || path.endsWith("/SKILL.md"))) return undefined;
  return skillAt.value.get(path.split("/").slice(0, -1).join("/"));
});

type Text = { state: "loading" } | { state: "ok"; text: string } | { state: "failed" };
const texts = reactive(new Map<string, Text>());
async function load(path: string) {
  if (texts.has(path)) return;
  texts.set(path, { state: "loading" });
  try {
    const res = await fetch(rawUrl(props.pack, path));
    if (!res.ok) throw new Error(String(res.status));
    texts.set(path, { state: "ok", text: await res.text() });
  } catch {
    texts.set(path, { state: "failed" });
  }
}
const readable = computed(() => !!file.value && !file.value.binary && file.value.size <= MAX_TEXT);
// Text loads only in the browser; the server renders the tree and the header.
const mounted = ref(false);
onMounted(() => (mounted.value = true));
watch(
  [shown, mounted],
  ([path, on]) => {
    if (on && path && readable.value) load(path);
  },
  { immediate: true },
);
const text = computed(() => (shown.value ? texts.get(shown.value) : undefined));

/** SKILL.md's front matter is the part every session reads; the rest loads when the skill runs. */
const parts = computed(() => {
  const t = text.value?.state === "ok" ? text.value.text : "";
  const m = skill.value && t.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? { head: m[0], body: t.slice(m[0].length) } : { head: "", body: t };
});
const size = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
</script>

<template>
  <div class="sk-fb">
    <div class="sk-side">
      <div class="sk-side-h muted">
        <span>Files</span><span class="num">{{ fmt(files.files.length) }}</span>
      </div>
      <Tree
        v-model:value="value"
        v-model:expanded="expanded"
        :items="tree"
        aria-label="Skill files"
        class="sk-tree"
      >
        <SkillTreeRows :items="tree" />
      </Tree>
    </div>
    <div class="sk-view">
      <div class="sk-view-h">
        <span class="mono">{{ shown }}</span>
        <span class="grow" />
        <template v-if="skill">
          <span v-if="isLong(pack, skill.name)" class="chip sk-warn">long description</span>
          <span class="chip">{{
            skill.tokens ? `${fmt(skill.tokens)} tokens every session` : "slash-only, 0 tokens"
          }}</span>
        </template>
        <span v-if="file" class="muted num sk-small">{{ size(file.size) }}</span>
      </div>
      <p v-if="file && !readable" class="sk-empty muted">
        {{ file.binary ? "Not a text file." : "Too large to show here." }}
        <a class="sk-lnk" :href="blobUrl(pack, file.path)">Open it on GitHub</a>
      </p>
      <p v-else-if="text?.state === 'failed'" class="sk-empty muted">
        GitHub didn’t send this file.
        <a class="sk-lnk" :href="blobUrl(pack, shown!)">Open it on GitHub</a>
      </p>
      <p v-else-if="text?.state !== 'ok'" class="sk-empty muted">Loading from GitHub…</p>
      <pre
        v-else
        class="sk-code"
      ><span v-if="parts.head" class="sk-fm">{{ parts.head }}</span>{{ parts.body }}</pre>
    </div>
  </div>
</template>

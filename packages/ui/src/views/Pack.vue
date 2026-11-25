<script setup lang="ts">
import { computed, provide, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ContextTable from "../components/ContextTable.vue";
import Legend from "../components/Legend.vue";
import SiteTop from "../components/SiteTop.vue";
import StateBox from "../components/StateBox.vue";
import Treemap, { type Block } from "../components/Treemap.vue";
import { VIEW, contextOf, freshView } from "../lib/context";
import {
  type Pack,
  type PackError,
  findingName,
  fmt,
  kindOf,
  packRoute,
  packSlug,
  packTokens,
  saved,
  shortName,
  totals,
} from "../lib/report";
import { useLoadsheet } from "../lib/state";

/**
  A pack's weight: what it adds to every session, each skill with its description and tokens. A host that reads packs on
  a server passes `pack`, `pending` and `error`; without them the page shows the pack the route names from those it has.
*/
const props = defineProps<{ pack?: Pack; pending?: boolean; error?: PackError }>();
const emit = defineEmits<{ retry: [] }>();

const route = useRoute();
const router = useRouter();
const { packs } = useLoadsheet();
/** `owner/repo[/dir]`: the route's `slug` segments, one per folder. */
const slug = computed(() => [route.params.slug ?? []].flat().filter(Boolean).join("/"));
const remote = computed(() => !!(props.pack || props.pending || props.error));
const pack = computed(() => (remote.value ? props.pack : packs[slug.value]));
const sheet = computed(() => pack.value?.report.sheet[0]);
const listed = computed(() => sheet.value?.lines.filter((l) => l.tokens.value > 0) ?? []);
const sum = computed(() => (sheet.value ? totals(sheet.value) : undefined));
const blocks = computed<Block[]>(() =>
  listed.value.map((l) => ({
    id: l.item,
    name: l.ref.name,
    label: shortName(l),
    value: l.tokens.value,
    group: kindOf(l),
  })),
);
const max = computed(() => pack.value?.report.config.rules["expensive-description"].maxChars ?? 0);

/** The table of the report page, over the pack's lines: its skills come from one place, the pack. */
const ctx = computed(() => {
  if (!sheet.value) return undefined;
  const c = contextOf(sheet.value);
  for (const s of c.segments) for (const i of s.items) i.group = slug.value;
  return c;
});
const st = reactive(freshView());
watch(
  ctx,
  () => {
    Object.assign(st, freshView());
    // Every skill shows, with its description: that is what this page is for.
    for (const key of [`skill:${slug.value}`, "skill:off"]) {
      st.src.add(key);
      st.more.add(key);
    }
  },
  { immediate: true },
);
provide(VIEW, {
  st,
  ctx: () => ctx.value!,
  harness: () => sheet.value?.harness ?? "",
  reveal: () => {},
});

const url = ref("");
watch(slug, (s) => (url.value = `github.com/${s}`), { immediate: true });
function go() {
  const s = packSlug(url.value);
  if (s) router.push(packRoute(s));
}

const failed = computed(() => {
  const s = slug.value;
  switch (props.error?.code) {
    case "not-found":
      return {
        title: `GitHub has no ${s}`,
        text: "The repository or folder is missing, or it is private. To weigh a private pack, run",
      };
    case "no-skills":
      return {
        title: `${s} has no skills`,
        text: "It holds no SKILL.md that npx skills add would install. To weigh it another way, run",
      };
    case "too-large":
      return {
        title: `${s} is too big to read here`,
        text: "To weigh it, run",
      };
    case "timeout":
      return { title: `Reading ${s} took too long`, text: "Try again, or run" };
    case "rate-limited":
      return { title: "Too many packs at once", text: "Wait a minute and try again, or run" };
    case "unsupported-source":
      return {
        title: `This page can’t read ${s}`,
        text: "It reads skill packs on GitHub. To weigh one from anywhere else, run",
      };
    default:
      return {
        title: `This page can’t read ${s}`,
        text: remote.value
          ? "To weigh it on your machine, run"
          : "It shows the packs below. To weigh any pack on GitHub, run",
      };
  }
});
const again = computed(() => ["timeout", "rate-limited"].includes(props.error?.code ?? ""));
</script>

<template>
  <div class="land">
    <SiteTop />
    <main class="w pk">
      <form class="pack" @submit.prevent="go">
        <span class="pack-row">
          <input
            v-model="url"
            class="inp"
            aria-label="Skill pack on GitHub"
            spellcheck="false"
            autocomplete="off"
          />
          <button data-slot="button" data-variant="solid" data-size="lg">Inspect</button>
        </span>
      </form>
      <template v-if="pack && sheet && sum && ctx">
        <div class="ph">
          <h1 class="px">Adds {{ fmt(packTokens(pack.report)) }} tokens to every session</h1>
        </div>
        <Legend v-if="sum.kinds.length > 1" class="pk-key" :kinds="sum.kinds" />
        <Treemap
          v-if="blocks.length"
          class="tm-pack"
          :blocks="blocks"
          unit="tokens"
          :interactive="false"
        />
        <ContextTable class="pk-t" :free="false" />
        <section v-if="pack.report.findings.length" class="pk-w">
          <h3>Worth knowing <em class="num">{{ pack.report.findings.length }}</em></h3>
          <ul class="pk-f">
            <li v-for="f in pack.report.findings" :key="f.id">
              <b class="mono">{{ findingName(f) }}</b>
              <p v-if="f.rule === 'expensive-description'">
                Its description is {{ fmt(f.evidence.listedChars ?? 0) }} characters.<template
                  v-if="saved(f)"
                >
                  Under {{ fmt(max) }} would save {{ fmt(saved(f)) }} tokens a session.</template
                >
              </p>
              <p v-else>
                {{
                  Object.entries(f.evidence)
                    .map(([k, v]) => `${k} ${fmt(v)}`)
                    .join(" · ")
                }}
              </p>
            </li>
          </ul>
        </section>
      </template>
      <StateBox v-else-if="pending" :title="`Reading ${slug}`">
        Fetching it from GitHub and weighing each skill.
      </StateBox>
      <StateBox v-else :title="failed.title">
        {{ failed.text }}
        <code>npx loadsheet &lt;GitHub URL&gt;</code> in a terminal.
        <template #actions>
          <button
            v-if="again"
            type="button"
            data-slot="button"
            data-variant="solid"
            @click="emit('retry')"
          >
            Try again
          </button>
          <RouterLink v-for="(p, s) in packs" :key="s" data-slot="button" :to="packRoute(s)">{{
            s
          }}</RouterLink>
        </template>
      </StateBox>
    </main>
  </div>
</template>

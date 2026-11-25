<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Cmd from "./Cmd.vue";
import {
  actionName,
  costOn,
  day,
  evidence,
  findingsFor,
  fixView,
  fmt,
  isDead,
  kindName,
  kindOf,
  pct,
  report,
  saved,
  type Line,
  type Sheet,
} from "../lib/report";

/** One loaded thing: what it costs, how often it loads, who uses it, and its fix. Sits beside the map, not over it. */
const props = defineProps<{ line: Line; sheet: Sheet }>();
const emit = defineEmits<{ close: [] }>();

const kind = computed(() => kindOf(props.line));
const dead = computed(() => isDead(props.line));
const fixes = computed(() => findingsFor(report.value, props.sheet.harness, props.line));
const WHAT = {
  mcp: "tokens of tool definitions",
  instr: "tokens of instructions",
  skill: "tokens for its name and description",
  agent: "tokens for its name and description",
};

const root = ref<HTMLElement>();
const onKey = (e: KeyboardEvent) => e.key === "Escape" && emit("close");
onMounted(() => {
  addEventListener("keydown", onKey);
  root.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => removeEventListener("keydown", onKey));
</script>

<template>
  <aside ref="root" class="panel" :aria-label="line.ref.name" tabindex="-1">
    <div class="panel-h">
      <div>
        <span class="kchip"><i :class="`k-${kind}`" />{{ kindName(kind) }}</span>
        <span v-if="dead" class="chip no">never used</span>
      </div>
      <button
        type="button"
        data-slot="button"
        data-variant="ghost"
        data-size="sm"
        aria-label="Close"
        @click="emit('close')"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
    <h2 class="mono">{{ line.ref.name }}</h2>
    <p v-if="line.path || line.machines.length" class="mono path">
      {{ [line.path, line.machines.join(", ")].filter(Boolean).join(" · ") }}
    </p>
    <dl class="stats">
      <div>
        <dt>When it loads</dt>
        <dd class="num">{{ fmt(line.tokens.value) }}</dd>
        <small>{{ WHAT[kind] }}</small>
      </div>
      <div v-if="sheet.sessions">
        <dt>Per session, averaged</dt>
        <dd class="num">{{ fmt(costOn(sheet)(line)) }}</dd>
        <small>across all {{ fmt(sheet.sessions) }} sessions</small>
      </div>
    </dl>
    <div v-if="sheet.sessions" class="meter">
      <div class="meter-l">
        <span
          >Loaded in {{ fmt(line.exposure.sessions) }} of {{ fmt(sheet.sessions) }} sessions</span
        ><b class="num">{{ pct(line.exposure.share) }}</b>
      </div>
      <div class="mbar">
        <i
          :class="`k-${dead ? 'dead' : kind}`"
          :style="{ width: `${line.exposure.share * 100}%` }"
        />
      </div>
    </div>
    <dl v-if="kind !== 'instr' && sheet.sessions" class="rows">
      <div>
        <dt>Called by the model</dt>
        <dd class="num">{{ fmt(line.use.byModel) }}</dd>
      </div>
      <div>
        <dt>Called by you</dt>
        <dd class="num">{{ fmt(line.use.byUser) }}</dd>
      </div>
      <div>
        <dt>Last used</dt>
        <dd class="num">{{ line.use.lastUsed ? day(line.use.lastUsed) : "never" }}</dd>
      </div>
    </dl>
    <section v-for="f in fixes" :key="f.id" class="fixbox">
      <div class="fixbox-h">
        <b>{{ actionName(f) }}</b><span v-if="saved(f)" class="save num">−{{ fmt(saved(f)) }}</span>
      </div>
      <p>{{ evidence(f) }}</p>
      <Cmd v-if="fixView(f)" :fix="fixView(f)!" />
    </section>
  </aside>
</template>

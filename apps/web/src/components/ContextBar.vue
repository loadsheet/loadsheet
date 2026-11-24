<script setup lang="ts">
import { fmt, pct, plural, type Context, type KindId } from "../lib/report";
import { hideTip, showTip } from "../lib/ui";

const props = defineProps<{ ctx: Context; selected?: KindId }>();
const emit = defineEmits<{ pick: [KindId] }>();

const tipFor = (e: MouseEvent, i: number) => {
  const s = props.ctx.segments[i]!;
  showTip(
    e,
    `${s.name} · <b>${fmt(s.tokens)}</b> tokens · ${pct(s.tokens / props.ctx.fixed)}${s.lines.length ? ` · ${plural(s.lines.length, "item")}` : ""}`,
  );
};
</script>

<template>
  <div
    class="winbar"
    role="group"
    aria-label="What every session starts with"
    @mouseleave="hideTip"
  >
    <button
      v-for="(s, i) in ctx.segments"
      :key="s.id"
      :aria-label="`${s.name}: ${fmt(s.tokens)} tokens`"
      :data-on="selected === s.id || undefined"
      :style="{ flexGrow: s.tokens, flexBasis: 0, background: `var(${s.color})` }"
      @mousemove="tipFor($event, i)"
      @click="emit('pick', s.id)"
    />
  </div>
</template>

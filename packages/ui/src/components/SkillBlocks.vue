<script setup lang="ts">
import { computed } from "vue";
import { fmt } from "../lib/report";
import { BUDGET, type SkillPack, packTotals } from "../lib/skills";
import { esc, hideTip, showTip } from "../lib/ui";

/** A pack's skills as blocks on a track that is the whole budget: the empty part is what's left of it. */
const props = defineProps<{ pack: SkillPack; height?: number; label?: boolean }>();
const listed = computed(() => props.pack.items.filter((s) => s.tokens > 0));
const totals = computed(() => packTotals(props.pack));
const tip = (name: string, tokens: number) => `${esc(name)} · ${fmt(tokens)} tokens`;
</script>

<template>
  <div class="sk-track" :style="{ '--h': `${height ?? 28}px` }">
    <div class="sk-fill" :style="{ width: `${(totals.tokens * 100) / BUDGET}%` }">
      <span
        v-for="skill in listed"
        :key="skill.name"
        class="sk-b"
        :style="{ flexGrow: skill.tokens }"
        @mouseenter="showTip($event, tip(skill.name, skill.tokens))"
        @mousemove="showTip($event, tip(skill.name, skill.tokens))"
        @mouseleave="hideTip"
        ><span class="sr">{{ skill.name }}, {{ fmt(skill.tokens) }} tokens</span></span
      >
    </div>
  </div>
  <div v-if="label" class="sk-scale num">
    <span><b>{{ fmt(totals.tokens) }}</b> of the {{ fmt(BUDGET) }}-token budget</span>
    <span v-if="totals.slashOnly" class="muted"
      >+{{ totals.slashOnly }} slash-only skills, 0 tokens</span
    >
  </div>
</template>

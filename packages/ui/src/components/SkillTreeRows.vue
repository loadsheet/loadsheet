<script setup lang="ts">
import { TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel } from "@ui-sdk/vue/tree";
import { fmt } from "../lib/report";
import { esc, hideTip, showTip } from "../lib/ui";

export interface FileNode {
  value: string;
  label: string;
  children?: FileNode[];
  /** Set on a skill's folder: what its listing costs. */
  skill?: { tokens: number; long: boolean };
}
defineProps<{ items: FileNode[] }>();
const tip = (tokens: number) =>
  esc(tokens ? `${fmt(tokens)} tokens every session` : "Slash-only, 0 tokens");
</script>

<template>
  <TreeItem v-for="n in items" :key="n.value" :value="n.value">
    <TreeItemLabel>
      <TreeItemIndicator v-if="n.children" />
      <span :class="{ mono: true, 'sk-skill': !!n.skill }">{{ n.label }}</span>
      <span
        v-if="n.skill"
        class="sk-tk num"
        :class="{ 'sk-tk-w': n.skill.long, 'sk-tk-0': !n.skill.tokens }"
        @mouseenter="showTip($event, tip(n.skill.tokens))"
        @mousemove="showTip($event, tip(n.skill.tokens))"
        @mouseleave="hideTip"
        >{{ fmt(n.skill.tokens) }}</span
      >
    </TreeItemLabel>
    <TreeGroup v-if="n.children">
      <SkillTreeRows :items="n.children" />
    </TreeGroup>
  </TreeItem>
</template>

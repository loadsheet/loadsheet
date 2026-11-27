<script setup lang="ts">
import { esc, hideTip, showTip } from "../lib/ui";

/** A term with a dotted underline that explains itself on hover or focus. */
const props = defineProps<{ text: string }>();
const show = (e: MouseEvent) => showTip(e, esc(props.text));
function focus(e: FocusEvent) {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  showTip({ clientX: r.right, clientY: r.bottom } as MouseEvent, esc(props.text));
}
</script>

<template>
  <span
    class="sk-tipt"
    tabindex="0"
    @mouseenter="show"
    @mousemove="show"
    @mouseleave="hideTip"
    @focus="focus"
    @blur="hideTip"
    ><slot
  /></span>
</template>

import { toast } from "@ui-sdk/vue/toast";
import { reactive } from "vue";

/** Copy confirmations are short, so their toast is too. */
export const say = (text: string) => toast(text, { duration: 1800 });
/** The key of whatever was copied last, for 1.5s, so its button can show a check. */
export const copied = reactive({ key: "" });
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
export function copy(text: string, said = "Copied", key = text) {
  navigator.clipboard?.writeText(text).catch(() => {});
  say(said);
  copied.key = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.key = ""), 1500);
}

export const tip = reactive({ html: "", x: 0, y: 0, on: false });
export function showTip(e: MouseEvent, html: string) {
  tip.html = html;
  tip.x = Math.min(e.clientX + 14, innerWidth - 250);
  tip.y = e.clientY + 16;
  tip.on = true;
}
export const hideTip = () => (tip.on = false);
/** Shows the tip under the element the event is on, for focus as well as hover. */
export function tipUnder(e: Event, html: string) {
  const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showTip({ clientX: at.left, clientY: at.bottom - 8 } as MouseEvent, html);
}

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

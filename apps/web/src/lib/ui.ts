import { reactive } from "vue";

/** One toast and one tooltip for the whole app. */
export const toast = reactive({ text: "", on: false });
let timer: ReturnType<typeof setTimeout> | undefined;
export function say(text: string) {
  toast.text = text;
  toast.on = true;
  clearTimeout(timer);
  timer = setTimeout(() => (toast.on = false), 1600);
}
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
  tip.x = Math.min(e.clientX + 14, innerWidth - 290);
  tip.y = e.clientY + 16;
  tip.on = true;
}
export const hideTip = () => (tip.on = false);

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

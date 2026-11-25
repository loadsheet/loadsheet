import { createLoadsheet } from "@loadsheet/ui";

/** The report on screen, per app and per server render. A shared report rides in the fragment of /report, which only the browser sees. */
export default defineNuxtPlugin({
  name: "loadsheet",
  async setup(nuxtApp) {
    const loadsheet = createLoadsheet({
      shareBase: () => `${location.origin}/`,
      shareForm: "path",
    });
    nuxtApp.vueApp.use(loadsheet);
    if (import.meta.server || !location.pathname.startsWith("/report")) return;
    const code = new URLSearchParams(location.hash.slice(1)).get("r");
    if (code) await loadsheet.openShareCode(code);
  },
});

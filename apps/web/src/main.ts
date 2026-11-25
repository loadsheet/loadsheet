import { Overlays, cliHome, createLoadsheet, inlinedReport } from "@loadsheet/ui";
import { createApp, h } from "vue";
import { RouterView, createRouter, createWebHashHistory } from "vue-router";
import { routes } from "./routes";
import "@loadsheet/ui/styles.css";
import "./page.css";

const theme = (() => {
  try {
    return localStorage.getItem("theme");
  } catch {
    return null;
  }
})();
document.documentElement.dataset.theme =
  theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const fromPage = inlinedReport(document);
const home = fromPage && cliHome(fromPage);
const loadsheet = createLoadsheet({
  report: fromPage,
  packs: home?.packs,
  // A page the CLI served or wrote is on 127.0.0.1 or on disk, where no one else can open it.
  shareBase: () => (fromPage ? "https://loadsheet.dev/" : `${location.origin}${location.pathname}`),
});

// Hash history: the same file works from disk, from `loadsheet --ui` and on a static host.
const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: routes(home?.route),
});

// A shared link carries its report in the URL; mount once it is read, so the first paint is that report.
const code = new URLSearchParams(location.hash.split("?")[1] ?? "").get("r");
void (code && !fromPage ? loadsheet.openShareCode(code) : Promise.resolve()).then(() =>
  createApp({ render: () => [h(RouterView), h(Overlays)] })
    .use(loadsheet)
    .use(router)
    .mount("#app"),
);

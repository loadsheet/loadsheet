import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import Landing from "./pages/Landing.vue";
import ReportShell from "./pages/ReportShell.vue";
import Report from "./pages/Report.vue";
import List from "./pages/List.vue";
import Fixes from "./pages/Fixes.vue";
import Pack from "./pages/Pack.vue";
import NotFound from "./pages/NotFound.vue";
import { home, ready } from "./lib/report";
import "@vite-hub/kit/styles/tokens.css";
import "@vite-hub/kit/styles/default.css";
import "./styles/tokens.css";
import "./styles/app.css";

const theme = (() => {
  try {
    return localStorage.getItem("theme");
  } catch {
    return null;
  }
})();
document.documentElement.dataset.theme =
  theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

// Hash history: the same file works from disk, from `loadsheet --ui` and on a static host.
const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    // A page `loadsheet --ui` or `loadsheet build` wrote opens on its own report, not the landing.
    home ? { path: "/", redirect: home } : { path: "/", component: Landing },
    {
      path: "/report",
      component: ReportShell,
      children: [
        { path: "", component: Report },
        { path: "list", component: List },
        { path: "fixes", component: Fixes },
        // Links from before the map: Overview and Map merged into the Report, Skills into the List.
        { path: "overview", redirect: (to) => ({ path: "/report", query: to.query }) },
        { path: "map", redirect: (to) => ({ path: "/report", query: to.query }) },
        { path: "skills", redirect: (to) => ({ path: "/report/list", query: to.query }) },
      ],
    },
    // owner/repo, or owner/repo/dir for a pack that lives in a folder of a bigger repository.
    { path: "/pack/:slug(.+)", component: Pack },
    { path: "/:rest(.*)*", component: NotFound },
  ],
});

// A shared link carries its report in the URL; mount once it is read, so the first paint is that report.
void ready.then(() => createApp(App).use(router).mount("#app"));

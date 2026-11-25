import { createApp } from "vue";
import { type RouteLocation, createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import Landing from "./pages/Landing.vue";
import ReportShell from "./pages/ReportShell.vue";
import Report from "./pages/Report.vue";
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
        { path: "fixes", component: Fixes },
        // Links from older pages: Overview and Map are the Report, the List and Skills its table.
        { path: "overview", redirect: (to) => ({ path: "/report", query: to.query }) },
        { path: "map", redirect: (to) => ({ path: "/report", query: to.query }) },
        ...["list", "skills"].map((path) => ({
          path,
          redirect: (to: RouteLocation) => ({
            path: "/report",
            query: { ...to.query, view: "table" },
          }),
        })),
      ],
    },
    // owner/repo, or owner/repo/dir for a pack that lives in a folder of a bigger repository.
    { path: "/pack/:slug(.+)", component: Pack },
    { path: "/:rest(.*)*", component: NotFound },
  ],
});

// A shared link carries its report in the URL; mount once it is read, so the first paint is that report.
void ready.then(() => createApp(App).use(router).mount("#app"));

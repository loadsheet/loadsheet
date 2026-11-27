import { Fixes, Landing, NotFound, Pack, Report, ReportShell, Usage } from "@loadsheet/ui";
import type { RouteLocation, RouteLocationRaw, RouteRecordRaw } from "vue-router";

/**
  The page's hash routes, under the names `@loadsheet/ui` links by. `home` is where `/` goes when the CLI inlined a
  report: the user's own report, or the pack it read.
*/
export function routes(home?: RouteLocationRaw): RouteRecordRaw[] {
  return [
    home
      ? { path: "/", name: "home", redirect: home }
      : { path: "/", name: "home", component: Landing },
    {
      path: "/report",
      component: ReportShell,
      children: [
        { path: "", name: "report", component: Report },
        { path: "fixes", name: "fixes", component: Fixes },
        { path: "usage", name: "usage", component: Usage },
        // Links from older pages: Overview and Map are the Report, the List and Skills its table.
        { path: "overview", redirect: (to) => ({ name: "report", query: to.query }) },
        { path: "map", redirect: (to) => ({ name: "report", query: to.query }) },
        ...["list", "skills"].map((path) => ({
          path,
          redirect: (to: RouteLocation) => ({
            name: "report",
            query: { ...to.query, view: "table" },
          }),
        })),
      ],
    },
    // owner/repo, or owner/repo/dir for a pack that lives in a folder of a bigger repository.
    { path: "/pack/:slug+", name: "pack", component: Pack },
    { path: "/:rest(.*)*", component: NotFound },
  ];
}

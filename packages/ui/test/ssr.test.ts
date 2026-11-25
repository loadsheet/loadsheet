import { createSSRApp, h } from "vue";
import { RouterView, createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { firstSentence } from "../src/lib/context";
import {
  Fixes,
  Landing,
  NotFound,
  Overlays,
  Pack,
  Report,
  ReportShell,
  bundledPacks,
  createLoadsheet,
} from "../src/index";

// The views as Nuxt will render them on its server: no DOM, state from the installed loadsheet, links by name.
// `pack` takes the props a host that reads packs on its server passes the pack page.
async function render(url: string, pack?: Record<string, unknown>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: Landing },
      {
        path: "/report",
        component: ReportShell,
        children: [
          { path: "", name: "report", component: Report },
          { path: "fixes", name: "fixes", component: Fixes },
        ],
      },
      { path: "/pack/:slug+", name: "pack", component: Pack, props: () => pack ?? {} },
      { path: "/:rest(.*)*", component: NotFound },
    ],
  });
  const app = createSSRApp({ render: () => [h(RouterView), h(Overlays)] })
    .use(createLoadsheet({ shareBase: () => "https://loadsheet.dev/" }))
    .use(router);
  await router.push(url);
  await router.isReady();
  return renderToString(app);
}

const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

describe("the views on a server", () => {
  it("run where there is no document", () => {
    expect(typeof document).toBe("undefined");
  });

  it.each([
    ["/", "See what your coding agent reads before you type."],
    ["/report", "used before you type"],
    ["/report?view=table", "Of window"],
    ["/report/fixes", "loadsheet never edits your files."],
    ["/pack/mattpocock/skills", "Adds 566 tokens to every session"],
    ["/pack/cursor/plugins/pstack", "principle-guard-the-context-window"],
    ["/nowhere", "This link doesn’t hold a report"],
  ])("render %s", async (url, text) => {
    const html = await render(url);
    expect(html).toContain(text);
  });

  it("render a pack a host passes in, each skill with its description", async () => {
    const pack = bundledPacks["mattpocock/skills"]!;
    const html = await render("/pack/someone/else", { pack });
    for (const l of pack.report.sheet[0]!.lines.filter((l) => l.description)) {
      expect(html).toContain(l.ref.name);
      expect(html).toContain(escape(firstSentence(l.description!)));
    }
  });

  it.each([
    [{ pending: true }, "Reading someone/else"],
    [{ error: { code: "not-found", message: "" } }, "GitHub has no someone/else"],
    [{ error: { code: "rate-limited", message: "" } }, "Try again"],
  ])("render a pack's state %j", async (props, text) => {
    expect(await render("/pack/someone/else", props)).toContain(text);
  });

  it("link to the pack page by name, one slug segment per folder", async () => {
    const html = await render("/");
    expect(html).toContain('href="/pack/mattpocock/skills"');
    expect(html).not.toContain("%2F");
  });
});

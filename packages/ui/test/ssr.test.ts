import type { Report as ReportData } from "@loadsheet/schema";
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
  Usage,
  bundledPacks,
  createLoadsheet,
  exampleReport,
} from "../src/index";

// The views as Nuxt will render them on its server: no DOM, state from the installed loadsheet, links by name.
// `pack` takes the props a host that reads packs on its server passes the pack page.
async function render(url: string, pack?: Record<string, unknown>, report?: ReportData) {
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
          { path: "usage", name: "usage", component: Usage },
        ],
      },
      { path: "/pack/:slug+", name: "pack", component: Pack, props: () => pack ?? {} },
      { path: "/:rest(.*)*", component: NotFound },
    ],
  });
  const app = createSSRApp({ render: () => [h(RouterView), h(Overlays)] })
    .use(createLoadsheet({ report, shareBase: () => "https://loadsheet.dev/" }))
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

  const source = exampleReport.sheet.find((sheet) => sheet.harness === "claude-code")!;

  it("keeps inventory-only harnesses in the switch but omits empty alternatives", async () => {
    const report = {
      ...exampleReport,
      coverage: [],
      sheet: [
        source,
        { ...source, harness: "opencode", sessions: 0 },
        { ...source, harness: "cursor", sessions: 0, lines: [] },
      ],
    };
    const html = await render("/report", undefined, report);
    expect(html).toMatch(/aria-label="Harness"/);
    expect(html).toContain("OpenCode");
    expect(html).not.toContain("Cursor");
    expect(await render("/report?h=cursor", undefined, report)).toContain("Cursor");
  });

  it("keeps the actual limit when startup goes over it", async () => {
    const report = {
      ...exampleReport,
      sheet: [
        {
          ...source,
          fixedTokens: { value: 215_000, basis: "measured" as const },
          contextWindow: 200_000,
        },
      ],
    };
    const html = await render("/report?view=table", undefined, report);
    expect(html).toContain("200k chat limit");
    expect(html).toContain("108%");
    expect(html).toContain('Free for your chat<small class="num">0 tokens');
  });

  it("reports setup cost without claiming headroom when built-ins are unmeasured", async () => {
    const report = { ...exampleReport, sheet: [{ ...source, fixedTokens: undefined }] };
    const html = await render("/report?view=table", undefined, report);
    expect(html).toContain("tokens</span> from your setup");
    expect(html).toContain('Free for your chat<small class="num">Unknown');
    expect(html).toContain("Free for your chat is unknown");
    expect(html).not.toContain("free for your chat.");
  });

  it.each([200_000, 210_000])("reports zero headroom with %i setup tokens", async (tokens) => {
    const line = source.lines.find((line) => line.scope)!;
    const report = {
      ...exampleReport,
      sheet: [
        {
          ...source,
          fixedTokens: undefined,
          contextWindow: 200_000,
          lines: [{ ...line, tokens: { ...line.tokens, value: tokens } }],
        },
      ],
    };
    const html = await render("/report?view=table", undefined, report);
    expect(html).toContain("tokens</span> from your setup");
    expect(html).toContain("Your setup alone uses");
    expect(html).toContain('Free for your chat<small class="num">0 tokens');
    expect(html).toContain('class="sw free"></span>Free</td><td class="r num">0</td>');
  });

  it("associates the token definition with the help button", async () => {
    const html = await render("/report");
    const id = html.match(/aria-label="What is a token\?" aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}" hidden>A token is a small piece of text`);
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

import { usageTotals } from "@loadsheet/core";
import { shareableReport, type Report as ReportData, type Usage } from "@loadsheet/schema";
import { createSSRApp, h } from "vue";
import { RouterView, createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { usageRows } from "../src/lib/usage";
import {
  Fixes,
  Report,
  ReportShell,
  Usage as UsageView,
  createLoadsheet,
  exampleReport,
} from "../src/index";

// The usage page as Nuxt renders it on its server, under the report's routes.
async function render(url: string, report: ReportData = exampleReport, shared = false) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { render: () => null } },
      {
        path: "/report",
        component: ReportShell,
        children: [
          { path: "", name: "report", component: Report },
          { path: "fixes", name: "fixes", component: Fixes },
          { path: "usage", name: "usage", component: UsageView },
        ],
      },
    ],
  });
  const loadsheet = createLoadsheet({ report, shareBase: () => "https://loadsheet.dev/" });
  loadsheet.shared.value = shared;
  const app = createSSRApp({ render: () => h(RouterView) })
    .use(loadsheet)
    .use(router);
  await router.push(url);
  await router.isReady();
  return renderToString(app);
}

const names = (html: string) =>
  [...html.matchAll(/<span class="nm">([^<]*)<\/span>/g)].map((match) => match[1]);
const labels = (rows: ReturnType<typeof usageRows>) =>
  rows.map((row) => (row.t === "more" ? `+${row.n}` : row.label));

describe("the usage page", () => {
  it("sums every harness, then lists one row per org, as loadsheet usage counts them", async () => {
    const html = await render("/report/usage");
    expect(html).toContain("22 sessions, 69.1M tokens");
    expect(html).toContain("By org and project, last 30 days, on 2 of 3 machines.");
    expect(names(html)).toEqual(["All harnesses", "acme", "no repository"]);
    expect(html).toContain("plus 22 subagent sessions");
    // acme: 14 + 5 sessions, 3 + 1 compacted, 68.6M of 69.1M tokens.
    expect(html.replace(/<!--.*?-->/g, "")).toMatch(
      /acme<\/span><\/td><td class="r num">19<\/td><td class="r num"><span class="cn">4<\/span><span class="pc muted">21%<\/span><\/td><td class="r num">68.6M<\/td><td class="r num muted">99%<\/td>/,
    );
    // Rows that open say whether they are; "no repository" holds no projects to open onto.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });

  it("leaves the harness switch out of its header, since it counts every harness", async () => {
    expect(await render("/report")).toMatch(/aria-label="Harness"/);
    expect(await render("/report/usage")).not.toMatch(/aria-label="Harness"/);
  });

  it("tells a shared report that usage stays on the user's machines", async () => {
    const html = await render("/report/usage", shareableReport(exampleReport), true);
    expect(html).toContain("Usage stays on your machines");
    expect(html).toContain("npx loadsheet usage");
    expect(html).not.toContain("acme");
  });

  it("says so when no session counted anything", async () => {
    const html = await render("/report/usage", {
      ...exampleReport,
      usage: { sessions: [], tokens: [] },
    });
    expect(html).toContain("Nothing to count yet");
  });

  it("is linked from the report only when the report has usage", async () => {
    expect(await render("/report")).toContain('href="/report/usage"');
    const shared = await render("/report", shareableReport(exampleReport), true);
    expect(shared).toContain("5 fixes");
    expect(shared).not.toContain('href="/report/usage"');
  });
});

describe("the usage table's rows", () => {
  const totals = usageTotals(exampleReport.usage);

  it("open an org onto its projects and close it again", () => {
    const open = new Set<string>();
    expect(labels(usageRows(totals, open, new Set()))).toEqual([
      "All harnesses",
      "acme",
      "no repository",
    ]);
    open.add("org:acme");
    const rows = usageRows(totals, open, new Set());
    expect(labels(rows)).toEqual([
      "All harnesses",
      "acme",
      "acme/web",
      "acme/api",
      "no repository",
    ]);
    expect(rows.find((row) => row.key === "org:acme")).toMatchObject({ open: true });
    open.delete("org:acme");
    expect(labels(usageRows(totals, open, new Set()))).toHaveLength(3);
  });

  it("open the total onto each harness", () => {
    expect(labels(usageRows(totals, new Set(["all"]), new Set()))).toEqual([
      "All harnesses",
      "Claude Code",
      "Codex",
      "acme",
      "no repository",
    ]);
  });

  it("name the one harness instead of a total that opens onto it", () => {
    const one = usageTotals({
      ...exampleReport.usage!,
      sessions: exampleReport.usage!.sessions.filter((cell) => cell.harness === "claude-code"),
      tokens: exampleReport.usage!.tokens.filter((cell) => cell.harness === "claude-code"),
    });
    expect(usageRows(one, new Set(["all"]), new Set())[0]).toMatchObject({
      label: "Claude Code",
      canOpen: false,
      open: false,
    });
  });

  it("fold an org's projects past the top five behind one row", () => {
    const usage: Usage = {
      sessions: [],
      tokens: Array.from({ length: 8 }, (_, index) => ({
        ...exampleReport.usage!.tokens[0]!,
        project: `acme/p${index}`,
        input: 1000 * (8 - index),
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })),
    };
    const many = usageTotals(usage);
    const open = new Set(["org:acme"]);
    const folded = usageRows(many, open, new Set());
    expect(labels(folded).slice(1)).toEqual([
      "acme",
      "acme/p0",
      "acme/p1",
      "acme/p2",
      "acme/p3",
      "acme/p4",
      "+3",
    ]);
    expect(folded.at(-1)).toMatchObject({ t: "more", tokens: 6000 });
    expect(usageRows(many, open, new Set(["org:acme"]))).toHaveLength(10);
  });
});

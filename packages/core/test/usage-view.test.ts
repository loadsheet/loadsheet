import { readFileSync } from "node:fs";
import {
  parseReport,
  type Finding,
  type Report,
  type UsageSessionCell,
  type UsageTokenCell,
} from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import { renderUsage, sumUsage, unreadUsageStores, usageTotals } from "../src/index.ts";

const fleet = parseReport(
  JSON.parse(
    readFileSync(new URL("../../../examples/report.example.json", import.meta.url), "utf8"),
  ),
);

const sessions = (
  project: string,
  count: number,
  compacted = 0,
  thread: "main" | "subagent" = "main",
): UsageSessionCell => ({
  day: "2026-11-20",
  harness: "claude-code",
  via: "cli",
  project,
  thread,
  sessions: count,
  compacted,
  compactions: compacted,
  manualCompactions: 0,
});

const tokens = (project: string, input: number, harness = "claude-code"): UsageTokenCell => ({
  day: "2026-11-20",
  harness,
  via: "cli",
  project,
  thread: "main",
  model: "m",
  requests: 1,
  input,
  output: 10,
  reasoning: 0,
  cacheRead: 100,
  cacheWrite: 50,
  cacheWrite5m: 50,
  cacheWrite1h: 0,
  cacheRewrite: 0,
});

/** The example Report with its usage and findings replaced. */
const withUsage = (usage: Report["usage"], findings: Finding[] = []): Report => ({
  ...fleet,
  findings,
  ...(usage ? { usage } : { usage: undefined }),
});

describe("usageTotals", () => {
  it("folds every folder that is no repository into one row, and shares sum to 100", () => {
    const totals = usageTotals({
      sessions: [
        sessions("acme/app", 2, 1),
        sessions("acme/site", 1),
        sessions("~/notes", 1),
        sessions("/srv/tools", 1),
        sessions("unknown", 1),
        sessions("acme/app", 3, 0, "subagent"),
      ],
      tokens: [
        tokens("acme/app", 840),
        tokens("acme/site", 140),
        tokens("~/notes", 40),
        tokens("/srv/tools", 40),
        tokens("unknown", 40),
        tokens("other/x", 40, "codex"),
      ],
    });
    // Each token cell adds 10 output, 100 cache read and 50 cache write to its input.
    expect(totals.all).toMatchObject({ sessions: 6, compacted: 1, tokens: 2100 });
    expect(totals.subagentSessions).toBe(3);
    // 61.9%, 28.6% and 9.5%: the two largest remainders round up.
    expect(totals.orgs.map((row) => [row.name, row.sessions, row.tokens, row.share])).toEqual([
      ["acme", 3, 1300, 62],
      ["no repository", 3, 600, 29],
      ["other", 0, 200, 9],
    ]);
    for (const rows of [totals.orgs, totals.projects, totals.harnesses])
      expect(rows.reduce((n, row) => n + row.share, 0)).toBe(100);
    expect(totals.projects.map((row) => row.name)).toEqual([
      "acme/app",
      "no repository",
      "acme/site",
      "other/x",
    ]);
  });

  it("totals include unsplit", () => {
    const unsplit = { ...tokens("other/x", 0, "codex"), output: 0, cacheRead: 0, cacheWrite: 0 };
    const usage = {
      sessions: [],
      tokens: [tokens("acme/app", 40), { ...unsplit, cacheWrite5m: 0, unsplit: 800 }],
    };
    const totals = usageTotals(usage);
    expect(totals.all.tokens).toBe(1000);
    expect(totals.harnesses.map((row) => [row.name, row.tokens, row.share])).toEqual([
      ["codex", 800, 80],
      ["claude-code", 200, 20],
    ]);
    // Summed over machines, the counter adds up like the others.
    expect(sumUsage([usage, usage])!.tokens.map((cell) => cell.unsplit)).toEqual([undefined, 1600]);
  });

  it("counts nothing for a Report without usage", () => {
    expect(usageTotals(undefined).all).toMatchObject({ sessions: 0, tokens: 0 });
  });
});

describe("renderUsage", () => {
  it("lists the top 10 projects, then one line for the rest", () => {
    const projects = Array.from({ length: 13 }, (_, i) => `org-${i % 3}/repo-${i}`);
    const text = renderUsage(
      withUsage({
        sessions: projects.map((project) => sessions(project, 1)),
        tokens: projects.map((project, i) => tokens(project, 1000 * (20 - i))),
      }),
    );
    const block = text.slice(text.indexOf("Projects"), text.indexOf("Settings"));
    expect(block.trim().split("\n")).toHaveLength(12);
    expect(block).toContain("org-0/repo-0");
    expect(block).not.toContain("repo-10");
    expect(block).toMatch(/\+ 3 more projects +3 +0 +0% /u);
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("says where the prompt cache's lifetime comes from, and lists no fixes when none concern usage", () => {
    const text = renderUsage(withUsage({ sessions: [sessions("acme/app", 1)], tokens: [] }));
    expect(text).toContain("Settings\n  Claude Code  prompt cache      5 minutes\n");
    expect(text).toContain("transcripts kept  30 days\n");
    expect(text).not.toContain("Fixes");
    expect(text).toContain("on 2 machines");
    expect(text).toContain("not read: mini");
  });

  it("says on which day 5-minute cache writes stopped", () => {
    const day = (date: string, write5m: number, write1h: number): UsageTokenCell => ({
      ...tokens("acme/app", 1),
      day: date,
      cacheWrite: write5m + write1h,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
    });
    const text = renderUsage(
      withUsage({
        sessions: [sessions("acme/app", 1)],
        tokens: [
          day("2026-11-17", 2e6, 0),
          day("2026-11-18", 0, 2e6),
          day("2026-11-19", 0, 2e6),
          day("2026-11-20", 0, 2e6),
        ],
      }),
    );
    expect(text).toMatch(/prompt cache +5 minutes\n +5-minute writes stopped 2026-11-18\n/);
  });

  it("lists the findings that concern usage with their fixes", () => {
    const finding = {
      id: "cache-ttl:claude-code",
      rule: "cache-ttl",
      level: "warn",
      where: [{ machine: "laptop", harness: "claude-code" }],
      evidence: {},
      fixes: [
        {
          machine: "laptop",
          action: "set",
          path: "~/.claude/settings.json",
          set: { key: "promptCacheTtl", value: "1h" },
        },
      ],
    } as unknown as Finding;
    const text = renderUsage(
      withUsage({ sessions: [sessions("acme/app", 1)], tokens: [] }, [finding]),
    );
    expect(text).toContain(
      'Fixes\n  fix     consider keeping the prompt cache 1 hour\n          ~/.claude/settings.json  promptCacheTtl = "1h"\n',
    );
    expect(text).toContain("Apply fixes    ask your agent to run npx loadsheet --json --fleet");
  });

  it("usage view prints the range from the cells", () => {
    const text = renderUsage(
      withUsage({
        sessions: [{ ...sessions("acme/app", 1), day: "2026-08-03" }, sessions("acme/app", 1)],
        tokens: [{ ...tokens("acme/app", 1000), day: "2026-11-21" }],
      }),
    );
    expect(text).toContain(
      "\nSessions, compactions and tokens, 2026-08-03 to 2026-11-21, on 2 machines.\n",
    );
    expect(text).not.toContain("last 30 days");
    expect(renderUsage(withUsage({ sessions: [sessions("acme/app", 1)], tokens: [] }))).toContain(
      "Sessions, compactions and tokens, on 2026-11-20, on 2 machines.",
    );
    // Bounded by `loadsheet usage --days`, an empty history says so.
    const bounded = withUsage(undefined);
    bounded.config = { ...bounded.config, usageWindow: 7 };
    expect(renderUsage(bounded)).toContain("No session in the last 7 days on 2 machines said");
    expect(renderUsage(withUsage(undefined))).toContain("No session on 2 machines said");
  });

  it("says where a harness's older days came from and what they lack", () => {
    const report = withUsage({
      sessions: [sessions("acme/app", 1)],
      tokens: [tokens("acme/app", 1000), tokens("acme/app", 1000, "codex")],
    });
    const backfill = (store: string) => [
      { store, firstDay: "2026-08-01", lastDay: "2026-10-01", sessions: 3 },
    ];
    report.coverage = report.coverage.map((row) =>
      row.harness === "claude-code"
        ? { ...row, backfill: backfill("statev2.sqlite") }
        : row.harness === "codex"
          ? { ...row, backfill: backfill("state_5.sqlite") }
          : row,
    );
    const text = renderUsage(report);
    expect(text).toMatch(/transcripts kept  30 days; older days: T3 Code, no subagents\n/u);
    expect(text).toMatch(
      /auto-compact +Codex's default limit\n {33}older days: state db, no split or compactions\n/u,
    );
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("says there is nothing to count without usage", () => {
    expect(renderUsage(withUsage(undefined))).toContain("nothing to count yet");
  });

  it("distinguishes unread stores from empty and complete histories", () => {
    const coverage = [{ ...fleet.coverage[0]!, unread: ["opencode.db"] }];
    for (const usage of [undefined, { sessions: [sessions("acme/app", 1)], tokens: [] }]) {
      const text = renderUsage({ ...withUsage(usage), coverage });
      expect(text).toContain("Usage is incomplete");
      expect(text).toContain("opencode.db");
      expect(text).not.toContain("nothing to count");
    }
  });

  it("warns only about unread stores that could contribute to the selected entrypoints", () => {
    const report = withUsage(undefined);
    const row = fleet.coverage[0]!;
    report.coverage = [
      { ...row, harness: "opencode", unread: ["opencode.db"] },
      { ...row, harness: "t3-code", unread: ["statev2.sqlite"] },
    ];
    report.config = { ...report.config, via: { include: [], exclude: ["t3-code"] } };
    expect(unreadUsageStores(report)).toEqual(["opencode.db"]);
    report.config.via = { include: ["t3-code"], exclude: [] };
    expect(unreadUsageStores(report)).toEqual(["statev2.sqlite"]);
    report.config.via.exclude = ["t3-code"];
    expect(unreadUsageStores(report)).toEqual([]);
    expect(renderUsage(report)).toContain("nothing to count yet");
    report.coverage[1]!.unread!.push("unknown.sqlite");
    expect(unreadUsageStores(report)).toEqual(["unknown.sqlite"]);
  });
});

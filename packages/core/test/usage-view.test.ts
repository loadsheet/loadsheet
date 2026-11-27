import { readFileSync } from "node:fs";
import {
  parseReport,
  type Finding,
  type Report,
  type UsageSessionCell,
  type UsageTokenCell,
} from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import { renderUsage, usageTotals } from "../src/index.ts";

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
      'Fixes\n  fix     keep the prompt cache 1 hour\n          ~/.claude/settings.json  promptCacheTtl = "1h"\n',
    );
    expect(text).toContain("Apply fixes    ask your agent to run npx loadsheet --json --fleet");
  });

  it("says there is nothing to count without usage", () => {
    expect(renderUsage(withUsage(undefined))).toContain("nothing to count yet");
  });
});

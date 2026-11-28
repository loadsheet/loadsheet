import {
  parseReport,
  resolveConfig,
  RULES,
  type Config,
  type Coverage,
  type Grade,
  type Scan,
  type Settings,
  type Signal,
  type UsageSessionCell,
  type UsageTokenCell,
} from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import { buildReport, promptCacheDays, renderSummary, renderText } from "../src/index.ts";

const EXACT: Record<Signal, Grade> = {
  listing: "exact",
  modelUse: "exact",
  userUse: "exact",
  instructions: "exact",
  mcp: "exact",
  tokens: "exact",
  usage: "exact",
  cacheTtl: "exact",
};
const NOW = new Date("2026-11-24T12:00:00.000Z");
const FIRST = "2026-10-26";
const LAST = "2026-11-24";
const M = 1_000_000;

/** The day `n` days before the window's last. */
const ago = (n: number) =>
  new Date(Date.parse(`${LAST}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const tokens = (
  day: string,
  cacheWrite5m: number,
  cacheWrite1h: number,
  extra: Partial<UsageTokenCell> = {},
): UsageTokenCell => ({
  day,
  harness: "claude-code",
  via: "cli",
  project: "acme/app",
  thread: "main",
  model: "claude-opus-5-5",
  requests: 10,
  input: 1000,
  output: 1000,
  reasoning: 0,
  cacheRead: 5 * M,
  cacheWrite: cacheWrite5m + cacheWrite1h,
  cacheWrite5m,
  cacheWrite1h,
  cacheRewrite: Math.round(cacheWrite5m / 10),
  ...extra,
});

const sessions = (
  day: string,
  count: number,
  extra: Partial<UsageSessionCell> = {},
): UsageSessionCell => ({
  day,
  harness: "claude-code",
  via: "cli",
  project: "acme/app",
  thread: "main",
  sessions: count,
  compacted: 0,
  compactions: 0,
  manualCompactions: 0,
  ...extra,
});

const coverage = (settings?: Settings, extra: Partial<Coverage> = {}): Coverage => ({
  machine: "laptop",
  harness: "claude-code",
  installed: true,
  sessions: 30,
  versions: [],
  firstDay: FIRST,
  lastDay: LAST,
  signals: EXACT,
  ...(settings ? { settings: { settingsPath: "~/.claude/settings.json", ...settings } } : {}),
  ...extra,
});

const scan = (
  cells: UsageTokenCell[],
  settings?: Settings,
  parts: Partial<Scan> = {},
  machine = "laptop",
): Scan => ({
  schema: 1,
  tool: "loadsheet@0.0.1",
  machine,
  scannedAt: NOW.toISOString(),
  window: [FIRST, LAST],
  coverage: [coverage(settings, { machine })],
  items: [],
  sessions: [
    { day: FIRST, harness: "claude-code", via: "cli", sessions: 1, fixedTokens: 0, measured: 0 },
    { day: LAST, harness: "claude-code", via: "cli", sessions: 29, fixedTokens: 0, measured: 0 },
  ],
  cells: [],
  usage: { sessions: [sessions(LAST, 30)], tokens: cells },
  ...parts,
});

const only = (rule: string): Config => ({
  rules: Object.fromEntries(RULES.filter((id) => id !== rule).map((id) => [id, false])),
});

const report = (scans: Scan[], rule: string, config: Config = {}) => {
  const built = buildReport({
    scans,
    config: resolveConfig({ ...only(rule), ...config }),
    now: NOW,
    tool: "loadsheet@0.0.1",
  });
  expect(parseReport(JSON.parse(JSON.stringify(built)))).toEqual(built);
  return built;
};

/** Days `from` to `to` ago, each with one token cell. */
const days = (from: number, to: number, cell: (day: string) => UsageTokenCell) => {
  const out = [];
  for (let n = from; n >= to; n--) out.push(cell(ago(n)));
  return out;
};

/** Maxi's case: 5-minute writes until a week ago, 1-hour ones since. */
const switched = [
  ...days(20, 7, (day) => tokens(day, 3 * M, M / 2)),
  ...days(6, 0, (day) => tokens(day, M / 10, 2 * M)),
];

describe("promptCacheDays", () => {
  it("counts a day with half its writes for 5 minutes as a 5-minute day", () => {
    const [cache] = promptCacheDays({ sessions: [], tokens: [tokens(LAST, M / 2, M / 2)] });
    expect(cache!.days).toEqual([
      {
        day: LAST,
        cacheWrite5m: M / 2,
        cacheWrite1h: M / 2,
        cacheRewrite: M / 20,
        fiveMinute: true,
      },
    ]);
    const [under] = promptCacheDays({
      sessions: [],
      tokens: [tokens(LAST, M / 2 - 1, M / 2 + 1)],
    });
    expect(under!.days[0]!.fiveMinute).toBe(false);
  });

  it("judges only days with 1M main-conversation cache writes", () => {
    const [cache] = promptCacheDays({
      sessions: [],
      tokens: [
        tokens(ago(3), M - 1, 0),
        tokens(ago(2), M, 0),
        tokens(ago(1), 0, 0),
        tokens(LAST, 2 * M, 0, { thread: "subagent" }),
        tokens(LAST, 2 * M, 0, { harness: "codex" }),
      ],
    });
    expect(cache!.days.map((day) => day.day)).toEqual([ago(2)]);
    expect(cache!.recent).toBeUndefined();
  });

  it("calls the recent days 5m or 1h only when the last 3 agree", () => {
    const of = (cells: UsageTokenCell[]) => promptCacheDays({ sessions: [], tokens: cells })[0]!;
    expect(of(days(2, 0, (day) => tokens(day, 2 * M, 0))).recent).toBe("5m");
    expect(of(days(1, 0, (day) => tokens(day, 2 * M, 0))).recent).toBeUndefined();
    expect(
      of([...days(2, 1, (day) => tokens(day, 2 * M, 0)), tokens(LAST, 0, 2 * M)]).recent,
    ).toBeUndefined();
    expect(of(switched)).toMatchObject({ recent: "1h", stopped: ago(6) });
    expect(of(days(2, 0, (day) => tokens(day, 0, 2 * M)))).not.toHaveProperty("stopped");
  });

  it("splits entrypoints, or sums them", () => {
    const cells = [
      ...days(2, 0, (day) => tokens(day, 2 * M, 0)),
      ...days(2, 0, (day) => tokens(day, 0, 2 * M, { via: "t3-code" })),
    ];
    const split = promptCacheDays({ sessions: [], tokens: cells });
    expect(split.map(({ via, recent }) => [via, recent])).toEqual([
      ["cli", "5m"],
      ["t3-code", "1h"],
    ]);
    const [all] = promptCacheDays({ sessions: [], tokens: cells }, { byVia: false });
    expect(all).toMatchObject({ via: "all" });
    expect(all!.days.every((day) => day.fiveMinute)).toBe(true);
  });
});

describe("cache-ttl", () => {
  const fiveMinutes = [
    ...days(10, 3, (day) => tokens(day, 0, 2 * M)),
    ...days(2, 0, (day) => tokens(day, 3 * M, M)),
  ];

  it("finds nothing once recent days write 1-hour caches, though older days wrote 5-minute ones", () => {
    const built = report(
      [scan(switched, { cacheTtl: "1h", cacheTtlFrom: "settings.promptCacheTtl" })],
      "cache-ttl",
    );
    expect(built.findings).toEqual([]);
    expect(built.skipped).toEqual([]);
  });

  it("sets promptCacheTtl to 1h, with the rewrites of the 5-minute days as evidence", () => {
    const built = report([scan(fiveMinutes, { retentionDays: 30 })], "cache-ttl");
    expect(built.findings).toEqual([
      {
        id: "cache-ttl:claude-code:cli",
        rule: "cache-ttl",
        level: "fix",
        via: "cli",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { days: 3, cacheWrite: 12 * M, cacheWrite5m: 9 * M, cacheRewrite: (9 * M) / 10 },
        fixes: [
          {
            machine: "laptop",
            action: "set",
            path: "~/.claude/settings.json",
            set: { key: "promptCacheTtl", value: "1h" },
          },
        ],
      },
    ]);
    expect(renderText(built)).toContain(
      "75% 5-min writes in 3 days; 900,000 tokens might be reused",
    );
    const detail = renderSummary(built, { harness: "claude-code" });
    expect(detail).toContain("keep the prompt cache 1 hour");
    expect(detail).toContain('~/.claude/settings.json  promptCacheTtl = "1h"');
    expect(renderSummary(built)).not.toContain("prompt cache");
  });

  it("turns FORCE_PROMPT_CACHING_5M off when it set the lifetime", () => {
    const [finding] = report(
      [scan(fiveMinutes, { cacheTtl: "5m", cacheTtlFrom: "env.FORCE_PROMPT_CACHING_5M" })],
      "cache-ttl",
    ).findings;
    expect(finding!.fixes.map((fix) => fix.set)).toEqual([
      { key: "env.FORCE_PROMPT_CACHING_5M", value: "0" },
      { key: "promptCacheTtl", value: "1h" },
    ]);
    const [variable] = report(
      [
        scan(fiveMinutes, {
          cacheTtl: "5m",
          cacheTtlFrom: "settings.env.CLAUDE_CODE_PROMPT_CACHE_TTL",
        }),
      ],
      "cache-ttl",
    ).findings;
    expect(variable!.fixes.map((fix) => fix.set)).toEqual([
      { key: "env.CLAUDE_CODE_PROMPT_CACHE_TTL", value: "1h" },
    ]);
  });

  it("has no fix when the settings already ask for 1 hour, and says where they do", () => {
    const built = report(
      [scan(fiveMinutes, { cacheTtl: "1h", cacheTtlFrom: "settings.promptCacheTtl" })],
      "cache-ttl",
    );
    expect(built.findings).toMatchObject([{ id: "cache-ttl:claude-code:cli", fixes: [] }]);
    const text = renderText(built);
    expect(text).toContain("(settings.promptCacheTtl)");
    expect(text).toContain("for cli sessions");
    expect(text).toContain("anthropics/claude-code#101685");
    expect(renderSummary(built)).not.toContain("Needs your OK");
  });

  it("judges each entrypoint on its own", () => {
    const built = report(
      [
        scan([
          ...days(2, 0, (day) => tokens(day, 2 * M, 0, { via: "t3-code" })),
          ...days(2, 0, (day) => tokens(day, 0, 2 * M)),
        ]),
      ],
      "cache-ttl",
    );
    expect(built.findings.map((finding) => finding.id)).toEqual(["cache-ttl:claude-code:t3-code"]);
  });

  it("waits for 3 days with 1M cache writes", () => {
    const two = days(1, 0, (day) => tokens(day, 3 * M, 0));
    expect(report([scan(two)], "cache-ttl").findings).toEqual([]);
    const small = [...two, tokens(ago(2), M - 1, 0)];
    expect(report([scan(small)], "cache-ttl").findings).toEqual([]);
    expect(report([scan([...two, tokens(ago(2), M, 0)])], "cache-ttl").findings).toHaveLength(1);
  });

  it("gives each machine its own fix", () => {
    const built = report(
      [
        scan(fiveMinutes, { cacheTtl: "1h", cacheTtlFrom: "settings.promptCacheTtl" }, {}, "desk"),
        scan(fiveMinutes, { settingsPath: "~/custom/settings.json" }, {}, "laptop"),
      ],
      "cache-ttl",
    );
    expect(built.findings).toMatchObject([
      {
        where: [
          { machine: "desk", harness: "claude-code" },
          { machine: "laptop", harness: "claude-code" },
        ],
        evidence: { cacheWrite5m: 18 * M },
        fixes: [
          {
            machine: "laptop",
            path: "~/custom/settings.json",
            set: { key: "promptCacheTtl", value: "1h" },
          },
        ],
      },
    ]);
  });

  it("reports five-minute writes without suggesting a longer TTL when no reuse was observed", () => {
    const built = report(
      [
        scan(
          fiveMinutes.map((cell) => ({ ...cell, cacheRewrite: 0 })),
          {},
        ),
      ],
      "cache-ttl",
    );
    expect(built.findings).toMatchObject([{ level: "info", fixes: [] }]);
    expect(renderText(built)).toContain("no reuse opportunity was observed");
  });

  it("skips a harness that cannot tell the lifetime", () => {
    const blind = scan(fiveMinutes, undefined, {
      coverage: [coverage(undefined, { signals: { ...EXACT, cacheTtl: "none" } })],
    });
    expect(report([blind], "cache-ttl").skipped).toEqual([
      {
        rule: "cache-ttl",
        harness: "claude-code",
        reason: "missing-signal",
        missing: ["cacheTtl"],
      },
    ]);
  });
});

describe("cache-off", () => {
  const uncached = (count = 10, sent = M, read = 0) =>
    scan([tokens(LAST, 0, 0, { input: sent, cacheWrite: 0, cacheRead: read })], undefined, {
      usage: {
        sessions: [sessions(LAST, count), sessions(LAST, 50, { thread: "subagent" })],
        tokens: [tokens(LAST, 0, 0, { input: sent, cacheWrite: 0, cacheRead: read })],
      },
    });

  it.each([
    ["fires at 10 sessions and 1M tokens with no cache read", uncached(), 1],
    ["holds under 10 main-conversation sessions", uncached(9), 0],
    ["holds under 1M tokens sent", uncached(10, M - 1), 0],
    ["holds when one request read the cache", uncached(10, M, 1), 0],
  ])("%s", (_, built, count) => {
    expect(report([built], "cache-off").findings).toHaveLength(count);
  });

  it("cache-off ignores unsplit", () => {
    // Tokens with no split say nothing of the cache: neither sent past it nor read from it.
    const unknown = (sent: number) =>
      scan([], undefined, {
        usage: {
          sessions: [sessions(LAST, 10)],
          tokens: [
            tokens(LAST, 0, 0, { input: sent, cacheWrite: 0, cacheRead: 0, unsplit: 5 * M }),
          ],
        },
      });
    expect(report([unknown(M - 1)], "cache-off").findings).toEqual([]);
    expect(report([unknown(M)], "cache-off").findings).toMatchObject([
      { evidence: { sessions: 10, tokens: M } },
    ]);
  });

  it("counts cache writes as tokens sent", () => {
    const written = scan([tokens(LAST, M / 2, M / 2, { input: 0, cacheRead: 0 })], undefined, {
      usage: {
        sessions: [sessions(LAST, 10)],
        tokens: [tokens(LAST, M / 2, M / 2, { input: 0, cacheRead: 0 })],
      },
    });
    expect(report([written], "cache-off").findings).toMatchObject([
      { evidence: { sessions: 10, tokens: M } },
    ]);
  });

  it("turns caching back on where a variable turned it off", () => {
    const off = uncached();
    off.coverage = [
      coverage({ caching: "off", cachingFrom: "settings.env.DISABLE_PROMPT_CACHING_OPUS" }),
    ];
    const built = report([off], "cache-off");
    expect(built.findings).toEqual([
      {
        id: "cache-off:claude-code",
        rule: "cache-off",
        level: "fix",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { sessions: 10, tokens: M },
        fixes: [
          {
            machine: "laptop",
            action: "set",
            path: "~/.claude/settings.json",
            set: { key: "env.DISABLE_PROMPT_CACHING_OPUS", value: "0" },
          },
        ],
      },
    ]);
    expect(renderText(built)).toContain("no request read the prompt cache");
  });

  it("explains a gateway when no setting turned caching off", () => {
    const built = report([uncached()], "cache-off");
    expect(built.findings).toMatchObject([{ fixes: [] }]);
    expect(renderText(built)).toContain("A gateway or proxy");
  });
});

it("keeps unread T3 coverage when filtering for a provider T3 supplies", () => {
  const one = scan([], undefined, {
    coverage: [coverage(undefined, { harness: "t3-code", unread: ["statev2.sqlite"] })],
  });
  expect(report([one], "short-history", { harnesses: ["antigravity"] }).coverage).toMatchObject([
    { harness: "t3-code", unread: ["statev2.sqlite"] },
  ]);
  expect(report([one], "short-history", { harnesses: ["codex"] }).coverage).toEqual([]);
});

describe("short-history fix", () => {
  const young = (settings?: Settings) =>
    scan([], settings, {
      sessions: [
        {
          day: ago(5),
          harness: "claude-code",
          via: "cli",
          sessions: 30,
          fixedTokens: 0,
          measured: 0,
        },
      ],
    });

  it("does not change retention when local history has not reached it", () => {
    const built = report([young({ retentionDays: 30 })], "short-history");
    expect(built.findings).toEqual([
      {
        id: "short-history:claude-code",
        rule: "short-history",
        level: "info",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { days: 6, sessions: 30, minDays: 30 },
        fixes: [],
      },
    ]);
    expect(renderSummary(built, { harness: "claude-code" })).not.toContain(
      "keep transcripts a year",
    );
  });

  it("does not borrow another machine's history as evidence", () => {
    const built = report(
      [young({ retentionDays: 30 }), scan([], { retentionDays: 30 }, {}, "desk")],
      "short-history",
    );
    expect(built.findings).toMatchObject([
      { where: [{ machine: "desk" }], fixes: [{ machine: "desk" }] },
    ]);
  });

  it("fires when Claude Code's retention caps a full window", () => {
    const built = report([scan([], { retentionDays: 30 })], "short-history");
    expect(built.findings).toMatchObject([
      {
        level: "fix",
        evidence: { days: 30, sessions: 30, minDays: 30, retentionDays: 30 },
        fixes: [{ set: { key: "cleanupPeriodDays", value: 365 } }],
      },
    ]);
    expect(renderText(built)).toContain(
      "30 days of history, 30 sessions; Claude Code deletes transcripts after 30 days",
    );
    expect(report([scan([], { retentionDays: 31 })], "short-history").findings).toEqual([]);
    expect(report([scan([], undefined)], "short-history").findings).toEqual([]);
  });

  it("has no fix when retention is longer than the window, or unknown", () => {
    for (const settings of [{ retentionDays: 31 }, undefined]) {
      const [finding] = report([young(settings)], "short-history").findings;
      expect(finding).toMatchObject({ level: "info", fixes: [] });
    }
    expect(renderText(report([young({ retentionDays: 90 })], "short-history"))).toContain(
      "keeps transcripts longer than the window",
    );
  });

  it("does not claim retention exceeds the window on a young install", () => {
    const text = renderText(report([young({ retentionDays: 30 })], "short-history"));
    expect(text).toContain("the usage rules need more observed history");
    expect(text).not.toContain("keeps transcripts longer than the window");
  });
});

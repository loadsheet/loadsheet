import { parseScan, type Scan } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import {
  buildScan,
  coverageOf,
  foldFacts,
  mergeScans,
  sumTallies,
  type Fact,
  type HarnessScan,
  type Tally,
  type UsageTokensFact,
} from "../src/index.ts";

const signals = {
  listing: "exact",
  modelUse: "exact",
  userUse: "exact",
  instructions: "exact",
  mcp: "inferred",
  tokens: "exact",
  usage: "exact",
  cacheTtl: "none",
} as const;

// Two sessions on the 20th through cli, one on the 21st through an app.
const facts: Fact[] = [
  { type: "session", day: "2026-11-20", via: "cli", version: "1.0.0" },
  { type: "tokens", day: "2026-11-20", via: "cli", tokens: 1000 },
  { type: "listed", day: "2026-11-20", via: "cli", item: "skill:a", chars: 40, bare: false },
  { type: "listed", day: "2026-11-20", via: "cli", item: "mcp:m", chars: 7, bare: false },
  { type: "used", day: "2026-11-20", via: "cli", item: "skill:a", by: "model" },
  { type: "used", day: "2026-11-20", via: "cli", item: "skill:a", by: "model" },
  { type: "used", day: "2026-11-20", via: "cli", item: "skill:a", by: "user" },

  { type: "session", day: "2026-11-20", via: "cli", version: "1.0.1" },
  { type: "listed", day: "2026-11-20", via: "cli", item: "skill:a", chars: 12, bare: true },

  { type: "session", day: "2026-11-21", via: "app" },
  { type: "tokens", day: "2026-11-21", via: "app", tokens: 250 },
  { type: "listed", day: "2026-11-21", via: "app", item: "skill:a", chars: 40, bare: false },
  { type: "used", day: "2026-11-21", via: "app", item: "mcp:m", by: "model" },
];

const web = { via: "cli", project: "acme/web" } as const;
const tokens = (day: string, thread: "main" | "subagent", n: number): UsageTokensFact => ({
  type: "usage-tokens",
  day,
  ...web,
  thread,
  model: "model-a",
  input: n,
  output: 10 * n,
  reasoning: 2 * n,
  cacheRead: 100 * n,
  cacheWrite: 30 * n,
  cacheWrite5m: 20 * n,
  cacheWrite1h: 10 * n,
  cacheRewrite: 5 * n,
});

// One session on the 20th in acme/web with a subagent; its main thread compacts twice, once by
// hand, and keeps making requests past midnight. A session in ~/notes on the 21st.
const usage: Fact[] = [
  { type: "usage-session", day: "2026-11-20", ...web, thread: "main" },
  tokens("2026-11-20", "main", 1),
  { type: "usage-session", day: "2026-11-20", ...web, thread: "subagent" },
  tokens("2026-11-20", "subagent", 2),
  { type: "compaction", day: "2026-11-20", ...web, thread: "main", manual: false, first: true },
  tokens("2026-11-20", "main", 3),
  { type: "compaction", day: "2026-11-20", ...web, thread: "main", manual: true, first: false },
  tokens("2026-11-21", "main", 4),
  { type: "usage-session", day: "2026-11-21", via: "app", project: "~/notes", thread: "main" },
  { ...tokens("2026-11-21", "main", 1), via: "app", project: "~/notes", model: "model-b" },
];

const all = [...facts, ...usage];

describe("foldFacts", () => {
  it("sums Facts into SessionCells and Cells that match a hand count", () => {
    const tally = foldFacts("h", facts);
    expect(tally.sessions).toEqual([
      { day: "2026-11-20", harness: "h", via: "cli", sessions: 2, fixedTokens: 1000, measured: 1 },
      { day: "2026-11-21", harness: "h", via: "app", sessions: 1, fixedTokens: 250, measured: 1 },
    ]);
    expect(tally.cells).toEqual([
      {
        day: "2026-11-20",
        harness: "h",
        via: "cli",
        item: "mcp:m",
        sessions: 1,
        bare: 0,
        chars: 7,
        byModel: 0,
        byUser: 0,
      },
      {
        day: "2026-11-20",
        harness: "h",
        via: "cli",
        item: "skill:a",
        sessions: 2,
        bare: 1,
        chars: 52,
        byModel: 2,
        byUser: 1,
      },
      {
        day: "2026-11-21",
        harness: "h",
        via: "app",
        item: "mcp:m",
        sessions: 0,
        bare: 0,
        chars: 0,
        byModel: 1,
        byUser: 0,
      },
      {
        day: "2026-11-21",
        harness: "h",
        via: "app",
        item: "skill:a",
        sessions: 1,
        bare: 0,
        chars: 40,
        byModel: 0,
        byUser: 0,
      },
    ]);
    expect(tally.versions).toEqual([
      { harness: "h", day: "2026-11-20", version: "1.0.0" },
      { harness: "h", day: "2026-11-20", version: "1.0.1" },
    ]);
  });

  it("gives the coverage of the sessions: count, versions and first and last day", () => {
    const coverage = coverageOf(foldFacts("h", facts), {
      machine: "m",
      harness: "h",
      installed: true,
      signals,
    });
    expect(coverage).toEqual({
      machine: "m",
      harness: "h",
      installed: true,
      sessions: 3,
      versions: ["1.0.0", "1.0.1"],
      firstDay: "2026-11-20",
      lastDay: "2026-11-21",
      signals,
    });
  });

  it("sums usage Facts into usage cells that match a hand count", () => {
    const tally = foldFacts("h", usage);
    const cell = { harness: "h", ...web };
    expect(tally.usage!.sessions).toEqual([
      {
        day: "2026-11-20",
        ...cell,
        thread: "main",
        sessions: 1,
        compacted: 1,
        compactions: 2,
        manualCompactions: 1,
      },
      {
        day: "2026-11-20",
        ...cell,
        thread: "subagent",
        sessions: 1,
        compacted: 0,
        compactions: 0,
        manualCompactions: 0,
      },
      {
        day: "2026-11-21",
        harness: "h",
        via: "app",
        project: "~/notes",
        thread: "main",
        sessions: 1,
        compacted: 0,
        compactions: 0,
        manualCompactions: 0,
      },
    ]);
    const counts = (n: number, requests: number) => ({
      requests,
      input: n,
      output: 10 * n,
      reasoning: 2 * n,
      cacheRead: 100 * n,
      cacheWrite: 30 * n,
      cacheWrite5m: 20 * n,
      cacheWrite1h: 10 * n,
      cacheRewrite: 5 * n,
    });
    expect(tally.usage!.tokens).toEqual([
      { day: "2026-11-20", ...cell, thread: "main", model: "model-a", ...counts(4, 2) },
      { day: "2026-11-20", ...cell, thread: "subagent", model: "model-a", ...counts(2, 1) },
      {
        day: "2026-11-21",
        harness: "h",
        via: "app",
        project: "~/notes",
        thread: "main",
        model: "model-b",
        ...counts(1, 1),
      },
      { day: "2026-11-21", ...cell, thread: "main", model: "model-a", ...counts(4, 1) },
    ]);
    expect(foldFacts("h", facts).usage).toBeUndefined();
  });

  it("sums unsplit tokens on their own, and leaves cells without any as they were", () => {
    const zero = { ...tokens("2026-11-20", "main", 0), requests: 0 };
    const tally = foldFacts("h", [
      { ...zero, unsplit: 700 },
      { ...zero, unsplit: 300 },
      tokens("2026-11-21", "main", 1),
    ]);
    expect(tally.usage!.tokens.map(({ day, input, unsplit }) => [day, input, unsplit])).toEqual([
      ["2026-11-20", 0, 1000],
      ["2026-11-21", 1, undefined],
    ]);
    expect(sumTallies([tally, tally]).usage!.tokens[0]!.unsplit).toBe(2000);
  });

  it("holds each token split to its whole, so a cell stays inside the schema's bounds", () => {
    const tally = foldFacts("h", [
      {
        ...tokens("2026-11-20", "main", 1),
        requests: 3,
        reasoning: 50,
        cacheWrite5m: 25,
        cacheWrite1h: 25,
        cacheRewrite: 40,
      },
    ]);
    expect(tally.usage!.tokens[0]).toMatchObject({
      requests: 3,
      output: 10,
      reasoning: 10,
      cacheWrite: 30,
      cacheWrite5m: 25,
      cacheWrite1h: 5,
      cacheRewrite: 30,
    });
  });

  it("is additive: folding in pieces and summing equals folding at once", () => {
    for (let cut = 0; cut <= all.length; cut += 1) {
      const pieces = sumTallies([
        foldFacts("h", all.slice(0, cut)),
        foldFacts("h", all.slice(cut)),
      ]);
      expect(pieces).toEqual(foldFacts("h", all));
    }
  });

  it("sums tallies in any grouping and order to the same Tally", () => {
    const [a, b, c] = [all.slice(0, 7), all.slice(7, 19), all.slice(19)].map((part) =>
      foldFacts("h", part),
    ) as [Tally, Tally, Tally];
    const flat = sumTallies([a, b, c]);
    expect(sumTallies([sumTallies([a, b]), c])).toEqual(flat);
    expect(sumTallies([a, sumTallies([b, c])])).toEqual(flat);
    expect(sumTallies([c, b, a])).toEqual(flat);
    expect(sumTallies([sumTallies([c, a]), b], ["2026-11-21", "2026-11-21"])).toEqual(
      sumTallies([flat], ["2026-11-21", "2026-11-21"]),
    );
  });

  it("carries settings and unread stores into the coverage", () => {
    const coverage = coverageOf(foldFacts("h", all), {
      machine: "m",
      harness: "h",
      installed: true,
      signals,
      settings: { cacheTtl: "5m", cacheTtlFrom: "default" },
      unread: ["opencode.db", "grok", "opencode.db"],
    });
    expect(coverage.settings).toEqual({ cacheTtl: "5m", cacheTtlFrom: "default" });
    expect(coverage.unread).toEqual(["grok", "opencode.db"]);
  });

  it("keeps only the days inside a window", () => {
    const tally = sumTallies([foldFacts("h", all)], ["2026-11-21", "2026-11-30"]);
    expect(tally.sessions.map((cell) => cell.day)).toEqual(["2026-11-21"]);
    expect(tally.usage!.sessions.map((cell) => cell.day)).toEqual(["2026-11-21"]);
    // A request on the 21st of a session that started on the 20th counts on its own day.
    expect(tally.usage!.tokens.map((cell) => cell.day)).toEqual(["2026-11-21", "2026-11-21"]);
    expect(tally.cells.every((cell) => cell.day === "2026-11-21")).toBe(true);
    expect(tally.versions).toEqual([]);
  });
});

const item = (name: string, harness: string) => ({
  id: `skill:${name}`,
  ref: { kind: "skill" as const, name },
  harnesses: [harness],
  scope: "user" as const,
  managedBy: "hand" as const,
  path: `~/.agents/skills/${name}`,
  digest: "0".repeat(64),
  chars: { listed: 10, body: 20 },
  modelInvocable: true,
});

const scanOf = (parts: Array<{ harness: string; facts: Fact[] }>): Scan =>
  buildScan({
    tool: "loadsheet@0.0.0",
    machine: "m",
    scannedAt: "2026-11-24T00:00:00.000Z",
    window: ["2026-11-01", "2026-11-24"],
    harnesses: parts.map(({ harness, facts }): HarnessScan => ({
      harness,
      installed: true,
      signals,
      items: [item("a", harness), item(harness, harness)],
      tally: foldFacts(harness, facts),
    })),
  });

describe("buildScan", () => {
  const used = (item: string): Fact => ({
    type: "used",
    day: "2026-11-20",
    via: "cli",
    item,
    by: "model",
  });
  const listed: Fact = {
    type: "listed",
    day: "2026-11-02",
    via: "cli",
    item: "skill:listed-by-g",
    chars: 3,
    bare: true,
  };
  const items = (scan: Scan) => [...new Set(scan.cells.map((cell) => cell.item))].sort();

  it("keeps a used item's cells only when some harness installed or listed it", () => {
    const scan = scanOf([
      {
        harness: "h",
        facts: [
          used("skill:unknown"),
          used("subagent:unknown"),
          used("mcp:unknown"),
          used("instructions:unknown"),
          used("skill:g"),
          used("skill:listed-by-g"),
          used("skill:a"),
        ],
      },
      { harness: "g", facts: [listed] },
    ]);
    expect(items(scan)).toEqual(["skill:a", "skill:g", "skill:listed-by-g"]);
  });

  it("drops a cell whose item a harness listed only outside the window", () => {
    const scan = buildScan({
      tool: "loadsheet@0.0.0",
      machine: "m",
      scannedAt: "2026-11-24T00:00:00.000Z",
      window: ["2026-11-10", "2026-11-24"],
      harnesses: [
        {
          harness: "h",
          installed: true,
          signals,
          items: [],
          tally: foldFacts("h", [
            listed,
            used("skill:listed-by-g"),
            { ...listed, day: "2026-11-12", item: "skill:listed-inside" },
            used("skill:listed-inside"),
          ]),
        },
      ],
    });
    // A Scan is its window's sessions and nothing else: the same sessions give the same Scan
    // whatever older transcripts sit beside them.
    expect(items(scan)).toEqual(["skill:listed-inside"]);
  });
});

describe("mergeScans", () => {
  const other: Fact[] = [
    { type: "session", day: "2026-11-02", via: "cli", version: "2.0.0" },
    { type: "tokens", day: "2026-11-02", via: "cli", tokens: 7 },
    { type: "listed", day: "2026-11-02", via: "cli", item: "skill:a", chars: 3, bare: true },
    { type: "used", day: "2026-11-02", via: "cli", item: "skill:a", by: "user" },
    { type: "used", day: "2026-11-02", via: "cli", item: "skill:a", by: "model" },
  ];

  it("of the Scans of two sets of sessions equals the Scan of both", () => {
    const a = scanOf([
      { harness: "h", facts: all },
      { harness: "g", facts: other },
    ]);
    const b = scanOf([{ harness: "h", facts: [...other, ...usage] }]);
    const both = scanOf([
      { harness: "h", facts: [...all, ...other, ...usage] },
      { harness: "g", facts: other },
    ]);
    expect(both.usage!.sessions.length).toBeGreaterThan(0);
    expect(mergeScans(a, b)).toEqual(both);
    expect(mergeScans(b, a)).toEqual(both);
    expect(parseScan(mergeScans(a, b))).toEqual(both);
  });

  it("keeps the later Scan's settings and every unread store", () => {
    const at = (scan: Scan, scannedAt: string, coverage: Partial<Scan["coverage"][number]>) => ({
      ...scan,
      scannedAt,
      coverage: scan.coverage.map((row) => ({ ...row, ...coverage })),
    });
    const base = scanOf([{ harness: "h", facts: usage }]);
    const older = at(base, "2026-11-23T00:00:00.000Z", {
      settings: { cacheTtl: "5m" },
      unread: ["opencode.db"],
    });
    const newer = at(base, "2026-11-24T00:00:00.000Z", {
      settings: { cacheTtl: "1h", cacheTtlFrom: "settings.promptCacheTtl" },
      unread: ["grok"],
    });
    const plain = at(base, "2026-11-25T00:00:00.000Z", {});
    const [merged] = mergeScans(newer, older, plain).coverage;
    expect(merged!.settings).toEqual({ cacheTtl: "1h", cacheTtlFrom: "settings.promptCacheTtl" });
    expect(merged!.unread).toEqual(["grok", "opencode.db"]);
    expect(mergeScans(plain, plain).coverage[0]).not.toHaveProperty("settings");
  });

  it("refuses Scans of different machines", () => {
    const a = scanOf([{ harness: "h", facts }]);
    expect(() => mergeScans(a, { ...a, machine: "n" })).toThrow(/one machine/);
  });

  it("takes what an Item reaches from the latest Scan alone", () => {
    const [shared, own] = scanOf([{ harness: "h", facts }]).items;
    const at = (scannedAt: string, items: Scan["items"]): Scan => ({
      ...scanOf([{ harness: "h", facts: [] }]),
      scannedAt,
      items,
    });
    // The older Scan worked out both; the latest holds one of them and could not work it out.
    const older = at("2026-11-23T00:00:00.000Z", [
      { ...shared!, reaches: [own!.path] },
      { ...own!, reaches: [] },
    ]);
    const latest = at("2026-11-24T00:00:00.000Z", [shared!]);
    for (const merged of [mergeScans(older, latest), mergeScans(latest, older)]) {
      expect(merged.items).toEqual([shared, own]);
    }
    const known = at("2026-11-24T00:00:00.000Z", [{ ...shared!, reaches: [] }]);
    expect(mergeScans(older, known).items).toEqual([{ ...shared!, reaches: [] }, own]);
    // The latest Scan names a path it does not hold: an older Scan's Item does not stand in for it.
    const beyond = at("2026-11-24T00:00:00.000Z", [{ ...shared!, reaches: [own!.path] }]);
    expect(mergeScans(older, beyond).items).toEqual([shared, own]);
  });

  it("orders Scans by instant, however the time is written", () => {
    const [shared] = scanOf([{ harness: "h", facts }]).items;
    const at = (scannedAt: string, items: Scan["items"]): Scan => ({
      ...scanOf([{ harness: "h", facts: [] }]),
      scannedAt,
      items,
    });
    // As text, "…00.001Z" sorts before "…00Z".
    const older = at("2026-11-24T13:00:00Z", [{ ...shared!, reaches: [] }]);
    const latest = at("2026-11-24T13:00:00.001Z", [shared!]);
    for (const merged of [mergeScans(older, latest), mergeScans(latest, older)]) {
      expect(merged.items).toEqual([shared]);
      expect(merged.scannedAt).toBe(latest.scannedAt);
    }
  });

  it("keeps no reach when two Scans tie for the latest millisecond", () => {
    const [shared] = scanOf([{ harness: "h", facts }]).items;
    const at = (scannedAt: string, items: Scan["items"]): Scan => ({
      ...scanOf([{ harness: "h", facts: [] }]),
      scannedAt,
      items,
    });
    const older = at("2026-11-24T13:00:00.000001Z", [{ ...shared!, reaches: [] }]);
    const latest = at("2026-11-24T13:00:00.000002Z", [shared!]);
    for (const merged of [mergeScans(older, latest), mergeScans(latest, older)]) {
      expect(merged.items).toEqual([shared]);
    }
  });

  it.each([
    "2026-11-24T15:02:00+02",
    "2026-11-24 15:02:00.5 +0200",
    "2026-11-24T15:02:00.123456789+02:00",
  ])("orders a Scan stamped %s by its instant", (scannedAt) => {
    const [shared] = scanOf([{ harness: "h", facts }]).items;
    const at = (time: string, items: Scan["items"]): Scan =>
      parseScan({ ...scanOf([{ harness: "h", facts: [] }]), scannedAt: time, items });
    const first = at("2026-11-24T13:00:00Z", [shared!]);
    const second = at("2026-11-24T13:01:00Z", [{ ...shared!, reaches: [] }]);
    const latest = at(scannedAt, [shared!]);
    const merged = [
      mergeScans(latest, second),
      mergeScans(second, latest),
      // The order a cache of parts is folded in: the newest first, then an older one.
      mergeScans(mergeScans(latest, first), second),
    ];
    for (const scan of merged) {
      expect(scan.scannedAt).toBe(scannedAt);
      expect(scan.items).toEqual([shared]);
    }
  });
});

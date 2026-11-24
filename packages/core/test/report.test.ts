import {
  parseReport,
  resolveConfig,
  type Cell,
  type Config,
  type Coverage,
  type Grade,
  type Item,
  type Scan,
  type SessionCell,
  type Signal,
} from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import { buildReport } from "../src/index.ts";

const EXACT: Record<Signal, Grade> = {
  listing: "exact",
  modelUse: "exact",
  userUse: "exact",
  instructions: "exact",
  mcp: "exact",
  tokens: "exact",
};
const NOW = new Date("2026-11-24T12:00:00.000Z");
const LAST = "2026-11-24";
const FIRST = "2026-10-26"; // 30 days of history

const coverage = (machine: string, harness: string, extra: Partial<Coverage> = {}): Coverage => ({
  machine,
  harness,
  installed: true,
  sessions: 30,
  versions: [],
  firstDay: FIRST,
  lastDay: LAST,
  signals: EXACT,
  ...extra,
});

const skill = (name: string, extra: Partial<Item> = {}): Item => ({
  id: `skill:${name}`,
  ref: { kind: "skill", name },
  harnesses: ["claude-code"],
  scope: "user",
  managedBy: "hand",
  path: `~/.claude/skills/${name}`,
  digest: "0".repeat(64),
  chars: { listed: 120, body: 900 },
  modelInvocable: true,
  ...extra,
});

const sessions = (
  count: number,
  extra: Partial<SessionCell> = {},
  harness = "claude-code",
): SessionCell => ({
  day: "2026-11-20",
  harness,
  via: "cli",
  sessions: count,
  fixedTokens: 0,
  measured: 0,
  ...extra,
});

/** A skill's counters: listed in `listed` sessions, `bare` of them without a description. */
const cell = (
  name: string,
  listed: number,
  extra: Partial<Omit<Cell, "item" | "sessions">> = {},
): Cell => ({
  day: "2026-11-20",
  harness: "claude-code",
  via: "cli",
  item: `skill:${name}`,
  sessions: listed,
  bare: 0,
  chars: listed * 120,
  byModel: 0,
  byUser: 0,
  ...extra,
});

const scan = (machine: string, parts: Partial<Scan> = {}): Scan => ({
  schema: 1,
  tool: "loadsheet@0.0.1",
  machine,
  scannedAt: NOW.toISOString(),
  window: [FIRST, LAST],
  coverage: [coverage(machine, "claude-code")],
  items: [],
  sessions: [sessions(30)],
  cells: [],
  ...parts,
});

const report = (scans: Scan[], config: Config = {}) => {
  const built = buildReport({
    scans,
    config: resolveConfig(config),
    now: NOW,
    tool: "loadsheet@0.0.1",
  });
  expect(parseReport(JSON.parse(JSON.stringify(built)))).toEqual(built);
  return built;
};

/** Only the rule under test runs, so its findings and skips are all that is left. */
const only = (rule: string): Config => ({
  rules: Object.fromEntries(
    ["invisible-skill", "dead-skill", "manual-only", "expensive-description"]
      .filter((id) => id !== rule)
      .map((id) => [id, false]),
  ),
});

const findingsOf = (scans: Scan[], rule: string, config: Config = {}) => {
  const built = report(scans, {
    ...only(rule),
    ...config,
    rules: { ...only(rule).rules, ...config.rules },
  });
  return {
    items: built.findings.filter((f) => f.rule === rule).map((f) => f.item),
    skipped: built.skipped.filter((s) => s.rule === rule),
    findings: built.findings.filter((f) => f.rule === rule),
  };
};

describe("invisible-skill", () => {
  const seen = [cell("used", 30, { byModel: 5 })];
  it.each([
    [
      "fires when most sessions list it bare",
      [skill("hidden")],
      [cell("hidden", 10, { bare: 8 })],
      30,
      ["skill:hidden"],
    ],
    [
      "holds when few sessions list it bare",
      [skill("hidden")],
      [cell("hidden", 10, { bare: 2 })],
      30,
      [],
    ],
    ["holds below minSessions", [skill("hidden")], [cell("hidden", 4, { bare: 4 })], 30, []],
    [
      "holds for a skill the user set to name-only",
      [skill("hidden", { chars: { listed: "- hidden\n".length, body: 900 } })],
      [cell("hidden", 10, { bare: 10 })],
      30,
      [],
    ],
  ])("%s", (_, items, cells, count, expected) => {
    const result = findingsOf(
      [scan("laptop", { items, cells: [...cells, ...seen], sessions: [sessions(count)] })],
      "invisible-skill",
    );
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("evidences the numbers and raises Claude Code's listing budget where the skill is installed", () => {
    const { findings } = findingsOf(
      [
        scan("laptop", {
          items: [skill("hidden", { chars: { listed: 400, body: 900 } })],
          cells: [cell("hidden", 10, { bare: 8, byUser: 1 }), ...seen],
        }),
      ],
      "invisible-skill",
    );
    expect(findings).toEqual([
      {
        id: "invisible-skill:skill:hidden",
        rule: "invisible-skill",
        level: "fix",
        item: "skill:hidden",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { sessions: 10, bare: 8, bareShare: 0.8, byModel: 0, byUser: 1 },
        fixes: [
          {
            machine: "laptop",
            action: "set",
            path: "~/.claude/settings.json",
            set: { key: "skillListingBudgetFraction", value: expect.any(Number) },
          },
        ],
      },
    ]);
    const value = findings[0]!.fixes[0]!.set!.value as number;
    expect(value).toBeGreaterThan(0.01);
    expect(value).toBeLessThanOrEqual(1);
  });

  it("skips a harness without listing and one with fewer sessions than minSessions", () => {
    const blind = scan("laptop", {
      coverage: [coverage("laptop", "claude-code", { signals: { ...EXACT, listing: "none" } })],
      cells: [cell("hidden", 10, { bare: 10 })],
    });
    expect(findingsOf([blind], "invisible-skill")).toMatchObject({
      items: [],
      skipped: [
        {
          rule: "invisible-skill",
          harness: "claude-code",
          reason: "missing-signal",
          missing: ["listing"],
        },
      ],
    });
    const short = scan("laptop", {
      sessions: [sessions(4)],
      cells: [cell("hidden", 4, { bare: 4 })],
    });
    expect(findingsOf([short], "invisible-skill").skipped).toEqual([
      { rule: "invisible-skill", harness: "claude-code", reason: "not-enough-data" },
    ]);
  });
});

describe("dead-skill", () => {
  it.each([
    ["fires for a skill listed for weeks and never invoked", [cell("idle", 25)], ["skill:idle"]],
    ["holds for a skill invoked once", [cell("idle", 25, { byUser: 1 })], []],
    ["holds below minSessions", [cell("idle", 19)], []],
  ])("%s", (_, cells, expected) => {
    const result = findingsOf([scan("laptop", { items: [skill("idle")], cells })], "dead-skill");
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("removes a hand-made skill with its path and a command, and saves its listing", () => {
    const { findings } = findingsOf(
      [scan("laptop", { items: [skill("idle")], cells: [cell("idle", 25)] })],
      "dead-skill",
    );
    expect(findings).toEqual([
      {
        id: "dead-skill:skill:idle",
        rule: "dead-skill",
        level: "cut",
        item: "skill:idle",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { sessions: 25, days: 30, byModel: 0, byUser: 0 },
        savesTokens: { value: 30, basis: "estimated" },
        fixes: [
          {
            machine: "laptop",
            action: "remove",
            path: "~/.claude/skills/idle",
            run: "rm -r ~/.claude/skills/idle",
          },
        ],
      },
    ]);
  });

  it("skips a harness without user use and one with less history than minDays", () => {
    const blind = scan("laptop", {
      coverage: [coverage("laptop", "claude-code", { signals: { ...EXACT, userUse: "none" } })],
      cells: [cell("idle", 25)],
    });
    expect(findingsOf([blind], "dead-skill")).toMatchObject({
      items: [],
      skipped: [
        {
          rule: "dead-skill",
          harness: "claude-code",
          reason: "missing-signal",
          missing: ["userUse"],
        },
      ],
    });
    const young = scan("laptop", {
      coverage: [coverage("laptop", "claude-code", { firstDay: "2026-11-20" })],
      cells: [cell("idle", 25)],
    });
    expect(findingsOf([young], "dead-skill")).toMatchObject({
      items: [],
      skipped: [{ rule: "dead-skill", harness: "claude-code", reason: "not-enough-data" }],
    });
  });
});

describe("manual-only", () => {
  it.each([
    [
      "fires for a skill only the user invokes",
      [skill("manual")],
      [cell("manual", 30, { byUser: 3 })],
      ["skill:manual"],
    ],
    [
      "holds when the model invoked it",
      [skill("manual")],
      [cell("manual", 30, { byUser: 3, byModel: 1 })],
      [],
    ],
    ["holds below minUserUses", [skill("manual")], [cell("manual", 30, { byUser: 2 })], []],
    [
      "holds for a skill the model may not invoke",
      [skill("manual", { modelInvocable: false })],
      [cell("manual", 30, { byUser: 9 })],
      [],
    ],
    ["holds for a skill installed nowhere", [], [cell("manual", 30, { byUser: 9 })], []],
  ])("%s", (_, items, cells, expected) => {
    const result = findingsOf([scan("laptop", { items, cells })], "manual-only");
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("hides it from the model: frontmatter by hand, settings for an installer, openai.yaml in Codex", () => {
    const { findings } = findingsOf(
      [
        scan("laptop", {
          coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
          items: [
            skill("manual"),
            skill("locked", { managedBy: "skills", pack: "acme/skills" }),
            skill("manual", { harnesses: ["codex"], path: "~/.agents/skills/manual" }),
          ],
          sessions: [sessions(30), sessions(30, {}, "codex")],
          cells: [
            cell("manual", 30, { byUser: 3 }),
            cell("locked", 30, { byUser: 3 }),
            cell("manual", 30, { byUser: 4, harness: "codex" }),
          ],
        }),
      ],
      "manual-only",
    );
    expect(findings.map((f) => [f.item, f.where, f.evidence, f.fixes])).toEqual([
      [
        "skill:manual",
        [
          { machine: "laptop", harness: "claude-code" },
          { machine: "laptop", harness: "codex" },
        ],
        { sessions: 60, byModel: 0, byUser: 7 },
        [
          {
            machine: "laptop",
            action: "hide-from-model",
            path: "~/.claude/skills/manual/SKILL.md",
            set: { key: "disable-model-invocation", value: true },
          },
          {
            machine: "laptop",
            action: "hide-from-model",
            path: "~/.agents/skills/manual/agents/openai.yaml",
            set: { key: "policy.allow_implicit_invocation", value: false },
          },
        ],
      ],
      [
        "skill:locked",
        [{ machine: "laptop", harness: "claude-code" }],
        { sessions: 30, byModel: 0, byUser: 3 },
        [
          {
            machine: "laptop",
            action: "hide-from-model",
            path: "~/.claude/settings.json",
            set: { key: "skillOverrides.locked", value: "user-invocable-only" },
          },
        ],
      ],
    ]);
  });

  it("skips a harness without model use and one with no sessions", () => {
    const blind = scan("laptop", {
      coverage: [coverage("laptop", "claude-code", { signals: { ...EXACT, modelUse: "none" } })],
      items: [skill("manual")],
      cells: [cell("manual", 30, { byUser: 3 })],
    });
    expect(findingsOf([blind], "manual-only")).toMatchObject({
      items: [],
      skipped: [
        {
          rule: "manual-only",
          harness: "claude-code",
          reason: "missing-signal",
          missing: ["modelUse"],
        },
      ],
    });
    const empty = scan("laptop", {
      coverage: [
        coverage("laptop", "claude-code", { sessions: 0, firstDay: undefined, lastDay: undefined }),
      ],
      items: [skill("manual")],
      sessions: [],
    });
    expect(findingsOf([empty], "manual-only")).toMatchObject({
      items: [],
      skipped: [{ rule: "manual-only", harness: "claude-code", reason: "not-enough-data" }],
    });
  });
});

describe("expensive-description", () => {
  it.each([
    ["fires past maxChars", 301, ["skill:long"]],
    ["holds at maxChars", 300, []],
  ])("%s", (_, listed, expected) => {
    const result = findingsOf(
      [
        scan("laptop", {
          items: [skill("long", { chars: { listed, body: 0 } })],
          cells: [cell("long", 30, { byModel: 1 })],
        }),
      ],
      "expensive-description",
    );
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("orders by listing tokens per use, and shortens the SKILL.md on each machine", () => {
    const items = [
      skill("often", { chars: { listed: 800, body: 0 } }),
      skill("never", { chars: { listed: 400, body: 0 } }),
    ];
    const cells = [cell("often", 30, { byModel: 30 }), cell("never", 30)];
    const { findings } = findingsOf([scan("laptop", { items, cells })], "expensive-description");
    expect(findings.map((f) => [f.item, f.evidence])).toEqual([
      [
        "skill:never",
        { listedChars: 400, maxChars: 300, sessions: 30, uses: 0, tokensPerUse: 3000 },
      ],
      [
        "skill:often",
        { listedChars: 800, maxChars: 300, sessions: 30, uses: 30, tokensPerUse: 200 },
      ],
    ]);
    expect(findings[0]!.fixes).toEqual([
      { machine: "laptop", action: "shorten", path: "~/.claude/skills/never/SKILL.md" },
    ]);
  });
});

describe("fixes", () => {
  const dead = (items: Item[], extra: Partial<Scan> = {}) =>
    report([scan("laptop", { items, cells: [cell("idle", 25)], ...extra })]).findings;

  it("a cut finding takes the item's fix-level findings away", () => {
    const findings = dead([skill("idle", { chars: { listed: 900, body: 0 } })]);
    expect(findings.map((f) => f.id)).toEqual(["dead-skill:skill:idle"]);
  });

  it("an item installed nowhere gets a finding with no fixes", () => {
    const [finding] = dead([]);
    expect(finding).toMatchObject({ id: "dead-skill:skill:idle", fixes: [] });
  });

  it("names only machines that have the Item", () => {
    const built = report([
      scan("laptop", { items: [skill("idle")], cells: [cell("idle", 15)] }),
      scan("server", { cells: [cell("idle", 15)] }),
    ]);
    const [finding] = built.findings;
    expect(finding!.where).toEqual([
      { machine: "laptop", harness: "claude-code" },
      { machine: "server", harness: "claude-code" },
    ]);
    expect(finding!.fixes.map((fix) => fix.machine)).toEqual(["laptop"]);
  });

  it("never removes a path another harness still uses; hides it from the unused one", () => {
    const shared = skill("idle", {
      harnesses: ["claude-code", "codex"],
      path: "~/.agents/skills/idle",
    });
    const extra = {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
      sessions: [sessions(30), sessions(30, {}, "codex")],
    };
    const used = dead([shared], {
      ...extra,
      cells: [cell("idle", 25), cell("idle", 25, { harness: "codex", byModel: 2 })],
    });
    expect(used.find((f) => f.rule === "dead-skill")!.fixes).toEqual([
      {
        machine: "laptop",
        action: "hide-from-model",
        path: "~/.agents/skills/idle/SKILL.md",
        set: { key: "disable-model-invocation", value: true },
      },
    ]);
    const unused = dead([shared], {
      ...extra,
      cells: [cell("idle", 25), cell("idle", 25, { harness: "codex" })],
    });
    expect(unused.find((f) => f.rule === "dead-skill")!.fixes.map((fix) => fix.action)).toEqual([
      "remove",
    ]);
  });

  it.each([
    [
      "skills",
      { managedBy: "skills", pack: "acme/skills" },
      {
        action: "remove",
        path: "~/.claude/skills/idle",
        run: "npx skills remove idle --global --agent claude-code --yes",
      },
    ],
    [
      "fleetrc",
      { managedBy: "fleetrc" },
      { action: "remove", path: "~/.claude/skills/idle", run: "fleetrc remove idle" },
    ],
    [
      "plugin",
      {
        managedBy: "plugin",
        scope: "plugin",
        pack: "kit",
        path: "~/.claude/plugins/cache/m/kit/1.0.0/skills/idle",
      },
      {
        action: "hide-from-model",
        path: "~/.claude/plugins/cache/m/kit/1.0.0/skills/idle/SKILL.md",
        set: { key: "disable-model-invocation", value: true },
      },
    ],
    [
      "hand, with a space",
      { path: "~/.claude/skills/my idle" },
      {
        action: "remove",
        path: "~/.claude/skills/my idle",
        run: "rm -r ~/'.claude/skills/my idle'",
      },
    ],
  ] as const)("a dead skill managed by %s", (_, extra, fix) => {
    const [finding] = dead([skill("idle", extra as Partial<Item>)]);
    expect(finding!.fixes).toEqual([{ machine: "laptop", ...fix }]);
  });

  it("a harness without a fix table gets the path and no command, and nothing to hide", () => {
    const item = skill("idle", { harnesses: ["cursor"], path: "~/.cursor/skills/idle" });
    const cursor = (cells: Cell[]) =>
      report([
        scan("laptop", {
          coverage: [coverage("laptop", "cursor")],
          items: [item],
          sessions: [sessions(30, {}, "cursor")],
          cells,
        }),
      ]).findings;
    expect(cursor([cell("idle", 25, { harness: "cursor" })]).map((f) => [f.rule, f.fixes])).toEqual(
      [["dead-skill", [{ machine: "laptop", action: "remove", path: "~/.cursor/skills/idle" }]]],
    );
    expect(
      cursor([cell("idle", 25, { harness: "cursor", byUser: 5 })]).map((f) => [f.rule, f.fixes]),
    ).toEqual([["manual-only", []]]);
  });
});

describe("buildReport", () => {
  it("throws on two Scans of the same machine", () => {
    expect(() => report([scan("laptop"), scan("laptop")])).toThrow(/laptop/u);
    expect(() =>
      buildReport({
        scans: [scan("laptop")],
        machines: [{ name: "laptop", reachable: false }],
        config: resolveConfig(),
        now: NOW,
        tool: "t",
      }),
    ).toThrow(/laptop/u);
  });

  it("aggregates two machines by item id, and reports each machine and its coverage", () => {
    const built = report([
      scan("laptop", {
        items: [skill("tool")],
        sessions: [sessions(10, { fixedTokens: 10000, measured: 5 })],
        cells: [cell("tool", 10, { byModel: 2, day: "2026-11-18" })],
      }),
      scan("server", {
        window: ["2026-11-01", "2026-11-23"],
        coverage: [coverage("server", "claude-code", { lastDay: "2026-11-23" })],
        items: [skill("tool", { chars: { listed: 140, body: 900 } })],
        sessions: [sessions(30, { fixedTokens: 30000, measured: 5 })],
        cells: [
          cell("tool", 20, { bare: 3, byUser: 1, day: "2026-11-22" }),
          cell("gone", 4, { chars: 200 }),
        ],
      }),
    ]);
    expect(built).toMatchObject({
      mode: "fleet",
      window: [FIRST, LAST],
      machines: [
        { name: "laptop", reachable: true, scannedAt: NOW.toISOString() },
        { name: "server", reachable: true, scannedAt: NOW.toISOString() },
      ],
    });
    expect(built.coverage.map((c) => c.machine)).toEqual(["laptop", "server"]);
    const [sheet] = built.sheet;
    expect(sheet).toMatchObject({
      harness: "claude-code",
      sessions: 40,
      fixedTokens: { value: 4000, basis: "measured" },
    });
    expect(sheet!.lines).toEqual([
      {
        item: "skill:tool",
        ref: { kind: "skill", name: "tool" },
        scope: "user",
        managedBy: "hand",
        machines: ["laptop", "server"],
        path: "~/.claude/skills/tool",
        chars: { listed: 120, body: 900 },
        tokens: { value: 30, basis: "estimated" },
        exposure: { sessions: 30, share: 0.75, bare: 3 },
        use: { byModel: 2, byUser: 1, lastUsed: "2026-11-22" },
      },
      {
        item: "skill:gone",
        ref: { kind: "skill", name: "gone" },
        machines: ["server"],
        chars: { listed: 50, body: 0 },
        tokens: { value: 13, basis: "estimated" },
        exposure: { sessions: 4, share: 0.1, bare: 0 },
        use: { byModel: 0, byUser: 0 },
      },
    ]);
  });

  it("is local for one machine, and lists machines that could not be read", () => {
    expect(report([scan("laptop")]).mode).toBe("local");
    const built = buildReport({
      scans: [scan("laptop")],
      machines: [{ name: "mini", reachable: false, error: "timed out" }],
      config: resolveConfig(),
      now: NOW,
      tool: "t",
    });
    expect(built.mode).toBe("fleet");
    expect(built.machines.map((m) => m.name)).toEqual(["laptop", "mini"]);
  });

  it("filters cells and sessions by via", () => {
    const scans = [
      scan("laptop", {
        items: [skill("tool")],
        sessions: [sessions(10), sessions(30, { via: "app" })],
        cells: [cell("tool", 10, { byModel: 1 }), cell("tool", 30, { via: "app", byModel: 4 })],
      }),
    ];
    const line = (config: Config) => {
      const [sheet] = report(scans, config).sheet;
      return [sheet!.sessions, sheet!.lines[0]!.exposure.sessions, sheet!.lines[0]!.use.byModel];
    };
    expect(line({})).toEqual([40, 40, 5]);
    expect(line({ via: { include: ["cli"] } })).toEqual([10, 10, 1]);
    expect(line({ via: { exclude: ["cli"] } })).toEqual([30, 30, 4]);
  });

  it("an ignored item keeps its line and gets no finding", () => {
    const built = report([scan("laptop", { items: [skill("idle")], cells: [cell("idle", 25)] })], {
      ignore: ["skill:idle"],
    });
    expect(built.findings).toEqual([]);
    expect(built.sheet[0]!.lines.map((line) => line.item)).toEqual(["skill:idle"]);
  });

  it("keeps only the configured harnesses' sheets", () => {
    const both = scan("laptop", {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
      sessions: [sessions(30), sessions(5, {}, "codex")],
    });
    expect(report([both]).sheet.map((s) => s.harness)).toEqual(["claude-code", "codex"]);
    expect(report([both], { harnesses: ["codex"] }).sheet.map((s) => s.harness)).toEqual(["codex"]);
  });

  it("gives no sheet to a harness that is not installed and has nothing", () => {
    const built = report([
      scan("laptop", {
        coverage: [
          coverage("laptop", "claude-code"),
          coverage("laptop", "codex", { installed: false, sessions: 0 }),
        ],
      }),
    ]);
    expect(built.sheet.map((s) => s.harness)).toEqual(["claude-code"]);
    expect(built.coverage).toHaveLength(2);
  });
});

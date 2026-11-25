import {
  parseReport,
  resolveConfig,
  RULES,
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
import {
  buildReport,
  harnessTokens,
  renderText,
  setupTokens,
  type BuildReportInput,
} from "../src/index.ts";

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

/** A digest of its own for each path, as each file has. */
const digestOf = (path: string) => {
  let hash = 0x811c9dc5;
  for (const char of path) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(8);
};

const skill = (name: string, extra: Partial<Item> = {}): Item => {
  const path = extra.path ?? `~/.claude/skills/${name}`;
  return {
    id: `skill:${name}`,
    ref: { kind: "skill", name },
    harnesses: ["claude-code"],
    scope: "user",
    managedBy: "hand",
    path,
    digest: digestOf(path),
    chars: { listed: 120, body: 900 },
    modelInvocable: true,
    // The Scan worked out what a removal reaches: nothing, unless a test says otherwise.
    reaches: [],
    ...extra,
  };
};

/**
 * A harness's session totals: one session on the window's first day, so the sheet holds 30 days of
 * history, and the rest on one day; all of them on `extra.day` when it is given.
 */
const sessions = (
  count: number,
  extra: Partial<SessionCell> = {},
  harness = "claude-code",
): SessionCell[] => {
  const totals = (day: string, sessions: number, more: Partial<SessionCell> = {}): SessionCell => ({
    day,
    harness,
    via: "cli",
    sessions,
    fixedTokens: 0,
    measured: 0,
    ...more,
  });
  if (extra.day !== undefined || count < 2) return [totals("2026-11-20", count, extra)];
  return [totals(FIRST, 1, { via: extra.via ?? "cli" }), totals("2026-11-20", count - 1, extra)];
};

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
  sessions: [...sessions(30)],
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
  rules: Object.fromEntries(RULES.filter((id) => id !== rule).map((id) => [id, false])),
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
      [scan("laptop", { items, cells: [...cells, ...seen], sessions: sessions(count) })],
      "invisible-skill",
    );
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("evidences the numbers and sets each machine's listing budget from its own listing", () => {
    const { findings } = findingsOf(
      [
        // 400 (hidden's Item) + 120 (used, as its sessions held it) + 200 (quiet, ignored but
        // listed), plus a tenth.
        scan("laptop", {
          items: [
            skill("hidden", { chars: { listed: 400, body: 900 } }),
            skill("quiet", { chars: { listed: 200, body: 0 } }),
          ],
          cells: [cell("hidden", 10, { bare: 8, byUser: 1 }), cell("quiet", 10), ...seen],
        }),
        // hidden is installed nowhere and always listed bare, so its description is unknown and
        // counts at the longest Claude Code lists: 9 + 2 + 1536, and 120 for the others, plus a tenth.
        scan("server", {
          cells: [cell("hidden", 10, { bare: 10, chars: 90 }), ...seen],
        }),
        // Nothing listed bare, so the budget already fits.
        scan("mini", { cells: [cell("hidden", 10), ...seen] }),
      ],
      "invisible-skill",
      { ignore: ["skill:quiet"] },
    );
    const budget = (machine: string, value: string) => ({
      machine,
      action: "set",
      path: "~/.claude/settings.json",
      set: { key: "env.SLASH_COMMAND_TOOL_CHAR_BUDGET", value },
    });
    expect(findings).toEqual([
      {
        id: "invisible-skill:skill:hidden",
        rule: "invisible-skill",
        level: "fix",
        item: "skill:hidden",
        where: [
          { machine: "laptop", harness: "claude-code" },
          { machine: "mini", harness: "claude-code" },
          { machine: "server", harness: "claude-code" },
        ],
        evidence: { sessions: 30, bare: 18, bareShare: 0.6, byModel: 0, byUser: 1 },
        fixes: [budget("laptop", "792"), budget("server", "1834")],
      },
    ]);
  });

  it("raises the budget on every machine it holds for, also where the skill is installed nowhere loadsheet reads", () => {
    const hidden = [cell("hidden", 10, { bare: 8 }), ...seen];
    const built = report(
      [
        // The settings sit in the config directory the machine's user Items are under.
        scan("laptop", {
          items: [
            skill("mine", { path: "~/.config/claude/skills/mine" }),
            skill("work", { scope: "project", path: "work/.claude/skills/work" }),
          ],
          cells: hidden,
        }),
        // Only a project's Item: its directory is not the machine's.
        scan("server", {
          items: [skill("work", { scope: "project", path: "app/.claude/skills/work" })],
          cells: hidden,
        }),
      ],
      only("invisible-skill"),
    );
    expect(
      built.findings.map((f) => [f.item, f.fixes.map((fix) => [fix.machine, fix.path])]),
    ).toEqual([
      [
        "skill:hidden",
        [
          ["laptop", "~/.config/claude/settings.json"],
          ["server", "~/.claude/settings.json"],
        ],
      ],
    ]);
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
      sessions: [...sessions(4)],
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
        evidence: { sessions: 25, days: 26, byModel: 0, byUser: 0 },
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
      sessions: sessions(30, { day: "2026-11-20" }),
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

  it("offers no hide on a machine where the model already may not invoke it", () => {
    const cells = [cell("manual", 30, { byUser: 3 })];
    const { findings } = findingsOf(
      [
        scan("laptop", { items: [skill("manual")], cells }),
        scan("desktop", { items: [skill("manual", { modelInvocable: false })], cells }),
      ],
      "manual-only",
    );
    expect(findings.map((f) => f.fixes.map((fix) => fix.machine))).toEqual([["laptop"]]);
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
          sessions: [...sessions(30), ...sessions(30, {}, "codex")],
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

  it("judges each install, whatever the machines' names, and names only the long ones", () => {
    const copies = (short: string, long: string) =>
      findingsOf(
        [
          scan(short, {
            items: [skill("long", { chars: { listed: 20, body: 0 } })],
            cells: [cell("long", 30, { byModel: 1 })],
          }),
          scan(long, {
            items: [skill("long", { chars: { listed: 400, body: 0 } })],
            cells: [cell("long", 30, { byModel: 1 })],
          }),
        ],
        "expensive-description",
      ).findings.map((f) => [f.where, f.evidence.listedChars, f.fixes]);
    for (const [short, long] of [
      ["laptop", "server"],
      ["server", "laptop"],
    ] as const) {
      expect(copies(short, long)).toEqual([
        [
          [{ machine: long, harness: "claude-code" }],
          400,
          [{ machine: long, action: "shorten", path: "~/.claude/skills/long/SKILL.md" }],
        ],
      ]);
    }
  });

  it("charges a session that listed the skill bare only `- name`", () => {
    const { findings } = findingsOf(
      [
        scan("laptop", {
          items: [skill("long", { chars: { listed: 400, body: 0 } })],
          cells: [cell("long", 30, { bare: 20 })],
        }),
      ],
      "expensive-description",
    );
    // 10 full entries of 100 tokens, and 20 bare `- long` of 2.
    expect(findings[0]!.evidence.tokensPerUse).toBe(1040);
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

/** An instruction file of `chars` characters. */
const instructions = (name: string, chars: number, extra: Partial<Item> = {}): Item => ({
  ...skill(name, { path: `~/.claude/${name}` }),
  id: `instructions:${name}`,
  ref: { kind: "instructions", name },
  chars: { listed: chars, body: 0 },
  ...extra,
});

/** An MCP server; its listing is measured from the sessions that listed it. */
const server = (name: string, extra: Partial<Item> = {}): Item => ({
  ...skill(name, { path: "~/.claude.json" }),
  id: `mcp:${name}`,
  ref: { kind: "mcp", name },
  chars: { listed: 0, body: 0 },
  ...extra,
});

const serverCell = (name: string, listed: number, extra: Partial<Omit<Cell, "item">> = {}) => ({
  ...cell(name, listed, { chars: listed * 200, ...extra }),
  item: `mcp:${name}`,
});

describe("dead-pack", () => {
  const NAMES = ["a", "b", "c", "d", "e"];
  const packed = (name: string, extra: Partial<Item> = {}) =>
    skill(name, { pack: "acme/kit", managedBy: "skills", ...extra });
  const kit = (names = NAMES, extra: Partial<Item> = {}, used: string[] = [], unlisted = 0) =>
    scan("laptop", {
      items: [
        ...names.map((name) => packed(name, extra)),
        ...Array.from({ length: unlisted }, (_, index) => packed(`quiet-${index}`, extra)),
      ],
      cells: names.map((name) => cell(name, 30, used.includes(name) ? { byModel: 1 } : {})),
    });
  /** Every finding, with dead-skill and expensive-description running beside dead-pack. */
  const both = (built: Scan) =>
    report([built], {
      rules: {
        ...only("dead-pack").rules,
        "dead-skill": {},
        "expensive-description": {},
      },
    }).findings;

  it.each([
    ["fires for a pack of minSkills skills none of which is invoked", kit(), ["acme/kit"]],
    ["holds when one of its skills is invoked", kit(NAMES, {}, ["c"]), []],
    ["fires with a skill never listed beside them", kit(NAMES, {}, [], 1), ["acme/kit"]],
    ["holds below minSkills", kit(NAMES.slice(0, 4)), []],
    ["holds below minSkills listed", kit(NAMES.slice(0, 4), {}, [], 3), []],
  ])("%s", (_, built, expected) => {
    const result = findingsOf([built], "dead-pack");
    expect(result.findings.map((f) => f.pack)).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("is one finding for the pack, with no item, saving every skill's listing", () => {
    const { findings } = findingsOf([kit()], "dead-pack");
    expect(findings).toEqual([
      {
        id: "dead-pack:acme/kit",
        rule: "dead-pack",
        level: "cut",
        pack: "acme/kit",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { skills: 5, sessions: 30, days: 26, byModel: 0, byUser: 0 },
        savesTokens: { value: 150, basis: "estimated" },
        fixes: NAMES.map((name) => ({
          machine: "laptop",
          action: "remove",
          path: `~/.claude/skills/${name}`,
          run: `npx skills remove ${name} --global --agent claude-code --yes`,
        })),
      },
    ]);
  });

  it("takes its skills' own findings away, and keeps them when one skill is in use", () => {
    const long = kit(NAMES, { chars: { listed: 400, body: 0 } });
    expect(both(long).map((f) => f.id)).toEqual(["dead-pack:acme/kit"]);
    expect(both(kit(NAMES, {}, ["c"])).map((f) => f.id)).toEqual(
      ["a", "b", "d", "e"].map((name) => `dead-skill:skill:${name}`),
    );
  });

  it("holds only for the machines whose install is the pack's, whatever their names", () => {
    // A sixth skill keeps minSkills listed, since `a`'s listings are not all the pack's.
    const six = [...NAMES, "f"];
    for (const other of ["z-server", "a-server"]) {
      const built = report(
        [
          { ...kit(six), machine: "a-laptop" },
          scan(other, { items: [skill("a")], cells: [cell("a", 30)] }),
        ],
        { rules: { ...only("dead-pack").rules, "dead-skill": {} } },
      );
      expect(
        built.findings.map((f) => [
          f.id,
          f.where.map((w) => w.machine),
          f.fixes.map((x) => x.machine),
        ]),
      ).toEqual([
        // The server's own copy of `a` is not the pack's, so its dead-skill finding stays.
        ["dead-skill:skill:a", ["a-laptop", other].sort(), ["a-laptop", other].sort()],
        ["dead-pack:acme/kit", ["a-laptop"], six.map(() => "a-laptop")],
      ]);
    }
  });

  it("counts only the listings that are the pack's, not another machine's copies", () => {
    const laptop = scan("laptop", { items: NAMES.map((name) => packed(name)) });
    const server = scan("server", {
      items: NAMES.map((name) => skill(name)),
      cells: NAMES.map((name) => cell(name, 29)),
    });
    const built = report([laptop, server], {
      rules: { ...only("dead-pack").rules, "dead-skill": {} },
    });
    expect(built.findings.map((f) => f.id)).toEqual(
      NAMES.map((name) => `dead-skill:skill:${name}`),
    );
  });

  it("needs a listing of the pack's own, whose line names the plugin, even with minSkills 0", () => {
    const plugin = (name: string) =>
      packed(name, { managedBy: "plugin", scope: "plugin", path: `~/.claude/plugins/${name}` });
    // The server's unpacked copies sort first, so no line says the skills come with a plugin.
    const laptop = scan("laptop", { items: NAMES.map(plugin) });
    const server = scan("a-server", {
      items: NAMES.map((name) => skill(name)),
      cells: NAMES.map((name) => cell(name, 30)),
    });
    const config = { rules: { ...only("dead-pack").rules, "dead-pack": { minSkills: 0 } } };
    expect(report([laptop, server], config).findings).toEqual([]);
    // With one skill listed on the laptop alone, its line carries the plugin.
    const own = scan("laptop", {
      items: [...NAMES.map(plugin), plugin("f")],
      cells: [cell("f", 30)],
    });
    const built = report([own, server], config);
    expect(built.findings.map((f) => f.id)).toEqual(["dead-pack:acme/kit"]);
    expect(renderText(built)).toContain("No fix: its skills come with a plugin.");
  });

  it("offers no fix for a plugin, whose hooks and commands loadsheet does not read", () => {
    const plugin = kit(NAMES, { managedBy: "plugin", scope: "plugin" });
    expect(both(plugin).map((f) => [f.id, f.fixes])).toEqual([["dead-pack:acme/kit", []]]);
  });

  it("skips a harness that cannot tell use, and one with less history than dead-skill wants", () => {
    const blind = kit();
    blind.coverage = [
      coverage("laptop", "claude-code", { signals: { ...EXACT, userUse: "none" } }),
    ];
    expect(findingsOf([blind], "dead-pack")).toMatchObject({
      items: [],
      skipped: [
        {
          rule: "dead-pack",
          harness: "claude-code",
          reason: "missing-signal",
          missing: ["userUse"],
        },
      ],
    });
    const young = { ...kit(), sessions: sessions(30, { day: "2026-11-20" }) };
    expect(findingsOf([young], "dead-pack").skipped).toEqual([
      { rule: "dead-pack", harness: "claude-code", reason: "not-enough-data" },
    ]);
  });
});

describe("duplicate", () => {
  const command = skill("deploy", { path: "~/.claude/commands/deploy.md" });
  const codex = (path: string, extra: Partial<Item> = {}) =>
    skill("deploy", { harnesses: ["codex"], path, ...extra });
  const onCodex = (items: Item[]) =>
    scan("laptop", {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
      sessions: [...sessions(30), ...sessions(30, {}, "codex")],
      items,
    });
  const same = { digest: "c".repeat(64), pack: "acme/kit", managedBy: "skills" as const };

  it.each([
    [
      "fires for a skill and a command of one name",
      scan("laptop", { items: [skill("deploy"), command] }),
      ["skill:deploy"],
    ],
    [
      "fires for two contents in two Codex folders",
      onCodex([codex("~/.codex/skills/deploy"), codex("~/.agents/skills/deploy")]),
      ["skill:deploy"],
    ],
    [
      "holds for two links to one content from one source",
      onCodex([codex("~/.codex/skills/deploy", same), codex("~/.agents/skills/deploy", same)]),
      [],
    ],
    [
      "holds for one folder two harnesses load",
      onCodex([skill("deploy", { harnesses: ["claude-code", "codex"] })]),
      [],
    ],
    [
      "holds for one skill on each of two machines",
      scan("laptop", { items: [skill("deploy")] }),
      [],
    ],
  ])("%s", (_, built, expected) => {
    const result = findingsOf([built, scan("server", { items: [skill("deploy")] })], "duplicate");
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("dedupes the command Claude Code skips for the skill of its name, by its path", () => {
    const { findings } = findingsOf(
      [scan("laptop", { items: [skill("deploy"), command] })],
      "duplicate",
    );
    expect(findings).toEqual([
      {
        id: "duplicate:skill:deploy",
        rule: "duplicate",
        level: "fix",
        item: "skill:deploy",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { copies: 2 },
        fixes: [
          {
            machine: "laptop",
            action: "dedupe",
            path: "~/.claude/commands/deploy.md",
            run: "rm -r ~/.claude/commands/deploy.md",
          },
        ],
      },
    ]);
  });

  it.each([
    [
      "Codex, which lists both",
      onCodex([codex("~/.codex/skills/deploy"), codex("~/.agents/skills/deploy")]),
    ],
    [
      "a skill in use, whose copies share its id",
      scan("laptop", {
        items: [skill("deploy"), command],
        cells: [cell("deploy", 30, { byUser: 1 })],
      }),
    ],
    [
      "a skill Codex used, which no copy lists Codex for",
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [skill("deploy"), command],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("deploy", 5, { harness: "codex", byModel: 1 })],
      }),
    ],
    [
      "a command beside a project's skill, where precedence and kind disagree",
      scan("laptop", {
        items: [
          skill("deploy", { scope: "project", path: "~/work/app/.claude/skills/deploy" }),
          command,
        ],
      }),
    ],
    [
      "a command an installer manages, which removes by name",
      scan("laptop", { items: [skill("deploy"), { ...command, managedBy: "fleetrc" }] }),
    ],
    [
      "a command whose Scan does not say what removing it reaches",
      scan("laptop", {
        items: [skill("deploy"), skill("deploy", { ...command, reaches: undefined })],
      }),
    ],
    [
      "a command whose removal reaches the skill that is loaded",
      scan("laptop", {
        items: [skill("deploy"), { ...command, reaches: ["~/.claude/skills/deploy"] }],
      }),
    ],
  ])("gives no fix for %s", (_, built) => {
    const { findings } = findingsOf([built], "duplicate");
    expect(findings.map((f) => [f.id, f.fixes])).toEqual([["duplicate:skill:deploy", []]]);
  });
});

describe("heavy-instructions", () => {
  it.each([
    ["fires past maxChars", 12001, ["instructions:CLAUDE.md"]],
    ["holds at maxChars", 12000, []],
  ])("%s", (_, chars, expected) => {
    const result = findingsOf(
      [
        scan("laptop", {
          items: [instructions("CLAUDE.md", chars)],
          cells: [{ ...cell("x", 30, { chars: 30 * chars }), item: "instructions:CLAUDE.md" }],
        }),
      ],
      "heavy-instructions",
    );
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("names the size, the limit and the sessions that loaded it, with no fix", () => {
    const { findings } = findingsOf(
      [
        scan("laptop", {
          items: [instructions("CLAUDE.md", 20000), instructions("rules/short.md", 400)],
          cells: [{ ...cell("x", 30, { chars: 600000 }), item: "instructions:CLAUDE.md" }],
        }),
      ],
      "heavy-instructions",
    );
    expect(findings).toEqual([
      {
        id: "heavy-instructions:instructions:CLAUDE.md",
        rule: "heavy-instructions",
        level: "info",
        item: "instructions:CLAUDE.md",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { chars: 20000, maxChars: 12000, sessions: 30 },
        fixes: [],
      },
    ]);
  });

  it("names only the machines over the limit, and no sessions it cannot tell apart", () => {
    const loaded = (chars: number, listed: number) => ({
      ...cell("x", listed, { chars: listed * chars }),
      item: "instructions:CLAUDE.md",
    });
    const { findings } = findingsOf(
      [
        scan("laptop", { items: [instructions("CLAUDE.md", 20000)], cells: [loaded(20000, 3)] }),
        scan("server", { items: [instructions("CLAUDE.md", 900)], cells: [loaded(900, 29)] }),
      ],
      "heavy-instructions",
    );
    expect(findings.map((f) => [f.where, f.evidence])).toEqual([
      [[{ machine: "laptop", harness: "claude-code" }], { chars: 20000, maxChars: 12000 }],
    ]);
  });
});

describe("idle-mcp", () => {
  it.each([
    ["fires for a server listed and never called", [serverCell("docs", 25)], ["mcp:docs"]],
    ["holds for a server called once", [serverCell("docs", 25, { byModel: 1 })], []],
    ["holds below minSessions", [serverCell("docs", 19)], []],
  ])("%s", (_, cells, expected) => {
    const result = findingsOf([scan("laptop", { items: [server("docs")], cells })], "idle-mcp");
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("evidences its sessions and what its listing costs, with no fix", () => {
    const { findings } = findingsOf(
      [scan("laptop", { items: [server("docs")], cells: [serverCell("docs", 25)] })],
      "idle-mcp",
    );
    expect(findings).toEqual([
      {
        id: "idle-mcp:mcp:docs",
        rule: "idle-mcp",
        level: "info",
        item: "mcp:docs",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { sessions: 25, calls: 0 },
        savesTokens: { value: 50, basis: "estimated" },
        fixes: [],
      },
    ]);
  });

  it("skips a harness that cannot tell MCP use and one with fewer sessions than minSessions", () => {
    const blind = scan("laptop", {
      coverage: [coverage("laptop", "claude-code", { signals: { ...EXACT, mcp: "none" } })],
      items: [server("docs")],
      cells: [serverCell("docs", 25)],
    });
    expect(findingsOf([blind], "idle-mcp")).toMatchObject({
      items: [],
      skipped: [
        { rule: "idle-mcp", harness: "claude-code", reason: "missing-signal", missing: ["mcp"] },
      ],
    });
    const few = scan("laptop", { sessions: sessions(10), items: [server("docs")] });
    expect(findingsOf([few], "idle-mcp").skipped).toEqual([
      { rule: "idle-mcp", harness: "claude-code", reason: "not-enough-data" },
    ]);
  });
});

describe("harness-mismatch", () => {
  const both = (codex: number, extra: Partial<Scan> = {}) =>
    scan("laptop", {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
      sessions: [...sessions(30), ...(codex ? sessions(codex, {}, "codex") : [])],
      ...extra,
    });
  const agents = (name: string, extra: Partial<Item> = {}) =>
    skill(name, { harnesses: ["codex"], path: `~/.agents/skills/${name}`, ...extra });

  it.each([
    ["fires for a skill only an unused harness loads", 0, [agents("pdf")], ["skill:pdf"]],
    ["holds when that harness had a session", 1, [agents("pdf")], []],
    [
      "holds for a folder a used harness also loads",
      0,
      [agents("pdf", { harnesses: ["claude-code", "codex"] })],
      [],
    ],
  ])("%s", (_, codex, items, expected) => {
    const result = findingsOf([both(codex, { items })], "harness-mismatch");
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("removes it through the dead skill's guard, on the machines where it is unused", () => {
    const { findings } = findingsOf(
      [both(0, { items: [agents("pdf")] }), scan("server", { items: [] })],
      "harness-mismatch",
    );
    expect(findings).toEqual([
      {
        id: "harness-mismatch:skill:pdf",
        rule: "harness-mismatch",
        level: "fix",
        item: "skill:pdf",
        where: [{ machine: "laptop", harness: "codex" }],
        evidence: { sessions: 0, minSessions: 1 },
        savesTokens: { value: 30, basis: "estimated" },
        fixes: [
          {
            machine: "laptop",
            action: "remove",
            path: "~/.agents/skills/pdf",
            run: "rm -r ~/.agents/skills/pdf",
          },
        ],
      },
    ]);
    // Claude Code uses a link to the same folder under its own path: hide it from Codex instead.
    const linked = findingsOf(
      [
        both(0, {
          items: [agents("pdf"), skill("pdf", { digest: agents("pdf").digest })],
          cells: [cell("pdf", 30, { byModel: 2 })],
        }),
      ],
      "harness-mismatch",
    ).findings;
    expect(linked.map((f) => f.fixes.map((fix) => fix.action))).toEqual([["hide-from-model"]]);
  });

  it("never judges a harness that cannot tell its sessions, on that machine or as a whole", () => {
    const none = Object.fromEntries(Object.keys(EXACT).map((s) => [s, "none"])) as Record<
      Signal,
      Grade
    >;
    // Codex reads nothing here, so the folder is not judged.
    const blind = both(0, {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex", { signals: none })],
      items: [agents("pdf")],
    });
    expect(findingsOf([blind], "harness-mismatch").items).toEqual([]);
    // Codex is not covered on the server, so its folder there is not judged either.
    const server = scan("server", { items: [agents("pdf")] });
    expect(
      findingsOf([both(0, { items: [agents("pdf")] }), server], "harness-mismatch").findings,
    ).toMatchObject([{ where: [{ machine: "laptop", harness: "codex" }] }]);
  });

  it("skips a harness that no machine can tell sessions for, as missing listing", () => {
    const blind = both(0, {
      coverage: [
        coverage("laptop", "claude-code"),
        coverage("laptop", "codex", { signals: { ...EXACT, listing: "none" } }),
      ],
      items: [agents("pdf")],
    });
    expect(findingsOf([blind], "harness-mismatch")).toEqual({
      items: [],
      findings: [],
      skipped: [
        {
          rule: "harness-mismatch",
          harness: "codex",
          reason: "missing-signal",
          missing: ["listing"],
        },
      ],
    });
  });

  it("judges each machine by its own coverage, beside one whose harness cannot tell", () => {
    const blind = scan("server", {
      coverage: [
        coverage("server", "claude-code"),
        coverage("server", "codex", { signals: { ...EXACT, listing: "none" } }),
      ],
      items: [agents("pdf")],
    });
    expect(
      findingsOf([both(0, { items: [agents("pdf")] }), blind], "harness-mismatch"),
    ).toMatchObject({
      skipped: [],
      findings: [{ where: [{ machine: "laptop", harness: "codex" }] }],
    });
  });
});

describe("drift", () => {
  const copy = (digest: string) => skill("deploy", { digest: digest.repeat(64) });

  it.each([
    ["fires for one skill with two digests on two machines", "a", "b", ["skill:deploy"]],
    ["holds when both machines hold the same copy", "a", "a", []],
  ])("%s", (_, left, right, expected) => {
    const result = findingsOf(
      [scan("laptop", { items: [copy(left)] }), scan("server", { items: [copy(right)] })],
      "drift",
    );
    expect(result.items).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("counts versions and machines, and has no fix", () => {
    const { findings } = findingsOf(
      [
        scan("laptop", { items: [copy("a")] }),
        scan("server", { items: [copy("b")] }),
        scan("mini", { items: [copy("a")] }),
      ],
      "drift",
    );
    expect(findings).toEqual([
      {
        id: "drift:skill:deploy",
        rule: "drift",
        level: "fix",
        item: "skill:deploy",
        where: [
          { machine: "laptop", harness: "claude-code" },
          { machine: "mini", harness: "claude-code" },
          { machine: "server", harness: "claude-code" },
        ],
        evidence: { variants: 2, machines: 3 },
        fixes: [],
      },
    ]);
  });

  it("compares each machine's copies over every harness that loads them", () => {
    const codex = (digest: string) => ({ ...copy(digest), harnesses: ["codex"] });
    const on = (machine: string, harnesses: string[], items: Item[]) =>
      scan(machine, {
        coverage: harnesses.map((harness) => coverage(machine, harness)),
        sessions: harnesses.flatMap((harness) => sessions(30, {}, harness)),
        items,
      });
    // Each harness is on one machine only.
    expect(
      findingsOf(
        [on("laptop", ["claude-code"], [copy("a")]), on("server", ["codex"], [codex("b")])],
        "drift",
      ),
    ).toMatchObject({
      skipped: [],
      findings: [
        {
          where: [
            { machine: "laptop", harness: "claude-code" },
            { machine: "server", harness: "codex" },
          ],
          evidence: { variants: 2, machines: 2 },
        },
      ],
    });
    // Three digests in all: a and c on the laptop, b on the server.
    const both = ["claude-code", "codex"];
    expect(
      findingsOf(
        [on("laptop", both, [copy("a"), codex("c")]), on("server", both, [copy("b"), codex("b")])],
        "drift",
      ).findings.map((f) => f.evidence),
    ).toEqual([{ variants: 3, machines: 2 }]);
  });

  it("finds nothing in a local Report, whatever Scans it reads", () => {
    const built = buildReport({
      scans: [scan("laptop", { items: [copy("a")] }), scan("server", { items: [copy("b")] })],
      config: resolveConfig(only("drift")),
      now: NOW,
      tool: "loadsheet@0.0.1",
      mode: "local",
    });
    expect(built.findings).toEqual([]);
  });

  it("finds nothing on one machine, where two copies are a duplicate and not drift", () => {
    const one = scan("laptop", {
      items: [copy("a"), { ...copy("b"), path: "~/.claude/commands/deploy.md" }],
    });
    expect(findingsOf([one], "drift")).toMatchObject({ items: [], skipped: [] });
  });
});

describe("short-history", () => {
  const young = (extra: Partial<Scan> = {}) =>
    scan("laptop", { sessions: sessions(30, { day: "2026-11-20" }), ...extra });

  it.each([
    ["fires for a harness with days of history", young(), ["claude-code"]],
    ["holds with the whole window", scan("laptop"), []],
    ["holds for a harness without sessions", scan("laptop", { sessions: [] }), []],
  ])("%s", (_, built, expected) => {
    const result = findingsOf([built], "short-history");
    expect(result.findings.map((f) => f.where[0]?.harness)).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it("is about the harness, has no fix, and judges a shorter window by its own length", () => {
    const { findings } = findingsOf([young()], "short-history");
    expect(findings).toEqual([
      {
        id: "short-history:claude-code",
        rule: "short-history",
        level: "info",
        where: [{ machine: "laptop", harness: "claude-code" }],
        evidence: { days: 5, sessions: 30, minDays: 30 },
        fixes: [],
      },
    ]);
    const week = scan("laptop", {
      sessions: [...sessions(5, { day: "2026-11-18" }), ...sessions(5, { day: LAST })],
    });
    expect(findingsOf([week], "short-history", { window: 7 }).findings).toEqual([]);
  });

  it("skips a harness without listing", () => {
    const blind = young({
      coverage: [coverage("laptop", "claude-code", { signals: { ...EXACT, listing: "none" } })],
    });
    expect(findingsOf([blind], "short-history")).toMatchObject({
      items: [],
      skipped: [
        {
          rule: "short-history",
          harness: "claude-code",
          reason: "missing-signal",
          missing: ["listing"],
        },
      ],
    });
  });
});

describe("fixes", () => {
  const dead = (items: Item[], extra: Partial<Scan> = {}) =>
    report([scan("laptop", { items, cells: [cell("idle", 25)], ...extra })]).findings;

  it("a cut finding takes the item's fix-level findings away", () => {
    const findings = dead([skill("idle", { chars: { listed: 900, body: 0 } })]);
    expect(findings.map((f) => f.id)).toEqual(["dead-skill:skill:idle"]);
  });

  it("a cut finding keeps a fix-level finding where the cut does not reach", () => {
    // Dead in Claude Code, used by hand only in Codex: the manual-only finding is Codex's alone.
    const findings = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [
          skill("idle", {
            managedBy: "plugin",
            scope: "plugin",
            pack: "kit",
            path: "~/.claude/plugins/cache/m/kit/1.0.0/skills/idle",
          }),
          skill("idle", { harnesses: ["codex"], path: "~/.agents/skills/idle" }),
        ],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("idle", 25), cell("idle", 25, { harness: "codex", byUser: 3 })],
      }),
    ]).findings;
    expect(findings.map((f) => [f.rule, f.where.map((w) => w.harness)])).toEqual([
      ["dead-skill", ["claude-code"]],
      ["manual-only", ["codex"]],
    ]);
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
      sessions: [...sessions(30), ...sessions(30, {}, "codex")],
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

  it("keeps a folder another harness uses under an id of its own", () => {
    // `name: weekly  report` is `weekly` to Claude Code and `weekly report` to Codex.
    const path = "~/.agents/skills/weekly";
    const findings = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [skill("weekly", { path }), skill("weekly report", { harnesses: ["codex"], path })],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [
          cell("weekly", 25),
          cell("weekly report", 25, { harness: "codex", byUser: 2, byModel: 2 }),
        ],
      }),
    ]).findings;
    expect(findings.map((f) => [f.id, f.fixes])).toEqual([
      [
        "dead-skill:skill:weekly",
        [
          {
            machine: "laptop",
            action: "hide-from-model",
            path: "~/.agents/skills/weekly/SKILL.md",
            set: { key: "disable-model-invocation", value: true },
          },
        ],
      ],
    ]);
  });

  it("keeps a folder another harness reaches through a link", () => {
    // `~/.agents/skills/weekly` links to it. Codex reads its name its own way, and uses it.
    const mine = skill("weekly", { reaches: ["~/.agents/skills/weekly"] });
    const link = skill("weekly report", {
      harnesses: ["codex"],
      path: "~/.agents/skills/weekly",
      reaches: [mine.path],
    });
    const fixes = dead([mine, link], {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
      sessions: [...sessions(30), ...sessions(30, {}, "codex")],
      cells: [cell("weekly", 25), cell("weekly report", 25, { harness: "codex", byUser: 2 })],
    }).find((f) => f.rule === "dead-skill")!.fixes;
    expect(fixes.map((fix) => [fix.action, fix.run])).toEqual([["hide-from-model", undefined]]);
  });

  it("keeps a folder holding a skill another harness reaches through a link to it", () => {
    // `~/.agents/skills/child` links to a folder inside `weekly`, and Codex uses it: `rm -r` of
    // `weekly` would take it.
    const child = skill("child", { harnesses: ["codex"], path: "~/.agents/skills/child" });
    const mine = skill("weekly", { reaches: [child.path] });
    const findings = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [mine, child],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("weekly", 25), cell("child", 25, { harness: "codex", byModel: 2 })],
      }),
    ]).findings;
    expect(findings.find((f) => f.rule === "dead-skill")!.fixes).toEqual([
      {
        machine: "laptop",
        action: "hide-from-model",
        path: "~/.claude/skills/weekly/SKILL.md",
        set: { key: "disable-model-invocation", value: true },
      },
    ]);
  });

  it("removes nothing when the Scan does not say what the removal reaches", () => {
    const actions = (items: Item[], scans: Scan[] = []) =>
      report([scan("laptop", { items, cells: [cell("idle", 25)] }), ...scans])
        .findings.find((f) => f.rule === "dead-skill")!
        .fixes.map((fix) => [fix.action, fix.run]);
    const hidden = [["hide-from-model", undefined]];
    expect(actions([skill("idle")])).toEqual([["remove", "rm -r ~/.claude/skills/idle"]]);
    // A Scan written without it.
    expect(actions([skill("idle", { reaches: undefined })])).toEqual(hidden);
    // It names a path none of the Scan's Items is at.
    expect(actions([skill("idle", { reaches: ["~/.agents/skills/gone"] })])).toEqual(hidden);
    // fleetrc unlinks the name on every machine, and one machine's Scan does not say.
    const linked = skill("idle", { managedBy: "fleetrc", pack: "mine" });
    const removed = [["remove", "fleetrc remove idle"]];
    expect(actions([linked], [scan("server", { items: [linked] })])).toEqual([
      ...removed,
      ...removed,
    ]);
    expect(
      actions([linked], [scan("server", { items: [{ ...linked, reaches: undefined }] })]),
    ).toEqual([...hidden, ...hidden]);
  });

  it("keeps a folder holding another skill this harness uses", () => {
    const child = skill("child", { path: "~/.claude/skills/idle/child" });
    const fixes = dead([skill("idle", { reaches: [child.path] }), child], {
      cells: [cell("idle", 25), cell("child", 25, { byModel: 2 })],
    }).find((f) => f.id === "dead-skill:skill:idle")!.fixes;
    expect(fixes.map((fix) => [fix.action, fix.run])).toEqual([["hide-from-model", undefined]]);
  });

  it("gives no fix for a file this harness used under another id", () => {
    // One machine's Scans merged: the folder's skill was renamed between them.
    const before = skill("old-name", { path: "~/.claude/skills/idle" });
    const fixes = dead([skill("idle"), before], {
      cells: [cell("idle", 25), cell("old-name", 25, { byModel: 2 })],
    }).find((f) => f.id === "dead-skill:skill:idle")!.fixes;
    expect(fixes).toEqual([]);
  });

  it("writes `rm -r` without a trailing slash, which would empty a link's folder", () => {
    const [finding] = dead([skill("idle", { path: "~/.claude/skills/idle/" })]);
    expect(finding!.fixes.map((fix) => fix.run)).toEqual(["rm -r ~/.claude/skills/idle"]);
  });

  it("removes each copy of a dead skill made by hand, unless one reaches the other", () => {
    const project = { scope: "project" as const, path: "~/work/app/.claude/skills/idle" };
    const runs = (mine: Partial<Item>, other: Partial<Item>) =>
      dead([skill("idle", mine), skill("idle", { ...project, ...other })])
        .find((f) => f.id === "dead-skill:skill:idle")!
        .fixes.map((fix) => fix.run);
    expect(runs({}, {})).toEqual(["rm -r ~/.claude/skills/idle", `rm -r ${project.path}`]);
    // The Scan says removing mine reaches the project's copy, and not the other way round.
    expect(runs({ reaches: [project.path] }, {})).toEqual([undefined, `rm -r ${project.path}`]);
  });

  it("removes a dead skill whose content another, used skill at another place shares", () => {
    const mine = skill("weekly");
    const other = skill("report", {
      harnesses: ["codex"],
      path: "~/.agents/skills/report",
      digest: mine.digest,
    });
    const findings = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [mine, other],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("weekly", 25), cell("report", 25, { harness: "codex", byModel: 2 })],
      }),
    ]).findings;
    expect(findings.find((f) => f.rule === "dead-skill")!.fixes).toEqual([
      {
        machine: "laptop",
        action: "remove",
        path: "~/.claude/skills/weekly",
        run: "rm -r ~/.claude/skills/weekly",
      },
    ]);
  });

  it("reads another harness's use before any filter, and keeps a path whose other harness cannot tell use", () => {
    const shared = skill("idle", {
      harnesses: ["claude-code", "codex"],
      path: "~/.agents/skills/idle",
    });
    const hidden = [
      {
        machine: "laptop",
        action: "hide-from-model",
        path: "~/.agents/skills/idle/SKILL.md",
        set: { key: "disable-model-invocation", value: true },
      },
    ];
    const fixesOf = (extra: Partial<Scan>, config: Config = {}) =>
      report(
        [
          scan("laptop", {
            items: [shared],
            coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
            sessions: [
              ...sessions(30),
              ...sessions(30, {}, "codex"),
              ...sessions(5, { via: "app" }, "codex"),
            ],
            cells: [cell("idle", 25), cell("idle", 25, { harness: "codex" })],
            ...extra,
          }),
        ],
        config,
      ).findings.find((f) => f.rule === "dead-skill")!.fixes;
    const usedInApp = {
      cells: [
        cell("idle", 25),
        cell("idle", 25, { harness: "codex" }),
        cell("idle", 5, { harness: "codex", via: "app", byModel: 2 }),
      ],
    };
    // Codex used it only through an entrypoint the via filter leaves out, or outside the harnesses read.
    expect(fixesOf(usedInApp, { via: { include: ["cli"] } })).toEqual(hidden);
    expect(fixesOf(usedInApp, { harnesses: ["claude-code"] })).toEqual(hidden);
    // Codex is not covered on this machine, or cannot tell use there.
    expect(fixesOf({ coverage: [coverage("laptop", "claude-code")] })).toEqual(hidden);
    const blind = coverage("laptop", "codex", { signals: { ...EXACT, modelUse: "none" } });
    expect(fixesOf({ coverage: [coverage("laptop", "claude-code"), blind] })).toEqual(hidden);
    // Claude Code itself used it through an entrypoint the filter leaves out: no fix at all.
    expect(
      fixesOf(
        { cells: [cell("idle", 25), cell("idle", 3, { via: "app", byUser: 1 })] },
        { via: { include: ["cli"] } },
      ),
    ).toEqual([]);
  });

  it("turns a skill off in Codex's own config when an installer owns its folder and another harness uses it", () => {
    const shared = skill("idle", {
      harnesses: ["claude-code", "codex"],
      managedBy: "fleetrc",
      path: "~/.agents/skills/idle",
    });
    const fixes = (items: Item[]) =>
      dead(items, {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("idle", 25, { byModel: 2 }), cell("idle", 25, { harness: "codex" })],
      }).find((f) => f.rule === "dead-skill")!.fixes;
    expect(fixes([shared])).toEqual([
      {
        machine: "laptop",
        action: "set",
        path: "~/.codex/config.toml",
        set: { key: 'skills.config[path="~/.agents/skills/idle/SKILL.md"].enabled', value: false },
      },
    ]);
    // CODEX_HOME moves the config: an MCP server's Item names the config.toml it came from.
    const server: Item = {
      ...skill("x"),
      id: "mcp:docs",
      ref: { kind: "mcp", name: "docs" },
      harnesses: ["codex"],
      path: "~/.config/codex/config.toml",
    };
    expect(fixes([shared, server]).map((fix) => fix.path)).toEqual(["~/.config/codex/config.toml"]);
    // A plugin's path holds its version, so an entry for it would not last.
    const plugin = { ...shared, managedBy: "plugin" as const, scope: "plugin" as const };
    expect(fixes([plugin])).toEqual([]);
  });

  it("offers no hide or turn-off for a copy the model already may not invoke", () => {
    const copy = skill("idle", {
      harnesses: ["codex"],
      managedBy: "fleetrc",
      path: "~/.agents/skills/idle",
    });
    const fixes = (item: Item) =>
      dead([item], {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("idle", 25, { byModel: 2 }), cell("idle", 25, { harness: "codex" })],
      }).find((f) => f.rule === "dead-skill")!.fixes;
    expect(fixes(copy).map((fix) => fix.action)).toEqual(["set"]);
    // Turned off since: past sessions keep the finding, and there is nothing left to turn off.
    expect(fixes({ ...copy, modelInvocable: false, chars: { listed: 0, body: 900 } })).toEqual([]);
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
    // A local Report knows one machine, and `fleetrc remove` reaches every machine.
    [
      "fleetrc",
      { managedBy: "fleetrc" },
      {
        action: "hide-from-model",
        path: "~/.claude/settings.json",
        set: { key: "skillOverrides.idle", value: "user-invocable-only" },
      },
    ],
    // A plugin update replaces the file a hide would edit, so nothing lasts.
    [
      "plugin",
      {
        managedBy: "plugin",
        scope: "plugin",
        pack: "kit",
        path: "~/.claude/plugins/cache/m/kit/1.0.0/skills/idle",
      },
      undefined,
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
    expect(finding!.fixes).toEqual(fix ? [{ machine: "laptop", ...fix }] : []);
  });

  it("hides a hand-made skill whose folder holds another skill, which `rm -r` would delete too", () => {
    const [finding] = dead(
      [
        skill("idle", {
          harnesses: ["codex"],
          path: "~/.agents/skills/idle",
          reaches: ["~/.agents/skills/idle/child"],
        }),
        skill("child", { harnesses: ["codex"], path: "~/.agents/skills/idle/child" }),
      ],
      {
        coverage: [coverage("laptop", "codex")],
        sessions: [...sessions(30, {}, "codex")],
        cells: [cell("idle", 25, { harness: "codex" })],
      },
    );
    expect(finding!.fixes).toEqual([
      {
        machine: "laptop",
        action: "hide-from-model",
        path: "~/.agents/skills/idle/agents/openai.yaml",
        set: { key: "policy.allow_implicit_invocation", value: false },
      },
    ]);
  });

  it("gives a plugin's skill no fix in either harness, and keeps the finding", () => {
    const plugin = (harness: string, path: string) =>
      skill("manual", {
        harnesses: [harness],
        managedBy: "plugin",
        scope: "plugin",
        pack: "kit",
        path,
      });
    const findings = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [
          plugin("claude-code", "~/.claude/plugins/cache/m/kit/1.0.0/skills/manual"),
          plugin("codex", "~/.codex/plugins/cache/m/kit/1.0.0/skills/manual"),
        ],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [
          cell("manual", 30, { byUser: 3 }),
          cell("manual", 30, { byUser: 3, harness: "codex" }),
        ],
      }),
    ]).findings;
    expect(findings.map((f) => [f.rule, f.where.map((w) => w.harness), f.fixes])).toEqual([
      ["manual-only", ["claude-code", "codex"], []],
    ]);
    // Removing it from one harness while the other still uses it would hide it, which does not last.
    const dead = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [
          skill("idle", {
            harnesses: ["claude-code", "codex"],
            managedBy: "plugin",
            scope: "plugin",
            pack: "kit",
            path: "~/.claude/plugins/cache/m/kit/1.0.0/skills/idle",
          }),
        ],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("idle", 25), cell("idle", 25, { harness: "codex", byModel: 2 })],
      }),
    ]).findings;
    expect(dead.map((f) => [f.rule, f.fixes])).toEqual([["dead-skill", []]]);
  });

  it.each(["skills", "fleetrc"] as const)(
    "gives a Codex skill %s manages no hide fix, since the file would not last; Claude Code's goes in settings",
    (managedBy) => {
      const installed = (harness: string, path: string) =>
        skill("manual", { harnesses: [harness], managedBy, pack: "acme", path });
      const findings = report([
        scan("laptop", {
          coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
          items: [
            installed("claude-code", "~/.claude/skills/manual"),
            installed("codex", "~/.agents/skills/manual"),
          ],
          sessions: [...sessions(30), ...sessions(30, {}, "codex")],
          cells: [
            cell("manual", 30, { byUser: 3 }),
            cell("manual", 30, { byUser: 3, harness: "codex" }),
          ],
        }),
      ]).findings;
      expect(findings.map((f) => [f.rule, f.fixes])).toEqual([
        [
          "manual-only",
          [
            {
              machine: "laptop",
              action: "hide-from-model",
              path: "~/.claude/settings.json",
              set: { key: "skillOverrides.manual", value: "user-invocable-only" },
            },
          ],
        ],
      ]);
    },
  );

  it("runs one command once on a machine: fleetrc removes the skill from every agent", () => {
    const linked = (harness: string, path: string) =>
      skill("idle", { harnesses: [harness], managedBy: "fleetrc", pack: "mine", path });
    const findings = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
        items: [
          linked("claude-code", "~/.claude/skills/idle"),
          linked("codex", "~/.agents/skills/idle"),
        ],
        sessions: [...sessions(30), ...sessions(30, {}, "codex")],
        cells: [cell("idle", 25), cell("idle", 25, { harness: "codex" })],
      }),
      scan("server"),
    ]).findings;
    expect(findings.map((f) => [f.rule, f.fixes])).toEqual([
      [
        "dead-skill",
        [
          {
            machine: "laptop",
            action: "remove",
            path: "~/.claude/skills/idle",
            run: "fleetrc remove idle",
          },
        ],
      ],
    ]);
  });

  it("gives no fleetrc command for a skill named like a source on any machine, which fleetrc would remove whole", () => {
    const built = report([
      scan("laptop", {
        items: [skill("idle", { managedBy: "fleetrc", pack: "mine" })],
        cells: [cell("idle", 25)],
      }),
      // The source is linked only on the server.
      scan("server", {
        items: [
          skill("other", { managedBy: "fleetrc", pack: "Idle", path: "~/.claude/skills/other" }),
        ],
      }),
    ]);
    expect(built.findings).toMatchObject([{ id: "dead-skill:skill:idle", fixes: [] }]);
  });

  it("gives `fleetrc remove` only in a fleet Report that read every machine and found no use", () => {
    const linked = skill("idle", { managedBy: "fleetrc", pack: "mine" });
    const laptop = scan("laptop", { items: [linked], cells: [cell("idle", 25)] });
    const fixesOf = (scans: Scan[], machines: BuildReportInput["machines"] = []) =>
      buildReport({ scans, machines, config: resolveConfig(), now: NOW, tool: "t" }).findings.find(
        (f) => f.rule === "dead-skill",
      )!.fixes;
    const hidden = [
      {
        machine: "laptop",
        action: "hide-from-model",
        path: "~/.claude/settings.json",
        set: { key: "skillOverrides.idle", value: "user-invocable-only" },
      },
    ];
    expect(fixesOf([laptop, scan("server")]).map((fix) => fix.run)).toEqual([
      "fleetrc remove idle",
    ]);
    // A machine could not be read, so its use is unknown.
    expect(fixesOf([laptop], [{ name: "mini", reachable: false, error: "timed out" }])).toEqual(
      hidden,
    );
    // A machine listed as reachable with no Scan: its use is unknown too.
    expect(fixesOf([laptop, scan("server")], [{ name: "mini", reachable: true }])).toEqual(hidden);
    // The server's copy is loaded by Codex too, which cannot tell use there.
    const blind = scan("server", {
      coverage: [
        coverage("server", "claude-code"),
        coverage("server", "codex", { signals: { ...EXACT, modelUse: "none" } }),
      ],
      items: [{ ...linked, harnesses: ["claude-code", "codex"] }],
    });
    expect(fixesOf([laptop, blind])).toEqual([...hidden, { ...hidden[0]!, machine: "server" }]);
    // The server reads the same linked folder under another name, and uses it.
    const renamed = scan("server", {
      items: [{ ...linked, id: "skill:idle-report", ref: { kind: "skill", name: "idle-report" } }],
      cells: [cell("idle-report", 25, { byModel: 3 })],
    });
    expect(fixesOf([laptop, renamed])).toEqual(hidden);
    // Codex on the server uses `~/.agents/skills/child`, a link through the linked folder to a
    // skill inside its source, which the unlink would take too.
    const nested = scan("server", {
      coverage: [coverage("server", "claude-code"), coverage("server", "codex")],
      items: [
        { ...linked, reaches: ["~/.agents/skills/child"] },
        skill("child", { harnesses: ["codex"], path: "~/.agents/skills/child" }),
      ],
      sessions: [...sessions(30), ...sessions(30, {}, "codex")],
      cells: [cell("child", 25, { harness: "codex", byModel: 3 })],
    });
    expect(fixesOf([laptop, nested])).toEqual([...hidden, { ...hidden[0]!, machine: "server" }]);
    // Codex on the server used it, which the sheet of the harnesses read does not show.
    const server = scan("server", {
      coverage: [coverage("server", "codex")],
      sessions: [...sessions(30, {}, "codex")],
      cells: [cell("idle", 5, { harness: "codex", byUser: 1 })],
    });
    expect(
      buildReport({
        scans: [laptop, server],
        config: resolveConfig({ harnesses: ["claude-code"] }),
        now: NOW,
        tool: "t",
      }).findings.find((f) => f.rule === "dead-skill")!.fixes,
    ).toEqual(hidden);
  });

  it("hides a skill another harness used, though the Scan lists no copy for that harness", () => {
    // Codex's use is read from the files it opened, so it can use a skill it does not load.
    const laptop = scan("laptop", {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
      items: [skill("idle")],
      sessions: [...sessions(30), ...sessions(30, {}, "codex")],
      cells: [cell("idle", 25), cell("idle", 5, { harness: "codex", byModel: 1 })],
    });
    expect(
      report([laptop], { harnesses: ["claude-code"] }).findings.map((f) => [f.rule, f.fixes]),
    ).toEqual([
      [
        "dead-skill",
        [
          {
            machine: "laptop",
            action: "hide-from-model",
            path: "~/.claude/skills/idle/SKILL.md",
            set: { key: "disable-model-invocation", value: true },
          },
        ],
      ],
    ]);
  });

  it("a harness without a fix table gets nothing for a skill fleetrc links on another machine", () => {
    const linked = (harness: string, path: string) =>
      skill("idle", { harnesses: [harness], managedBy: "fleetrc", pack: "source", path });
    const laptop = scan("laptop", {
      coverage: [coverage("laptop", "cursor")],
      items: [linked("cursor", "~/.cursor/skills/idle")],
      sessions: [...sessions(30, {}, "cursor")],
      cells: [cell("idle", 25, { harness: "cursor" })],
    });
    // Pi loads the same name there and cannot tell use.
    const none = Object.fromEntries(Object.keys(EXACT).map((signal) => [signal, "none"]));
    const server = scan("server", {
      coverage: [coverage("server", "pi", { sessions: 0, signals: none as typeof EXACT })],
      items: [linked("pi", "~/.agents/skills/idle")],
      sessions: [],
    });
    expect(
      report([laptop, server], { harnesses: ["cursor"] }).findings.map((f) => [f.rule, f.fixes]),
    ).toEqual([["dead-skill", []]]);
  });

  it("a harness without a fix table gets the path and no command, and nothing to hide", () => {
    const item = skill("idle", { harnesses: ["cursor"], path: "~/.cursor/skills/idle" });
    const cursor = (cells: Cell[]) =>
      report([
        scan("laptop", {
          coverage: [coverage("laptop", "cursor")],
          items: [item],
          sessions: [...sessions(30, {}, "cursor")],
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
        sessions: [...sessions(10, { fixedTokens: 10000, measured: 5 })],
        cells: [cell("tool", 10, { byModel: 2, day: "2026-11-18" })],
      }),
      scan("server", {
        window: ["2026-11-01", "2026-11-23"],
        coverage: [coverage("server", "claude-code", { lastDay: "2026-11-23" })],
        items: [skill("tool", { chars: { listed: 140, body: 900 } })],
        sessions: [...sessions(30, { fixedTokens: 30000, measured: 5 })],
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

  it("measures a line whose install lists nothing by what its sessions held", () => {
    // An MCP server's Item cannot know its listing's size; the transcripts saw 200 characters.
    const server: Item = {
      ...skill("x"),
      id: "mcp:docs",
      ref: { kind: "mcp", name: "docs" },
      chars: { listed: 0, body: 0 },
    };
    const [sheet] = report([
      scan("laptop", {
        items: [server],
        cells: [{ ...cell("x", 30, { chars: 6000 }), item: "mcp:docs" }],
      }),
    ]).sheet;
    expect(sheet!.lines[0]).toMatchObject({
      item: "mcp:docs",
      chars: { listed: 200, body: 0 },
      tokens: { value: 50, basis: "estimated" },
    });
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
        sessions: [...sessions(10), ...sessions(30, { via: "app" })],
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

  it("keeps only the last `window` days of a Scan that covers more, and counts days after every filter", () => {
    const long = scan("laptop", {
      window: ["2026-09-26", LAST],
      items: [skill("tool")],
      sessions: [
        ...sessions(10, { day: "2026-10-01" }),
        ...sessions(20, { day: "2026-11-20" }),
        ...sessions(5, { day: FIRST, via: "app" }),
      ],
      cells: [
        cell("tool", 10, { day: "2026-10-01", byModel: 4 }),
        cell("tool", 20, { day: "2026-11-20", byModel: 1 }),
      ],
    });
    const built = report([long], { window: 30 });
    expect(built.window).toEqual([FIRST, LAST]);
    const [sheet] = built.sheet;
    expect([sheet!.sessions, sheet!.lines[0]!.exposure.sessions, sheet!.lines[0]!.use]).toEqual([
      25,
      20,
      { byModel: 1, byUser: 0, lastUsed: "2026-11-20" },
    ]);
    // Without the app's sessions, the history left is one day.
    const idle = { ...long, cells: [cell("tool", 20, { day: "2026-11-20" })] };
    expect(findingsOf([idle], "dead-skill").items).toEqual(["skill:tool"]);
    expect(findingsOf([idle], "dead-skill", { via: { include: ["cli"] } }).skipped).toEqual([
      { rule: "dead-skill", harness: "claude-code", reason: "not-enough-data" },
    ]);
  });

  it("counts coverage from the sessions the report kept, for the harnesses it is about", () => {
    const both = scan("laptop", {
      coverage: [coverage("laptop", "claude-code"), coverage("laptop", "codex")],
      sessions: [
        ...sessions(10, { day: "2026-10-01" }),
        ...sessions(20, { day: "2026-11-20" }),
        ...sessions(5, { day: "2026-11-22", via: "app" }),
        ...sessions(5, {}, "codex"),
      ],
    });
    const rows = (config: Config) =>
      report([both], config).coverage.map(({ harness, sessions, firstDay, lastDay }) => ({
        harness,
        sessions,
        firstDay,
        lastDay,
      }));
    expect(rows({ window: 30, via: { include: ["cli"] }, harnesses: ["claude-code"] })).toEqual([
      { harness: "claude-code", sessions: 20, firstDay: "2026-11-20", lastDay: "2026-11-20" },
    ]);
    // A harness with no session kept has no first or last day.
    expect(rows({ window: 1 })).toEqual([
      { harness: "claude-code", sessions: 0, firstDay: undefined, lastDay: undefined },
      { harness: "codex", sessions: 0, firstDay: undefined, lastDay: undefined },
    ]);
    expect(report([both], { window: 1 }).coverage[0]).not.toHaveProperty("firstDay");
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
      sessions: [...sessions(30), ...sessions(5, {}, "codex")],
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

describe("what a session starts with", () => {
  const cellOn = (day: string, fixedTokens: number, measured: number): SessionCell => ({
    day,
    harness: "claude-code",
    via: "cli",
    sessions: measured,
    fixedTokens,
    measured,
  });

  it("averages fixedTokens over the last 7 days, and over the window when none in them reported", () => {
    const recent = report([
      scan("laptop", {
        sessions: [
          cellOn(FIRST, 50_000, 5),
          cellOn("2026-11-17", 40_000, 2),
          cellOn("2026-11-18", 30_000, 3),
        ],
      }),
    ]);
    expect(recent.sheet[0]!.fixedTokens).toEqual({ value: 10_000, basis: "measured" });

    const old = report([
      scan("laptop", { sessions: [cellOn(FIRST, 50_000, 5), cellOn("2026-11-17", 40_000, 5)] }),
    ]);
    expect(old.sheet[0]!.fixedTokens).toEqual({ value: 9_000, basis: "measured" });
  });

  it("gives each sheet the largest context window any machine reports", () => {
    const built = report([
      scan("laptop", { coverage: [coverage("laptop", "claude-code", { contextWindow: 200_000 })] }),
      scan("server", {
        coverage: [coverage("server", "claude-code", { contextWindow: 1_000_000 })],
      }),
      scan("mini", { coverage: [coverage("mini", "claude-code")] }),
    ]);
    expect(built.sheet[0]!.contextWindow).toBe(1_000_000);
    expect(report([scan("laptop")]).sheet[0]!.contextWindow).toBeUndefined();
  });

  it("splits it into the setup, the lines with a scope, and the harness's own", () => {
    const built = report([
      scan("laptop", {
        items: [
          skill("a", { chars: { listed: 400, body: 0 } }),
          skill("b", { chars: { listed: 800, body: 0 } }),
        ],
        sessions: [cellOn("2026-11-20", 10_000, 1)],
        cells: [cell("a", 1, { chars: 400 }), cell("b", 1, { chars: 800 })],
      }),
    ]);
    const sheet = built.sheet[0]!;
    const setup = sheet.lines.reduce((sum, line) => sum + line.tokens.value, 0);
    expect(setup).toBeGreaterThan(0);
    expect(setupTokens(sheet)).toBe(setup);
    expect(harnessTokens(sheet)).toBe(10_000 - setup);
    expect(harnessTokens({ ...sheet, fixedTokens: { value: 1, basis: "measured" } })).toBe(0);
    const { fixedTokens: _fixed, ...unmeasured } = sheet;
    expect(harnessTokens(unmeasured)).toBeUndefined();
    expect(renderText(built)).toContain(
      `your setup ~${setup.toLocaleString("en-US")}, the harness's own`,
    );
  });

  it("puts a skill's or subagent's description on its line", () => {
    const built = report([
      scan("laptop", {
        items: [skill("a", { description: "Use when deploying." })],
        cells: [cell("a", 30)],
      }),
    ]);
    expect(built.sheet[0]!.lines[0]!.description).toBe("Use when deploying.");
  });

  it("says when no session was found, instead of no findings", () => {
    const empty = report([
      scan("laptop", {
        coverage: [coverage("laptop", "claude-code", { sessions: 0 })],
        sessions: [],
      }),
    ]);
    const text = renderText(empty);
    expect(text).toContain("No Claude Code or Codex sessions were found on this machine");
    expect(text).not.toContain("No findings");
  });
});

import { readFileSync } from "node:fs";
import {
  parseReport,
  resolveConfig,
  type Coverage,
  type Finding,
  type Fix,
  type Grade,
  type Line,
  type Report,
  type Signal,
} from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import { PROMPT_DOC, renderText } from "../src/index.ts";

const example = (name: string) =>
  parseReport(
    JSON.parse(readFileSync(new URL(`../../../examples/${name}`, import.meta.url), "utf8")),
  );

const SIGNALS: Record<Signal, Grade> = {
  listing: "exact",
  modelUse: "exact",
  userUse: "inferred",
  instructions: "exact",
  mcp: "none",
  tokens: "exact",
};

const line = (name: string, tokens: number, extra: Partial<Line> = {}): Line => ({
  item: `skill:${name}`,
  ref: { kind: "skill", name },
  scope: "user",
  managedBy: "hand",
  machines: ["desk"],
  path: `~/.claude/skills/${name}`,
  chars: { listed: tokens * 4, body: 1000 },
  tokens: { value: tokens, basis: "estimated" },
  exposure: { sessions: 40, share: 1, bare: 0 },
  use: { byModel: 0, byUser: 0 },
  ...extra,
});

const finding = (rule: string, name: string, fixes: Fix[], extra: Partial<Finding> = {}) =>
  ({
    id: `${rule}:skill:${name}`,
    rule,
    level: "cut",
    item: `skill:${name}`,
    where: [{ machine: "desk", harness: "claude-code" }],
    evidence: { sessions: 40, days: 30, byModel: 0, byUser: 0 },
    savesTokens: { value: 50, basis: "estimated" },
    fixes,
    ...extra,
  }) satisfies Finding;

const coverage = (machine: string, harness: string, extra: Partial<Coverage> = {}): Coverage => ({
  machine,
  harness,
  installed: true,
  sessions: 40,
  versions: [],
  firstDay: "2026-10-26",
  lastDay: "2026-11-24",
  signals: SIGNALS,
  ...extra,
});

/** A local Report of one machine, `desk`, with these lines on Claude Code and these findings. */
const report = (lines: Line[], findings: Finding[], extra: Partial<Report> = {}): Report =>
  parseReport({
    schema: 1,
    tool: "loadsheet@0.0.1",
    generatedAt: "2026-11-24T12:00:00.000Z",
    mode: "local",
    machines: [{ name: "desk", reachable: true, scannedAt: "2026-11-24T12:00:00.000Z" }],
    window: ["2026-10-26", "2026-11-24"],
    config: resolveConfig(),
    coverage: [coverage("desk", "claude-code")],
    sheet: [
      {
        harness: "claude-code",
        sessions: 40,
        fixedTokens: { value: 21500, basis: "measured" },
        lines,
      },
    ],
    findings,
    skipped: [],
    ...extra,
  });

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe("renderText on the fleet example", () => {
  const fleet = example("report.example.json");
  const text = renderText(fleet);

  it("opens with the window, the machines and each harness's sessions and fixed tokens", () => {
    expect(text).toMatch(
      /^loadsheet@0\.0\.1: fleet report, 2026-10-25 to 2026-11-23 \(30 days\)\n/u,
    );
    expect(text).toContain("Machines: laptop, server\n");
    expect(text).toContain("not read: mini (ssh: connect to host mini port 22");
    expect(text).toMatch(
      /claude-code {2}598 sessions {2}each starts with ~17,317 tokens \(measured\)/u,
    );
    expect(text).toMatch(/codex {8}204 sessions {2}each starts with ~11,677 tokens \(measured\)/u);
  });

  it("prints every fix in full: machines, action, path, command and key", () => {
    for (const { fixes } of fleet.findings) {
      for (const fix of fixes) {
        expect(text).toContain(`${fix.action} ${fix.path}`);
        if (fix.run) expect(text).toContain(`$ ${fix.run}`);
        if (fix.set) expect(text).toContain(`${fix.set.key} = ${JSON.stringify(fix.set.value)}`);
      }
    }
    expect(text).toContain(
      "on laptop, server: remove ~/.claude/skills/sql-tuner  $ npx skills remove sql-tuner",
    );
    expect(text).toContain(
      'on server: set ~/.config/fleetrc/manifest.toml  skills.deploy-preview.source = "laptop"',
    );
  });

  it("has one coverage row per machine and harness, a grade per signal", () => {
    const rows = text.split("\n").filter((row) => /^ {2}(laptop|server) {3}\S/u.test(row));
    expect(rows).toHaveLength(fleet.coverage.length);
    expect(rows).toContain(
      "  laptop   codex             140  exact    inferred  -        exact         exact  exact",
    );
    expect(rows).toContain(
      "  server   opencode            0  -        -         -        -             -      -",
    );
  });

  it("names the rules that did not run and why, and closes on --json and the prompt", () => {
    expect(text).toMatch(/dead-skill {7}codex: no userUse; cursor: no listing, modelUse, userUse/u);
    expect(text).toMatch(/idle-mcp {9}opencode: too little data/u);
    expect(text).toContain("run it again with --json");
    expect(text.trimEnd().endsWith(PROMPT_DOC)).toBe(true);
  });

  it("ends on the summary of the findings, where a terminal leaves the reader", () => {
    const summary = text.indexOf(`${fleet.findings.length} findings; the number is tokens`);
    const lastFix = Math.max(
      ...fleet.findings.flatMap(({ fixes }) => fixes.map(({ path }) => text.lastIndexOf(path))),
    );
    expect(summary).toBeGreaterThan(lastFix);
    expect(text.slice(summary).split("\n").length).toBeLessThan(20);
  });

  it("says why a finding has no fix", () => {
    expect(text).toContain("No fix: this is for you to know; there is nothing to change.");
  });

  it("fits 100 columns", () => {
    const wide = text.split("\n").filter((row) => row.length > 100);
    expect(wide).toEqual([]);
  });
});

describe("renderText on the pack example", () => {
  const text = renderText(example("report.pack.example.json"));

  it("weighs the pack with no usage and no coverage", () => {
    expect(text).toMatch(
      /^loadsheet@0\.0\.1: pack https:\/\/github\.com\/northwind-ai\/agent-skills\n/u,
    );
    expect(text).toContain("a pack has no sessions, so no usage");
    expect(text).toMatch(/tokens {2}listed {3}body {2}item/u);
    expect(text).not.toContain("What each harness lets loadsheet see");
    expect(text).not.toContain("sessions over");
  });

  it("prints its fix with no machine, and the rules a pack cannot run", () => {
    expect(text).toMatch(/\n {4}shorten skills\/dependency-audit\/SKILL\.md\n/u);
    expect(text).toContain("Not run on a pack, which has no usage: invisible-skill, dead-skill,");
  });
});

describe("renderText", () => {
  it("shows the ten heaviest lines and sums the rest", () => {
    const lines = Array.from({ length: 14 }, (_, index) => line(`s${index}`, 100 - index));
    const text = renderText(report(lines, []));
    expect(text).toContain("claude-code: 14 lines, ~1,309 tokens listed; the 10 heaviest");
    expect(text).toContain("skill:s9\n");
    expect(text).not.toContain("skill:s10");
    expect(text).toContain("and 4 more lines, ~354 tokens together");
    expect(text).toContain("No findings.");
  });

  it("prints a fix several findings share once, with the findings it covers", () => {
    const budget: Fix = {
      machine: "desk",
      action: "set",
      path: "~/.claude/settings.json",
      set: { key: "env.SLASH_COMMAND_TOOL_CHAR_BUDGET", value: "24000" },
    };
    const invisible = (name: string) =>
      finding("invisible-skill", name, [budget], {
        level: "fix",
        evidence: { sessions: 40, bare: 30, bareShare: 0.75, byModel: 0, byUser: 0 },
      });
    const text = renderText(
      report(
        ["a", "b", "c"].map((name) => line(name, 30)),
        ["a", "b", "c"].map(invisible),
      ),
    );
    expect(occurrences(text, 'env.SLASH_COMMAND_TOOL_CHAR_BUDGET = "24000"')).toBe(1);
    expect(text).toContain(
      'One fix for all 3 above:\n    set ~/.claude/settings.json  env.SLASH_COMMAND_TOOL_CHAR_BUDGET = "24000"\n',
    );
    expect(text).toContain("bare in 30 of 40 sessions, never invoked");
  });

  it("lists the findings a shared fix covers when it covers only some", () => {
    const shared: Fix = {
      machine: "desk",
      action: "set",
      path: "~/.codex/config.toml",
      set: { key: 'skills.config[path="~/.agents/skills/x/SKILL.md"].enabled', value: false },
    };
    const own: Fix = {
      machine: "desk",
      action: "remove",
      path: "~/.claude/skills/c",
      run: "rm -r ~/.claude/skills/c",
    };
    const text = renderText(
      report(
        ["a", "b", "c"].map((name) => line(name, 30)),
        [
          finding("dead-skill", "a", [shared]),
          finding("dead-skill", "b", [shared]),
          finding("dead-skill", "c", [own]),
        ],
      ),
    );
    expect(text).toContain("One fix for 2: skill:a, skill:b\n");
    expect(
      occurrences(text, 'skills.config[path="~/.agents/skills/x/SKILL.md"].enabled = false'),
    ).toBe(1);
    expect(text).toContain("remove ~/.claude/skills/c  $ rm -r ~/.claude/skills/c");
  });

  it("prints a machine's fix once when findings name different machines", () => {
    const budget = (machine: string): Fix => ({
      machine,
      action: "set",
      path: "~/.claude/settings.json",
      set: { key: "env.SLASH_COMMAND_TOOL_CHAR_BUDGET", value: "24000" },
    });
    const text = renderText(
      report(
        ["a", "b"].map((name) => line(name, 30)),
        [
          finding("invisible-skill", "a", [budget("desk"), budget("box")]),
          finding("invisible-skill", "b", [budget("desk")]),
        ],
        {
          machines: [
            { name: "desk", reachable: true },
            { name: "box", reachable: true },
          ],
        },
      ),
    );
    expect(occurrences(text, "env.SLASH_COMMAND_TOOL_CHAR_BUDGET")).toBe(1);
    expect(text).toContain("on desk, box: set ~/.claude/settings.json");
  });

  it("shows a control character in a name, path or command instead of sending it", () => {
    const text = renderText(
      report(
        [line("a\u001b[2J", 30)],
        [
          finding("dead-skill", "a\u001b[2J", [
            {
              machine: "desk",
              action: "remove",
              path: "~/.claude/skills/a\tb",
              run: "rm -r ~/.claude/skills/a\u009bb",
            },
            {
              machine: "desk",
              action: "set",
              path: "~/.claude/settings.json",
              set: { key: "env.X", value: "a\u007fb\n" },
            },
          ]),
        ],
      ),
    );
    expect(text).not.toMatch(/[\p{Cc}--\n]/v);
    expect(text).toContain("remove ~/.claude/skills/a\\u0009b  $ rm -r ~/.claude/skills/a\\u009bb");
    expect(text).toContain('env.X = "a\\u007fb\\n"');
    expect(text).toContain("skill:a\\u001b[2J");
  });

  it("names the machine only when the report has more than one", () => {
    const fix: Fix = { machine: "desk", action: "shorten", path: "~/.claude/skills/a/SKILL.md" };
    const one = renderText(
      report([line("a", 120)], [finding("expensive-description", "a", [fix])]),
    );
    expect(one).toContain("    shorten ~/.claude/skills/a/SKILL.md\n");
    expect(one).not.toContain("on desk");
    const two = renderText(
      report([line("a", 120)], [finding("expensive-description", "a", [fix])], {
        machines: [
          { name: "desk", reachable: true },
          { name: "box", reachable: true },
        ],
      }),
    );
    expect(two).toContain("on desk: shorten ~/.claude/skills/a/SKILL.md");
  });

  it("never cuts a long path or command, putting it on its own line", () => {
    const path = `~/${"deep/".repeat(20)}skill`;
    const run = `npx skills remove ${"a-very-long-name-".repeat(6)}x --global --agent claude-code --yes`;
    const text = renderText(
      report(
        [line("a", 30)],
        [finding("dead-skill", "a", [{ machine: "desk", action: "remove", path, run }])],
      ),
    );
    expect(text).toContain(`    remove ${path}\n      $ ${run}\n`);
  });

  it("says in one sentence why a finding has no fix", () => {
    const lines = [
      line("from-plugin", 60, { managedBy: "plugin", pack: "acme" }),
      line("nowhere", 50, { scope: undefined, managedBy: undefined, path: undefined }),
      line("by-fleetrc", 40, { managedBy: "fleetrc" }),
      line("by-hand", 30),
    ];
    const text = renderText(
      report(lines, [
        finding("dead-skill", "from-plugin", []),
        finding("dead-skill", "nowhere", []),
        finding("manual-only", "by-fleetrc", [], {
          level: "fix",
          where: [{ machine: "desk", harness: "codex" }],
          evidence: { sessions: 40, byModel: 0, byUser: 3 },
        }),
        finding("dead-skill", "by-hand", []),
      ]),
    );
    expect(text).toContain(
      "No fix for 1: it comes with a plugin, whose updates would undo any change to its files.\n  ~50  skill:from-plugin",
    );
    expect(text).toContain(
      "No fix for 1: it is installed nowhere loadsheet reads, so there is no file to change.",
    );
    expect(text).toContain("invoked by you 3 times, never by the model");
    expect(text).toContain(
      "No fix: fleetrc manages its files, and loadsheet has no safe change to offer for codex.",
    );
    expect(text).toContain(
      "No fix for 1: loadsheet has no safe change to offer.\n  ~50  skill:by-hand",
    );
  });

  it("reads well with eight coverage rows", () => {
    const harnesses = [
      "claude-code",
      "codex",
      "cursor",
      "opencode",
      "gemini-cli",
      "copilot",
      "amp",
      "pi",
    ];
    const none = Object.fromEntries(Object.keys(SIGNALS).map((s) => [s, "none"])) as Record<
      Signal,
      Grade
    >;
    const text = renderText(
      report([line("a", 30)], [], {
        coverage: harnesses.map((harness, index) =>
          index < 2
            ? coverage("desk", harness)
            : coverage("desk", harness, { signals: none, sessions: 0, installed: index % 2 === 0 }),
        ),
      }),
    );
    const rows = text.split("\n").filter((row) => row.startsWith("  desk  "));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toBe(
      "  desk     claude-code        40  exact    exact     inferred  exact         -    exact",
    );
    expect(rows[3]).toBe(
      "  desk     opencode            -  -        -         -         -             -    -",
    );
    expect(text).toContain("sessions - : not installed");
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(100);
  });
});

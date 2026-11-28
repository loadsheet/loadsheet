import { readFileSync } from "node:fs";
import { parseReport, resolveConfig, type Fix, type Line, type Report } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import { renderSummary } from "../src/index.ts";

const fleet = parseReport(
  JSON.parse(
    readFileSync(new URL("../../../examples/report.example.json", import.meta.url), "utf8"),
  ),
);

const line = (name: string, tokens: number, uses: number): Line => ({
  item: `skill:${name}`,
  ref: { kind: "skill", name },
  scope: "user",
  managedBy: "hand",
  machines: ["desk"],
  path: `~/.claude/skills/${name}`,
  chars: { listed: tokens * 4, body: 1000 },
  tokens: { value: tokens, basis: "estimated" },
  exposure: { sessions: 40, share: 1, bare: 0 },
  use: { byModel: uses, byUser: 0 },
});

const hide = (name: string): Fix => ({
  machine: "desk",
  action: "hide-from-model",
  path: "~/.claude/settings.json",
  set: { key: `skillOverrides.${name}`, value: "user-invocable-only" },
});

/** One machine, Claude Code with eight used and six unused skills, and Codex with no session. */
const local = (): Report => {
  const used = Array.from({ length: 8 }, (_, i) => line(`used-${i}`, 400 - i * 10, i + 1));
  const unused = Array.from({ length: 6 }, (_, i) => line(`idle-${i}`, 300 - i * 10, 0));
  return parseReport({
    schema: 1,
    tool: "loadsheet@1.2.3",
    generatedAt: "2026-11-24T12:00:00.000Z",
    mode: "local",
    machines: [{ name: "desk", reachable: true }],
    window: ["2026-10-26", "2026-11-24"],
    config: resolveConfig(),
    coverage: [],
    sheet: [
      {
        harness: "claude-code",
        sessions: 40,
        fixedTokens: { value: 30_000, basis: "measured" },
        contextWindow: 200_000,
        lines: [...used, ...unused],
      },
      { harness: "codex", sessions: 0, lines: [] },
    ],
    findings: unused.slice(0, 5).map((idle) => ({
      id: `dead-skill:${idle.item}`,
      rule: "dead-skill",
      level: "cut",
      item: idle.item,
      where: [{ machine: "desk", harness: "claude-code" }],
      evidence: { sessions: 40, days: 30, byModel: 0, byUser: 0 },
      savesTokens: idle.tokens,
      fixes: [hide(idle.ref.name)],
    })),
    skipped: [],
  });
};

/** Claude Code as installed: 54k of its own and nothing the person added. */
const stock = (): Report => ({
  ...local(),
  sheet: [
    {
      harness: "claude-code",
      sessions: 1,
      fixedTokens: { value: 54_000, basis: "measured" },
      contextWindow: 200_000,
      lines: [],
    },
  ],
  findings: [],
});

const rows = (text: string) => text.split("\n");

describe("renderSummary", () => {
  const text = renderSummary(fleet);

  it("opens with the version, the machines it could not read, and what it teaches", () => {
    expect(rows(text).slice(0, 4)).toEqual([
      "loadsheet 0.0.1",
      "not read: mini (ssh: connect to host mini port 22: Operation timed out)",
      "",
      "Learn what you send to Claude Code and Codex with the first message of every chat.",
    ]);
  });

  it("names one harness alone, and three as a list", () => {
    expect(renderSummary(local())).toContain(
      "\nLearn what you send to Claude Code with the first message of every chat.\n",
    );
    const three = {
      ...fleet,
      sheet: [...fleet.sheet, { ...fleet.sheet[1]!, harness: "cursor" }],
    };
    expect(renderSummary(three)).toContain(
      "\nLearn what you send to Claude Code, Codex and Cursor with the first message of every chat.\n",
    );
  });

  it("gives each harness what a chat starts with, a 60-cell bar and its parts", () => {
    expect(text).toContain(
      "Claude Code  17.3k tokens · 9% context window\n" +
        `${"█".repeat(40)}${"░".repeat(20)} 91% free (182.7k)\n` +
        "■ built-in 5.6k  ■ instructions 6.7k  ■ skills 0.8k (14 skills)  ■ MCP 4.1k\n" +
        "■ agents 0.1k\n",
    );
    // Codex is drawn on Claude Code's scale, so the lighter harness has the shorter bar.
    expect(text).toMatch(
      /\nCodex {8}11\.7k tokens · 5% context window\n█{27}░{33} 95% free \(246\.7k\)\n/u,
    );
  });

  it("counts only the skills that cost tokens, and writes a part under 100 as <0.1k", () => {
    const report = local();
    const sheet = report.sheet[0]!;
    sheet.lines.push(
      { ...line("free", 0, 0) },
      {
        ...line("tiny", 8, 1),
        item: "mcp:tiny",
        ref: { kind: "mcp", name: "tiny" },
      },
    );
    expect(renderSummary(report)).toContain(
      "■ built-in 25.4k  ■ skills 4.6k (14 skills)  ■ MCP <0.1k\n",
    );
  });

  it("lists what each harness can get back, tokens aligned on one column", () => {
    const savings = rows(text).slice(
      rows(text).indexOf(rows(text).find((row) => row.startsWith("Breakdown"))!),
    );
    const table = savings.slice(0, savings.indexOf(""));
    expect(table[0]).toMatch(/^Breakdown {2,}saved per chat$/u);
    expect(table).toContain(
      "  Claude Code  shorten 1 skill description over 300 chars          −0.1k",
    );
    expect(table).toContain(
      "  Needs your OK data-toolkit plugin: 6 skills never used           −0.3k",
    );
    for (const row of table) expect(row).toHaveLength(72);
  });

  it("closes on the commands for more detail, the web page and applying fixes", () => {
    expect(text).toMatch(
      /\nMore detail {4}npx loadsheet claude --fleet {3}npx loadsheet codex --fleet\nAs a web page {2}npx loadsheet --ui --fleet\nApply fixes {4}ask your agent to run npx loadsheet --json --fleet; it gets the exact edits\n$/u,
    );
  });

  it("keeps over-budget usage visible without reporting negative free space", () => {
    const report = stock();
    report.sheet[0]!.fixedTokens!.value = 225_000;
    expect(renderSummary(report)).toContain("225.0k tokens · 113% context window");
    expect(renderSummary(report)).toContain(" 0% free (0)\n");
  });

  it("does not guess the free space when built-ins were not measured", () => {
    const report = stock();
    const sheet = report.sheet[0]!;
    delete sheet.fixedTokens;
    sheet.lines.push(line("custom", 500, 1));
    expect(renderSummary(report)).toContain(" free space unknown\n");
    sheet.lines[0]!.tokens.value = 200_000;
    expect(renderSummary(report)).toContain(" 0% free (0)\n");
  });

  it("offers exact edits even when there are no estimated savings", () => {
    const report = local();
    const [finding] = report.findings;
    const edit: Report["findings"][number] = { ...finding!, rule: "invisible-skill", level: "fix" };
    delete edit.savesTokens;
    report.findings = [edit];
    const summary = renderSummary(report);
    expect(summary).not.toContain("Nothing to cut");
    expect(summary).toContain("Apply fixes");
  });

  it("shows manual findings without promising exact edits", () => {
    const report = local();
    report.findings.forEach((finding) => (finding.fixes = []));
    const summary = renderSummary(report);
    expect(summary).toContain("Needs your OK");
    expect(summary).not.toContain("Apply fixes");
    const detail = renderSummary(report, { harness: "claude-code" });
    expect(detail).toContain("  ask");
    expect(detail).not.toContain("Apply fixes");
  });

  it("does not call an installed zero-token skill a stock setup", () => {
    const report = stock();
    report.sheet[0]!.lines.push(line("manual", 0, 0));
    for (const options of [{}, { harness: "claude-code" }]) {
      const summary = renderSummary(report, options);
      expect(summary).not.toContain("show up here once you add them");
      expect(summary).toContain("Nothing to cut");
    }
  });

  it("on a stock install, says what will show up and offers no fixes", () => {
    expect(renderSummary(stock())).toBe(
      [
        "loadsheet 1.2.3",
        "",
        "Learn what you send to Claude Code with the first message of every chat.",
        "",
        "Claude Code  54.0k tokens · 27% context window",
        `${"█".repeat(40)}${"░".repeat(20)} 73% free (146.0k)`,
        "■ built-in 54.0k",
        "",
        "Skills, MCP servers and instruction files show up here once you add them.",
        "",
        "More detail    npx loadsheet claude",
        "As a web page  npx loadsheet --ui",
        "",
      ].join("\n"),
    );
  });

  it("says when what was added has nothing to cut, and offers no fixes", () => {
    const clean = { ...local(), findings: [] };
    const text = renderSummary(clean);
    expect(text).toContain("\nNothing to cut: the checks found nothing unused or oversized.\n");
    expect(text).not.toContain("Apply fixes");
    expect(text).toMatch(/\nAs a web page {2}npx loadsheet --ui\n$/u);
  });

  it("leaves out harnesses without chats, and says when no harness had one", () => {
    expect(renderSummary(local())).not.toContain("Codex");
    const empty = { ...local(), sheet: local().sheet.map((sheet) => ({ ...sheet, sessions: 0 })) };
    expect(renderSummary(empty)).toBe(
      [
        "loadsheet 1.2.3",
        "",
        "Learn what you send to your coding agent with the first message of every chat.",
        "",
        "No Claude Code or Codex chats were found on this machine in the last 30 days,",
        "so there is nothing to measure yet.",
        "",
      ].join("\n"),
    );
  });

  it("is plain text unless a style is given, and styles only through it", () => {
    expect(text).not.toContain("\u001b");
    const styled = renderSummary(fleet, {
      style: (format, part) => `<${[format].flat().join(",")}>${part}</>`,
    });
    expect(styled).toContain("<bold>Claude Code</>");
    expect(styled).toContain("<cyan>npx loadsheet codex --fleet</>");
    expect(styled).toContain("<green,bold>−0.3k</>");
    expect(styled).toContain("<yellow>Needs your OK</> data-toolkit");
  });
});

describe("renderSummary for one harness", () => {
  const text = renderSummary(local(), { harness: "claude-code" });

  it("opens on the harness it breaks down", () => {
    expect(rows(text).slice(0, 5)).toEqual([
      "loadsheet 1.2.3",
      "",
      "Learn what you send to Claude Code with the first message of every chat.",
      "",
      "Claude Code  30.0k tokens · 15% context window",
    ]);
  });

  it("breaks the harness down part by part, tokens and uses on fixed columns", () => {
    expect(text).toContain(
      "built-in                             25.4k\n" +
        "  system prompt and built-in tools, set by Claude Code\n",
    );
    expect(text).toContain("skills · 14 listed                    4.6k     uses\n");
    expect(text).toContain(
      "  used, heaviest first\n  used-0                              0.4k        1\n",
    );
    expect(text).toContain(
      "  never used in 30 days, heaviest first\n  idle-0                              0.3k    never   hide\n",
    );
  });

  it("shows the heaviest skills and names the rest and how to list them", () => {
    expect(text).toContain("  + 5 more: 3 used, 2 never used   npx loadsheet claude --all\n");
    expect(text).not.toContain("used-5");
    const all = renderSummary(local(), { harness: "claude-code", all: true });
    expect(all).toContain("used-7");
    expect(all).toContain("idle-5                              0.3k    never\n");
    expect(all).not.toContain("more:");
  });

  it("names each change once, with where it goes, and how to apply it", () => {
    expect(text).toContain(
      "Fixes\n" +
        "   −1.4k  hide 5 skills never used in 30 days\n" +
        '          ~/.claude/settings.json  skillOverrides.<name> = "user-invocable-only"\n',
    );
    expect(text).toMatch(/\nApply fixes {4}ask your agent to run npx loadsheet --json/u);
  });

  it("keeps fleet scope in the commands within the harness breakdown", () => {
    const detail = renderSummary({ ...local(), mode: "fleet" }, { harness: "claude-code" });
    expect(detail).toContain("npx loadsheet claude --all --fleet\n");
    expect(detail).toContain("npx loadsheet --json --fleet;");
  });

  it("offers no fixes when there is nothing to cut", () => {
    const text = renderSummary(stock(), { harness: "claude-code" });
    expect(text).toContain(
      "\nSkills, MCP servers and instruction files show up here once you add them.\n",
    );
    expect(text).not.toContain("Apply fixes");
  });

  it("says when the harness had no chats", () => {
    expect(renderSummary(local(), { harness: "codex" })).toContain(
      "Codex had no chats in the last 30 days, so there is nothing to break down.",
    );
  });

  it("says loadsheet doesn't read the chats of a harness it only inventories", () => {
    const none = {
      listing: "none",
      modelUse: "none",
      userUse: "none",
      instructions: "none",
      mcp: "none",
      tokens: "none",
      usage: "none",
      cacheTtl: "none",
    } as const;
    const at = (installed: boolean) => ({
      ...local(),
      coverage: [
        { machine: "desk", harness: "pi", installed, sessions: 0, versions: [], signals: none },
      ],
      sheet: [...local().sheet, { harness: "pi", sessions: 0, lines: [line("notes", 50, 0)] }],
    });
    expect(renderSummary(at(true), { harness: "pi" })).toBe(
      "loadsheet 1.2.3\n\nLearn what you send to Pi with the first message of every chat.\n\n" +
        "loadsheet doesn't read Pi chats, only what's installed: run it again with --full to list it.\n",
    );
    expect(renderSummary(at(false), { harness: "pi" })).toContain(
      "loadsheet doesn't read Pi chats, and finds no Pi install to list.",
    );
  });
});

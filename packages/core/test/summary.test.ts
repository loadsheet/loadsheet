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

const rows = (text: string) => text.split("\n");

describe("renderSummary", () => {
  const text = renderSummary(fleet, { cwd: "~/work" });

  it("opens with the version, the folder and the machines it could not read", () => {
    expect(rows(text).slice(0, 2)).toEqual([
      "loadsheet 0.0.1 · ~/work",
      "not read: mini (ssh: connect to host mini port 22: Operation timed out)",
    ]);
  });

  it("gives each harness what a session starts with, a 60-cell bar and its parts", () => {
    expect(text).toContain(
      "Claude Code  ~17.3k of 200k before you type\n" +
        `${"█".repeat(40)}${"░".repeat(20)} 182.7k free\n` +
        "■ harness 5.6k  ■ instructions 6.7k  ■ skills 0.8k  ■ MCP 4.1k  ■ agents 0.1k\n",
    );
    // Codex is drawn on Claude Code's scale, so the lighter harness has the shorter bar.
    expect(text).toMatch(/\nCodex {8}~11\.7k of 258k before you type\n█{27}░{33} 246\.7k free\n/u);
  });

  it("lists what each harness can get back, tokens aligned on one column", () => {
    const savings = rows(text).slice(
      rows(text).indexOf(rows(text).find((row) => row.startsWith("You can get back"))!),
    );
    const table = savings.slice(0, savings.indexOf(""));
    expect(table[0]).toMatch(/^You can get back {2,}tokens per session$/u);
    expect(table).toContain(
      "  Claude Code  shorten 1 skill description over 300 chars          −0.1k",
    );
    expect(table).toContain(
      "  Ask first    data-toolkit plugin: 6 skills never used            −0.3k",
    );
    for (const row of table) expect(row).toHaveLength(72);
  });

  it("closes on the commands for more detail and for applying fixes", () => {
    expect(text).toMatch(
      /\nMore detail {4}loadsheet claude-code {3}loadsheet codex\nApply fixes {4}ask your agent to run npx loadsheet --json; it gets the exact edits\n$/u,
    );
  });

  it("leaves out harnesses without sessions, and says when no harness had one", () => {
    expect(renderSummary(local())).not.toContain("Codex");
    const empty = { ...local(), sheet: local().sheet.map((sheet) => ({ ...sheet, sessions: 0 })) };
    expect(renderSummary(empty)).toBe(
      "loadsheet 1.2.3\n\nNo Claude Code or Codex sessions were found on this machine in the last 30 days, so there is nothing to judge yet.\n",
    );
  });

  it("is plain text unless a style is given, and styles only through it", () => {
    expect(text).not.toContain("\u001b");
    const styled = renderSummary(fleet, {
      style: (format, part) => `<${[format].flat().join(",")}>${part}</>`,
    });
    expect(styled).toContain("<bold>Claude Code</>");
    expect(styled).toContain("<cyan>loadsheet codex</>");
    expect(styled).toContain("<green,bold>−0.3k</>");
  });
});

describe("renderSummary for one harness", () => {
  const text = renderSummary(local(), { harness: "claude-code" });

  it("breaks the harness down part by part, tokens and uses on fixed columns", () => {
    expect(text).toContain(
      "harness                              25.4k\n" +
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
    expect(text).toContain("  + 5 more: 3 used, 2 never used   loadsheet claude-code --all\n");
    expect(text).not.toContain("used-5");
    const all = renderSummary(local(), { harness: "claude-code", all: true });
    expect(all).toContain("used-7");
    expect(all).toContain("idle-5                              0.3k    never\n");
    expect(all).not.toContain("more:");
  });

  it("names each change once, with where it goes", () => {
    expect(text).toContain(
      "You can get back\n" +
        "   −1.4k  hide 5 skills never used in 30 days\n" +
        '          ~/.claude/settings.json  skillOverrides.<name> = "user-invocable-only"\n',
    );
  });

  it("says when the harness had no sessions", () => {
    expect(renderSummary(local(), { harness: "codex" })).toContain(
      "Codex had no sessions in the last 30 days, so there is nothing to break down.",
    );
  });
});

import { parseReport, resolveConfig, type Item } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import { packReport, renderText } from "../src/index.ts";

const item = (name: string, listed: number, body: number, extra: Partial<Item> = {}): Item => ({
  id: `skill:${name}`,
  ref: { kind: "skill", name },
  harnesses: ["claude-code"],
  scope: "user",
  pack: "acme/skills",
  managedBy: "skills",
  path: `skills/${name}`,
  digest: "0".repeat(64),
  chars: { listed, body },
  modelInvocable: true,
  description: `${name} description`,
  ...extra,
});

const items = [
  item("small", 101, 900),
  item("long", 410, 5000),
  item("manual", 0, 700, { modelInvocable: false }),
];
const now = new Date("2026-11-24T10:00:00.000Z");
const input = {
  items,
  harness: { id: "claude-code" },
  source: "https://github.com/acme/skills",
  config: resolveConfig(),
  now,
  tool: "loadsheet@0.0.1",
};

describe("packReport", () => {
  it("weighs every item with no usage and finds long descriptions", () => {
    const report = packReport(input);
    expect(parseReport(report)).toEqual(report);
    expect(report).toMatchObject({
      schema: 1,
      tool: "loadsheet@0.0.1",
      generatedAt: "2026-11-24T10:00:00.000Z",
      mode: "pack",
      source: "https://github.com/acme/skills",
      machines: [],
      window: ["2026-11-24", "2026-11-24"],
      coverage: [],
    });
    expect(report.sheet).toEqual([
      {
        harness: "claude-code",
        sessions: 0,
        lines: [
          {
            item: "skill:long",
            ref: { kind: "skill", name: "long" },
            scope: "user",
            pack: "acme/skills",
            managedBy: "skills",
            machines: [],
            path: "skills/long",
            chars: { listed: 410, body: 5000 },
            tokens: { value: 103, basis: "estimated" },
            exposure: { sessions: 0, share: 0, bare: 0 },
            use: { byModel: 0, byUser: 0 },
            description: "long description",
          },
          expect.objectContaining({
            item: "skill:small",
            tokens: { value: 25, basis: "estimated" },
          }),
          expect.objectContaining({
            item: "skill:manual",
            tokens: { value: 0, basis: "estimated" },
          }),
        ],
      },
    ]);
    expect(report.findings).toEqual([
      {
        id: "expensive-description:skill:long",
        rule: "expensive-description",
        level: "fix",
        item: "skill:long",
        where: [],
        evidence: { listedChars: 410, maxChars: 300 },
        savesTokens: { value: 28, basis: "estimated" },
        fixes: [{ action: "shorten", path: "skills/long/SKILL.md" }],
      },
    ]);
    expect(report.skipped).toEqual([
      {
        rule: "invisible-skill",
        harness: "claude-code",
        reason: "missing-signal",
        missing: ["listing"],
      },
      {
        rule: "dead-skill",
        harness: "claude-code",
        reason: "missing-signal",
        missing: ["listing", "modelUse", "userUse"],
      },
      {
        rule: "manual-only",
        harness: "claude-code",
        reason: "missing-signal",
        missing: ["modelUse", "userUse"],
      },
      {
        rule: "dead-pack",
        harness: "claude-code",
        reason: "missing-signal",
        missing: ["listing", "modelUse", "userUse"],
      },
      { rule: "idle-mcp", harness: "claude-code", reason: "missing-signal", missing: ["mcp"] },
      {
        rule: "harness-mismatch",
        harness: "claude-code",
        reason: "missing-signal",
        missing: ["listing"],
      },
      {
        rule: "short-history",
        harness: "claude-code",
        reason: "missing-signal",
        missing: ["listing"],
      },
    ]);
  });

  it("follows the config: a threshold, a disabled rule and an ignored item", () => {
    const tighter = packReport({
      ...input,
      config: resolveConfig({ rules: { "expensive-description": { maxChars: 100 } } }),
    });
    expect(tighter.findings.map((finding) => finding.item)).toEqual(["skill:long", "skill:small"]);
    const off = packReport({
      ...input,
      config: resolveConfig({ rules: { "expensive-description": false, "dead-skill": false } }),
    });
    expect(off.findings).toEqual([]);
    expect(off.skipped.map((skip) => skip.rule)).not.toContain("dead-skill");
    const ignored = packReport({ ...input, config: resolveConfig({ ignore: ["skill:long"] }) });
    expect(ignored.findings).toEqual([]);
  });
});

describe("renderText", () => {
  it("prints an aligned table by tokens, a total and the findings", () => {
    expect(renderText(packReport(input))).toBe(
      [
        "loadsheet: https://github.com/acme/skills",
        "",
        "tokens  listed   body  claude-code",
        "   103     410  5,000  skill:long",
        "    25     101    900  skill:small",
        "     0       0    700  skill:manual",
        "------  ------  -----",
        "   128     511  6,600  total, 3 items",
        "",
        "Findings",
        "  fix  expensive-description  skill:long, saves ~28 tokens: shorten skills/long/SKILL.md",
        "",
        "Not run without usage data: invisible-skill, dead-skill, manual-only, dead-pack, idle-mcp, harness-mismatch, short-history.",
        "",
      ].join("\n"),
    );
  });
});

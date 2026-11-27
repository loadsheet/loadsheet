import { buildReport } from "@loadsheet/core";
import { parseReport, parseScan, resolveConfig, RULES } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import example from "../../../examples/report.example.json";
import scanExample from "../../../examples/scan.example.json";
import { shareLink } from "../src/lib/report";
import { fromShareCode, shareCode } from "../src/lib/share";

describe("a shared link", () => {
  const report = parseReport(example);
  const described = report.sheet.flatMap((s) => s.lines).filter((l) => l.description);

  it("carries no description, though the Report it came from has them", async () => {
    expect(described.length).toBeGreaterThan(0);
    const code = await shareCode(report);
    const opened = await fromShareCode(code);
    expect(opened.sheet.flatMap((s) => s.lines).filter((l) => "description" in l)).toEqual([]);
    for (const l of described) expect(code).not.toContain(l.description);
  });

  it("carries every line, with its tokens", async () => {
    const opened = await fromShareCode(await shareCode(report));
    const lines = (r: typeof report) =>
      r.sheet.flatMap((s) => s.lines.map((l) => [s.harness, l.item, l.tokens.value]));
    expect(lines(opened)).toEqual(lines(report));
  });

  it("omits custom settings paths and their edits without retargeting them", async () => {
    const local = structuredClone(report);
    const settingsPath = "~/workspaces/private-project/settings.json";
    const row = local.coverage.find(
      (candidate) => candidate.harness === "claude-code" && candidate.machine === "server",
    )!;
    row.settings = { ...row.settings, settingsPath, retentionDays: 30 };
    local.findings.push({
      id: "short-history:claude-code",
      rule: "short-history",
      level: "fix",
      where: [{ machine: row.machine, harness: row.harness }],
      evidence: { days: 30, sessions: 1, minDays: 30, retentionDays: 30 },
      fixes: [
        {
          machine: row.machine,
          action: "set",
          path: settingsPath,
          set: { key: "cleanupPeriodDays", value: 365 },
        },
      ],
    });
    local.findings.push({
      id: "dead-skill:skill:commit-style",
      rule: "dead-skill",
      level: "fix",
      item: "skill:commit-style",
      where: [{ machine: row.machine, harness: row.harness }],
      evidence: {},
      fixes: [
        {
          machine: row.machine,
          action: "hide-from-model",
          path: settingsPath,
          set: { key: "skillOverrides.commit-style", value: "user-invocable-only" },
        },
      ],
    });
    const opened = await fromShareCode(await shareCode(local));
    expect(JSON.stringify(opened)).not.toContain("private-project");
    const sharedRow = opened.coverage.find(
      (candidate) => candidate.machine === row.machine && candidate.harness === row.harness,
    );
    expect(sharedRow?.settings).toEqual({ retentionDays: 30 });
    expect(opened.findings.slice(-2)).toMatchObject([
      { level: "info", fixes: [] },
      { level: "info", fixes: [] },
    ]);
    expect(opened.findings.find((finding) => finding.rule === "cache-ttl")?.fixes).toEqual(
      local.findings.find((finding) => finding.rule === "cache-ttl")?.fixes,
    );
    expect(local.findings.at(-1)?.fixes[0]?.path).toBe(settingsPath);
    expect(row.settings.settingsPath).toBe(settingsPath);
  });

  it("keeps only the default listing-budget edit for a skill installed on both machines", async () => {
    const scan = parseScan(scanExample);
    const item = scan.items.find((candidate) => candidate.id === "skill:commit-style")!;
    const coverage = scan.coverage.find((row) => row.harness === "claude-code")!;
    const makeScan = (machine: string, configDir: string) => ({
      ...scan,
      machine,
      coverage: [
        { ...coverage, machine, settings: { settingsPath: `${configDir}/settings.json` } },
      ],
      items: [{ ...item, path: `${configDir}/skills/commit-style` }],
      sessions: scan.sessions.filter((cell) => cell.harness === "claude-code"),
      cells: scan.cells
        .filter((cell) => cell.item === item.id && cell.harness === "claude-code")
        .map((cell) => ({ ...cell, bare: cell.sessions })),
    });
    const settingsPath = "~/workspaces/private-project/settings.json";
    const local = buildReport({
      scans: [makeScan("laptop", "~/.claude"), makeScan("server", "~/workspaces/private-project")],
      config: resolveConfig({
        rules: Object.fromEntries(
          RULES.filter((rule) => rule !== "invisible-skill").map((rule) => [rule, false]),
        ),
      }),
      now: new Date(scan.scannedAt),
      tool: scan.tool,
    });
    const finding = local.findings.find((candidate) => candidate.rule === "invisible-skill")!;
    expect(local.sheet[0]?.lines[0]?.path).toBe(item.path);
    expect(finding.fixes.map((fix) => fix.path)).toEqual(["~/.claude/settings.json", settingsPath]);

    const opened = await fromShareCode(await shareCode(local));
    expect(JSON.stringify(opened)).not.toContain("private-project");
    expect(opened.findings).toEqual([{ ...finding, fixes: [finding.fixes[0]] }]);
    expect(finding.fixes[1]?.path).toBe(settingsPath);
    expect(local.coverage.find((row) => row.machine === "server")?.settings?.settingsPath).toBe(
      settingsPath,
    );
  });
});

describe("shareLink", () => {
  const report = parseReport(example);

  it("opens the report at its path on the base page, with the harness, and drops every description", async () => {
    const link = await shareLink(report, "https://loadsheet.dev/", "/report/fixes", "codex");
    const [page, hash] = link.split("#");
    expect(page).toBe("https://loadsheet.dev/");
    const [path, query] = hash!.split("?");
    expect(path).toBe("/report/fixes");
    const params = new URLSearchParams(query);
    expect(params.get("h")).toBe("codex");
    const opened = await fromShareCode(params.get("r")!);
    expect(opened.sheet.flatMap((s) => s.lines).filter((l) => "description" in l)).toEqual([]);
    expect(opened.sheet.flatMap((s) => s.lines)).toHaveLength(
      report.sheet.flatMap((s) => s.lines).length,
    );
  });

  it("in the path form, puts the report in the fragment of its own path, where no server sees it", async () => {
    const link = new URL(
      await shareLink(report, "https://loadsheet.dev/", "/report/fixes", "codex", "path"),
    );
    expect(link.origin + link.pathname).toBe("https://loadsheet.dev/report/fixes");
    expect(link.searchParams.get("h")).toBe("codex");
    const code = new URLSearchParams(link.hash.slice(1)).get("r")!;
    expect((await fromShareCode(code)).sheet.flatMap((s) => s.lines)).toHaveLength(
      report.sheet.flatMap((s) => s.lines).length,
    );
  });
});

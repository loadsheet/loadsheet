import { parseReport } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import example from "../../../examples/report.example.json";
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
    const opened = await fromShareCode(await shareCode(local));
    expect(JSON.stringify(opened)).not.toContain("private-project");
    const sharedRow = opened.coverage.find(
      (candidate) => candidate.machine === row.machine && candidate.harness === row.harness,
    );
    expect(sharedRow?.settings).toEqual({ retentionDays: 30 });
    expect(opened.findings.at(-1)).toMatchObject({ level: "info", fixes: [] });
    expect(opened.findings.find((finding) => finding.rule === "cache-ttl")?.fixes).toEqual(
      local.findings.find((finding) => finding.rule === "cache-ttl")?.fixes,
    );
    expect(local.findings.at(-1)?.fixes[0]?.path).toBe(settingsPath);
    expect(row.settings.settingsPath).toBe(settingsPath);
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

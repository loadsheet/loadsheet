import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseReport } from "@loadsheet/schema";
import { describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };

// Runs the built CLI, so `pnpm build` comes first.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: fixtures });

describe("loadsheet CLI", () => {
  it.each(["--version", "-v"])("%s prints the package version", (flag) => {
    const result = run(flag);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${pkg.version}\n`);
  });

  it.each([[[]], [["--help"]], [["-h"]]])("%j prints the usage", (args: string[]) => {
    const result = run(...args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: loadsheet");
    expect(result.stdout).toContain("--version");
    expect(result.stdout).toContain("--help");
  });

  it.each([
    [["--nope"]],
    [["missing-dir"]],
    [["pack", "--harness", "nope"]],
    [["https://gitlab.com/o/r"]],
  ])("%j prints the usage to stderr and exits 2", (args: string[]) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(args.at(-1));
    expect(result.stderr).toContain("Usage: loadsheet");
  });
});

describe("loadsheet <dir>", () => {
  it("--json prints a pack Report that parses, named after the directory", () => {
    const result = run("pack", "--json");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = parseReport(JSON.parse(result.stdout));
    expect(report).toMatchObject({ mode: "pack", source: "pack", machines: [], coverage: [] });
    expect(report.sheet[0]?.lines.map((line) => [line.item, line.chars.listed])).toEqual([
      ["skill:log-digest", 406],
      ["skill:commit-notes", 88],
      ["skill:release-checklist", 0],
    ]);
    expect(report.findings.map((finding) => finding.id)).toEqual([
      "expensive-description:skill:log-digest",
    ]);
    expect(result.stdout).not.toContain(fixtures);
  });

  it("prints a table by default", () => {
    const result = run(fixtures + "pack");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^loadsheet: pack\n/u);
    expect(result.stdout).toContain("total, 3 items");
    expect(result.stdout).toContain("expensive-description  skill:log-digest");
  });
});

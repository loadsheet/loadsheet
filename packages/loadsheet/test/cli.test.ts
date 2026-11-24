import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };

// Runs the built CLI, so `pnpm build` comes first.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

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

  it("an unknown flag prints the usage to stderr and exits 2", () => {
    const result = run("--nope");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--nope");
    expect(result.stderr).toContain("Usage: loadsheet");
  });
});

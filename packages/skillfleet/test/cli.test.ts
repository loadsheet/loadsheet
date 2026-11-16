// Runs the bin that package.json declares, so build first.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
  bin: { skillfleet: string };
};
const cli = resolve(pkg.bin.skillfleet);

const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

describe("skillfleet", () => {
  it("is built", () => {
    expect(existsSync(cli), `${cli} is missing, run pnpm build`).toBe(true);
  });

  it("says it is not released yet", () => {
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toBe(
      `skillfleet ${pkg.version}\nskillfleet is not released yet: https://github.com/onmax/skillfleet\n`,
    );
  });

  it("--version prints the version", () => {
    const { status, stdout } = run("--version");
    expect(status).toBe(0);
    expect(stdout).toBe(`${pkg.version}\n`);
  });
});

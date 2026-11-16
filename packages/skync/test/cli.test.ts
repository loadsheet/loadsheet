// Runs the bin that package.json declares, so build first.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
  bin: { skync: string };
};
const cli = resolve(pkg.bin.skync);

const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

describe("skync", () => {
  it("is built", () => {
    expect(existsSync(cli), `${cli} is missing, run pnpm build`).toBe(true);
  });

  it("says it is not released yet", () => {
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toBe(
      `skync ${pkg.version}\nskync is not released yet: https://github.com/onmax/skync\n`,
    );
  });

  it("--version prints the version", () => {
    const { status, stdout } = run("--version");
    expect(status).toBe(0);
    expect(stdout).toBe(`${pkg.version}\n`);
  });
});

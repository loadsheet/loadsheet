// The published tarballs, installed the way `npx fleetrc` gets them: fleetrc, and the
// @loadsheet/fleet its bin runs.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { fleetrcDir, isWindows, machine, remote, skills, version } from "./fixture.ts";

describe("packed tarball", () => {
  it("installs, prints its version, and plans an init", async () => {
    const m = machine();
    const run = (command: string, cwd: string, ...args: string[]) =>
      execFileSync(isWindows ? `${command}.cmd` : command, args, {
        cwd,
        env: {
          ...m.env,
          npm_config_cache: join(m.root, "npm-cache"),
          // The tests run on what `pnpm build` made; packing builds nothing.
          npm_config_ignore_scripts: "true",
          pnpm_config_ignore_scripts: "true",
        },
        encoding: "utf8",
        shell: isWindows,
      });
    const out = join(m.root, "pack");
    mkdirSync(out);
    // pnpm writes the version of @loadsheet/fleet in place of workspace:*.
    for (const dir of [fileURLToPath(new URL("..", import.meta.url)), fleetrcDir])
      run("pnpm", dir, "pack", "--pack-destination", out);
    const tarballs = readdirSync(out).sort();
    expect(tarballs).toEqual([`fleetrc-${version}.tgz`, `loadsheet-fleet-${version}.tgz`]);
    const project = join(m.root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
    run(
      "npm",
      project,
      "install",
      "--no-audit",
      "--no-fund",
      "--offline",
      ...tarballs.map((file) => join(out, file)),
    );
    // Bundled: neither package installs a dependency of its own.
    expect(
      readdirSync(join(project, "node_modules")).filter((name) => !name.startsWith(".")),
    ).toEqual(["@loadsheet", "fleetrc"]);
    expect(readdirSync(join(project, "node_modules", "@loadsheet"))).toEqual(["fleet"]);

    const npx = (...args: string[]) =>
      run("npm", project, "exec", "--offline", "--", "fleetrc", ...args);
    expect(npx("--version").trim()).toBe(version);
    const vendor = remote(m, "vendor", skills("skills/", "packed"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const plan = npx("init", "--dry-run", manifest);
    expect(plan).toContain("link 1 skills into 1 agent folders");
    expect(plan).toContain("names after: packed");
  });
});

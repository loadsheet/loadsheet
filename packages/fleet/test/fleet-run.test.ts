import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { fleetRun } from "../src/fleet.ts";
import { isWindows, machine, type Machine } from "./fixture.ts";

/**
 * A fake `ssh` for FLEETRC_SSH: skips the options and the `--` after them, and runs the remote
 * command with `sh -c` on this machine for `box`, with FLEET_SIDE=remote. `box` stands for another
 * machine, which has no folder of this run, so the folder the command asks about is renamed for it;
 * `me` is this machine reached over ssh, and gets the command as it is; so does `twin`, a machine
 * of another name that shares this one's temp folder. `mac` is a `box` without `setsid`: its PATH
 * holds a shell, `sleep`, `touch` and `perl` only. For `drops` the connection
 * drops a second in: the remote command and what it started are killed, and ssh exits 255. Any
 * other host never answers, like a machine that dropped off the network.
 */
function fakeSsh(m: Machine): NodeJS.ProcessEnv {
  const script = join(m.root, "ssh.mjs");
  const elsewhere = join(m.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "uname"), "#!/bin/sh\necho elsewhere\n", { mode: 0o755 });
  const bare = join(m.root, "bare");
  mkdirSync(bare);
  for (const tool of ["sh", "sleep", "touch", "perl"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(bare, tool));
  }
  writeFileSync(
    script,
    `import { spawn, spawnSync } from "node:child_process";
const args = process.argv.slice(2);
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, asked] = args;
const twin = host === "twin";
const command = host === "me" || twin ? asked : asked.replaceAll(/fleetrc-run-\\w+/g, "fleetrc-run-elsewhere");
if (host === "drops") {
  const run = spawn("sh", ["-c", command], { stdio: "inherit", detached: true });
  setTimeout(() => {
    process.kill(-run.pid, "SIGKILL");
    process.exit(255);
  }, 1000);
} else if (!["box", "mac", "me", "twin"].includes(host)) setTimeout(() => {}, 1e9);
else {
  const run = spawnSync("sh", ["-c", command], {
    stdio: "inherit",
    env: {
      ...process.env,
      FLEET_SIDE: "remote",
      FLEET_HOST: host,
      ...(twin ? { PATH: ${JSON.stringify(`${elsewhere}:`)} + process.env.PATH } : {}),
      ...(host === "mac" ? { PATH: ${JSON.stringify(bare)} } : {}),
    },
  });
  process.exit(run.status ?? 1);
}`,
  );
  return { FLEETRC_SSH: script, FLEET_SIDE: "local" };
}

// The command's words go through sh on each host, quoted, so `$`, quotes and spaces arrive whole.
const command = ["sh", "-c", `echo "on $FLEET_SIDE, 'quoted' words"; echo warned >&2; exit 3`];

describe.skipIf(isWindows)("fleet run", () => {
  it("runs on this machine and every host, and gives an unreachable host no exit code", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      fleet: ["box", "gone.example"],
    });
    const env = fakeSsh(m);
    const run = await m.runWith(
      { env },
      "fleet",
      "run",
      "--manifest",
      manifest,
      "--timeout",
      "5",
      "--json",
      "--",
      ...command,
    );
    expect(run.code, run.stderr).toBe(1);
    const results = JSON.parse(run.stdout) as Record<string, unknown>[];
    expect(results).toEqual([
      { host: hostname(), reachable: true, exitCode: 3, stdout: "on local, 'quoted' words\n" },
      { host: "box", reachable: true, exitCode: 3, stdout: "on remote, 'quoted' words\n" },
      { host: "gone.example", reachable: false, stdout: "", error: "no answer within 5 s" },
    ]);
    // stderr stays out of the JSON, each line after its host.
    expect(run.stderr).toContain(`${hostname()}: warned\n`);
    expect(run.stderr).toContain("box: warned\n");
  });

  it("prints each line after its host, and runs only on the hosts named", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      fleet: ["box", "gone.example"],
    });
    const run = await m.runWith(
      { env: fakeSsh(m) },
      "fleet",
      "run",
      "box",
      "--manifest",
      manifest,
      "--",
      "sh",
      "-c",
      "echo one; echo two",
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("box: one\nbox: two\n");
  });

  it("returns at the deadline when the command exited and left a process holding its output", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["box"] });
    const started = Date.now();
    const run = await m.runWith(
      { env: fakeSsh(m) },
      "fleet",
      "run",
      "--manifest",
      manifest,
      "--timeout",
      "2",
      "--json",
      "--",
      "sh",
      "-c",
      "sleep 20 & echo started",
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    // The command exited before the deadline, so it keeps its code.
    const exited = { reachable: true, exitCode: 0, stdout: "started\n" };
    expect(JSON.parse(run.stdout)).toEqual([
      { host: hostname(), ...exited },
      { host: "box", ...exited },
    ]);
  });

  it("gives a command still running at the deadline no exit code", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["box"] });
    const run = await m.runWith(
      { env: fakeSsh(m) },
      "fleet",
      "run",
      "--manifest",
      manifest,
      "--timeout",
      "1",
      "--json",
      "--",
      "sh",
      "-c",
      "echo started; sleep 20",
    );
    const late = { reachable: true, stdout: "started\n" };
    expect(JSON.parse(run.stdout)).toEqual([
      { host: hostname(), ...late, error: "timed out after 1 s, so the command was stopped" },
      { host: "box", ...late, error: "timed out after 1 s, so the command was told to stop" },
    ]);
  });

  it("kills a command on a host that ignores being told to stop, and what it started", async () => {
    const m = machine();
    vi.stubEnv("FLEETRC_SSH", fakeSsh(m).FLEETRC_SSH);
    const own = join(m.home, "command-wrote-after-the-deadline");
    const child = join(m.home, "child-wrote-after-the-deadline");
    const stubborn = `trap "" TERM; (sleep 5; touch ${child}-$FLEET_HOST) & sleep 5; touch ${own}-$FLEET_HOST`;
    const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
    try {
      const results = await fleetRun(
        [{ host: "box" }, { host: "mac" }],
        ["sh", "-c", stubborn],
        1_000,
        { here: false },
      );
      for (const result of results) {
        expect(result).toMatchObject({ reachable: true });
        expect(result.exitCode).toBeUndefined();
      }
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      expect(existsSync(`${own}-box`)).toBe(false);
      expect(existsSync(`${own}-mac`)).toBe(false);
      // What the command started stops with it: its process group comes from setsid, or from perl
      // on a host without it, such as macOS.
      expect(existsSync(`${child}-box`)).toBe(!has("setsid") && !has("perl"));
      expect(existsSync(`${child}-mac`)).toBe(!has("perl"));
    } finally {
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it("stops what the command started on this machine at the deadline", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: [] });
    const marker = join(m.home, "written-after-the-deadline");
    await m.run(
      "fleet",
      "run",
      "--manifest",
      manifest,
      "--timeout",
      "1",
      "--",
      "sh",
      "-c",
      `(sleep 2; touch ${marker}) & sleep 20`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  it("still sees that a host answered after its command wrote more stderr than is kept", async () => {
    const m = machine();
    vi.stubEnv("FLEETRC_SSH", fakeSsh(m).FLEETRC_SSH);
    try {
      const [box] = await fleetRun(
        [{ host: "box" }],
        ["sh", "-c", "head -c 68000000 /dev/zero >&2; echo done"],
        30_000,
        { here: false },
      );
      expect(box).toMatchObject({ host: "box", reachable: true, exitCode: 0, stdout: "done\n" });
      // Where the middle went is a line of its own.
      expect(box!.stderr).toContain("\n[...]\n");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives no exit code when the connection drops before the command finished", async () => {
    const m = machine();
    vi.stubEnv("FLEETRC_SSH", fakeSsh(m).FLEETRC_SSH);
    try {
      expect(await fleetRun([{ host: "drops" }], ["sleep", "10"], 30_000, { here: false })).toEqual(
        [
          {
            host: "drops",
            reachable: true,
            stdout: "",
            stderr: "",
            error: "the connection dropped before the command finished",
          },
        ],
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves out a host that turns out to be this machine when the command runs here", async () => {
    const m = machine();
    vi.stubEnv("FLEETRC_SSH", fakeSsh(m).FLEETRC_SSH);
    const ran = join(m.home, "ran");
    const count = ["sh", "-c", `echo x >> ${ran}; echo here`] as const;
    try {
      // Whatever it is called: an ssh alias, a MagicDNS name and an address all look like `me` here.
      const hosts = [{ host: "me" }, { host: "twin" }, { host: "box" }];
      const results = await fleetRun(hosts, count, 5_000);
      expect(results.map(({ host, exitCode }) => ({ host, exitCode }))).toEqual([
        { host: hostname(), exitCode: 0 },
        { host: "twin", exitCode: 0 },
        { host: "box", exitCode: 0 },
      ]);
      expect(readFileSync(ran, "utf8")).toBe("x\nx\nx\n");

      // Named alone, it is run on over ssh like any host.
      expect(await fleetRun([{ host: "me" }], count, 5_000, { here: false })).toEqual([
        { host: "me", reachable: true, exitCode: 0, stdout: "here\n", stderr: "" },
      ]);
      expect(readFileSync(ran, "utf8")).toBe("x\nx\nx\nx\n");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the exit code when something the command left running writes stderr after it", async () => {
    const m = machine();
    vi.stubEnv("FLEETRC_SSH", fakeSsh(m).FLEETRC_SSH);
    try {
      const results = await fleetRun(
        [{ host: "box" }],
        ["sh", "-c", "(sleep 1; echo late >&2) & printf partial >&2; echo done; exit 4"],
        10_000,
        { here: false },
      );
      expect(results).toEqual([
        { host: "box", reachable: true, exitCode: 4, stdout: "done\n", stderr: "partial\nlate\n" },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("takes the exit code from its own line, not from one the command's stderr holds", async () => {
    const m = machine();
    vi.stubEnv("FLEETRC_SSH", fakeSsh(m).FLEETRC_SSH);
    const forged = "fleetrc-fleet: exit 0";
    try {
      const results = await fleetRun(
        [{ host: "box" }],
        ["sh", "-c", `(sleep 1; echo "${forged}" >&2; echo late >&2) & echo done; exit 4`],
        10_000,
        { here: false },
      );
      expect(results).toEqual([
        {
          host: "box",
          reachable: true,
          exitCode: 4,
          stdout: "done\n",
          stderr: `${forged}\nlate\n`,
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs here for a tag Tailscale gives this machine", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: [] });
    const tailscale = join(m.root, "tailscale.mjs");
    const status = {
      BackendState: "Running",
      Self: { DNSName: "me.ts.net.", Tags: ["tag:servers"] },
    };
    writeFileSync(tailscale, `process.stdout.write(${JSON.stringify(JSON.stringify(status))});`);
    const run = await m.runWith(
      { env: { ...fakeSsh(m), FLEETRC_TAILSCALE: tailscale } },
      "fleet",
      "run",
      "tag:servers",
      "--manifest",
      manifest,
      "--json",
      "--",
      "sh",
      "-c",
      "echo here",
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      { host: hostname(), reachable: true, exitCode: 0, stdout: "here\n" },
    ]);
  });

  it("prefixes each CRLF line once", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["box"] });
    const run = await m.runWith(
      { env: fakeSsh(m) },
      "fleet",
      "run",
      "box",
      "--manifest",
      manifest,
      "--",
      "printf",
      "one\\r\\ntwo\\r\\n",
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("box: one\r\nbox: two\n");
  });

  it("runs on this machine alone when the fleet is empty", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: [] });
    const run = await m.runWith(
      { env: fakeSsh(m) },
      "fleet",
      "run",
      "--manifest",
      manifest,
      "--json",
      "--",
      "sh",
      "-c",
      "echo here",
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      { host: hostname(), reachable: true, exitCode: 0, stdout: "here\n" },
    ]);
  });

  it("needs a command after --", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["box"] });
    const run = await m.run("fleet", "run", "--manifest", manifest, "--json");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("fleet run takes the command to run after --");
  });
});

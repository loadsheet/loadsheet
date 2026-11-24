import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { fleetRun } from "../src/fleet.ts";
import { isWindows, machine, type Machine } from "./fixture.ts";

/**
 * A fake `ssh` for FLEETRC_SSH: skips the options and the `--` after them, and runs the remote
 * command with `sh -c` on this machine for `box`, with FLEET_SIDE=remote. `box` stands for another
 * machine, which has no folder of this run, so the folder the command asks about is renamed for it;
 * `me` is this machine reached over ssh, and gets the command as it is. For `drops` the connection
 * drops a second in: the remote command and what it started are killed, and ssh exits 255. Any
 * other host never answers, like a machine that dropped off the network.
 */
function fakeSsh(m: Machine): NodeJS.ProcessEnv {
  const script = join(m.root, "ssh.mjs");
  writeFileSync(
    script,
    `import { spawn, spawnSync } from "node:child_process";
const args = process.argv.slice(2);
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, asked] = args;
const command = host === "me" ? asked : asked.replaceAll(/fleetrc-run-\\w+/g, "fleetrc-run-elsewhere");
if (host === "drops") {
  const run = spawn("sh", ["-c", command], { stdio: "inherit", detached: true });
  setTimeout(() => {
    process.kill(-run.pid, "SIGKILL");
    process.exit(255);
  }, 1000);
} else if (host !== "box" && host !== "me") setTimeout(() => {}, 1e9);
else {
  const run = spawnSync("sh", ["-c", command], {
    stdio: "inherit",
    env: { ...process.env, FLEET_SIDE: "remote" },
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
    const late = { reachable: true, stdout: "started\n" };
    // Here the command's whole process group is killed; over ssh the command gets a SIGTERM.
    expect(JSON.parse(run.stdout)).toEqual([
      { host: hostname(), ...late, error: "timed out after 2 s, so the command was stopped" },
      { host: "box", ...late, error: "timed out after 2 s, so the command was told to stop" },
    ]);
  });

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
      const results = await fleetRun([{ host: "me" }, { host: "box" }], count, 5_000);
      expect(results.map(({ host, exitCode }) => ({ host, exitCode }))).toEqual([
        { host: hostname(), exitCode: 0 },
        { host: "box", exitCode: 0 },
      ]);
      expect(readFileSync(ran, "utf8")).toBe("x\nx\n");

      // Named alone, it is run on over ssh like any host.
      expect(await fleetRun([{ host: "me" }], count, 5_000, { here: false })).toEqual([
        { host: "me", reachable: true, exitCode: 0, stdout: "here\n", stderr: "" },
      ]);
      expect(readFileSync(ran, "utf8")).toBe("x\nx\nx\n");
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

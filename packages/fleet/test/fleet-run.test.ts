import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { fleetRun } from "../src/fleet.ts";
import { isWindows, machine, type Machine } from "./fixture.ts";

/**
 * A fake `ssh` for FLEETRC_SSH: skips the options and the `--` after them, and runs the remote
 * command with `sh -c` on this machine for `box`, with FLEET_SIDE=remote. For `drops` the
 * connection drops a second in: the remote command and what it started are killed, and ssh exits
 * 255. Any other host never answers, like a machine that dropped off the network.
 */
function fakeSsh(m: Machine): NodeJS.ProcessEnv {
  const script = join(m.root, "ssh.mjs");
  writeFileSync(
    script,
    `import { spawn, spawnSync } from "node:child_process";
const args = process.argv.slice(2);
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, command] = args;
if (host === "drops") {
  const run = spawn("sh", ["-c", command], { stdio: "inherit", detached: true });
  setTimeout(() => {
    process.kill(-run.pid, "SIGKILL");
    process.exit(255);
  }, 1000);
} else if (host !== "box") setTimeout(() => {}, 1e9);
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
    const stopped = {
      reachable: true,
      stdout: "started\n",
      error: "timed out after 2 s, so the command was stopped",
    };
    expect(JSON.parse(run.stdout)).toEqual([
      { host: hostname(), ...stopped },
      { host: "box", ...stopped },
    ]);
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

  it("runs an entry here only when it is this machine for certain, and tries the rest over ssh", async () => {
    const m = machine();
    vi.stubEnv("FLEETRC_SSH", fakeSsh(m).FLEETRC_SSH);
    const label = hostname().split(".")[0];
    const elsewhere = [`${label}.example`, `ssh://review@${label}:2222`];
    try {
      const results = await fleetRun(
        [hostname(), "me.tail.ts.net", ...elsewhere].map((host) => ({ host })),
        ["sh", "-c", "echo here"],
        2_000,
        { here: false, magicDNS: "me.tail.ts.net" },
      );
      expect(results).toEqual([
        { host: hostname(), reachable: true, exitCode: 0, stdout: "here\n", stderr: "" },
        ...elsewhere.map((host) => expect.objectContaining({ host, reachable: false })),
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

  it("needs a command after --", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["box"] });
    const run = await m.run("fleet", "run", "--manifest", manifest, "--json");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("fleet run takes the command to run after --");
  });
});

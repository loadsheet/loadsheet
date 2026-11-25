import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReport, parseScan } from "@loadsheet/schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { fleetScans } from "../src/fleet.ts";

// Runs the built CLI, so `pnpm build` comes first.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const transcripts = fileURLToPath(new URL("../../harnesses/test/fixtures/", import.meta.url));
const CANARY = "CANARY-LS";
/** What the hosts that send no Scan print, on stdout and stderr; it must reach no output. */
const SECRET = "SECRET-WORD-LS";

/**
 * A machine's home: the harnesses' fixture transcripts and a skill whose description is too long,
 * so expensive-description finds it there, and whose body holds the canary.
 */
const makeHome = (home: string, skill: string) => {
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  cpSync(
    join(transcripts, "claude-code", "session.jsonl"),
    join(home, ".claude", "projects", "p", "session.jsonl"),
  );
  mkdirSync(join(home, ".claude", "skills", skill), { recursive: true });
  writeFileSync(
    join(home, ".claude", "skills", skill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: Use when ${"the task comes up again and again, ".repeat(12)}\n---\n\n${CANARY} body.\n`,
  );
};

/**
 * A fake `ssh` on PATH. It logs each call, skips ssh's options and the `--`, and runs the remote
 * command with `sh -c` as host `box`, `extra`, `junk`, `broken` or `slow`, with FLEET_HOST set and HOME at
 * that host's home. The folder fleet's run makes here is renamed, so no host passes for this
 * machine. Any other host is unreachable: ssh says why, with the secret, and exits 255.
 */
const fakeSsh = (bin: string, log: string, homes: string) => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "ssh"),
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, command] = args;
if (!["box", "extra", "junk", "broken", "slow"].includes(host)) {
  process.stderr.write("ssh: connect to host " + host + " port 22: Connection refused ${SECRET}\\n");
  process.exit(255);
}
const home = join(${JSON.stringify(homes)}, host);
const run = spawnSync("sh", ["-c", command.replaceAll(/fleetrc-run-\\w+/g, "fleetrc-run-elsewhere")], {
  stdio: "inherit",
  env: {
    ...process.env,
    FLEET_HOST: host,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
  },
});
process.exit(run.status ?? 1);
`,
    { mode: 0o755 },
  );
};

/**
 * What LOADSHEET_FLEET_COMMAND runs on a host: loadsheet itself on `box`; on `extra` its Scan with
 * keys the schema does not name, holding the secret; and on the others something that is not a
 * Scan, or no answer in time.
 */
const remoteScript = (file: string) =>
  writeFileSync(
    file,
    `import { spawnSync } from "node:child_process";
const host = process.env.FLEET_HOST;
if (host === "box") {
  const run = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
if (host === "extra") {
  const run = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { encoding: "utf8" });
  const scan = JSON.parse(run.stdout);
  scan.note = "${SECRET}";
  scan.items[0].note = "${SECRET}";
  scan.coverage[0].signals.note = "${SECRET}";
  process.stdout.write(JSON.stringify(scan));
  process.exit(0);
}
process.stderr.write("${SECRET} at /home/someone/private\\n");
if (host === "junk") process.stdout.write('{"schema":1,"machine":"${SECRET}","note":"${SECRET}"}\\n');
if (host === "broken") process.exit(1);
if (host === "slow") setTimeout(() => {}, 60_000);
`,
  );

describe("loadsheet with a fleet", () => {
  let root: string;
  let home: string;
  let log: string;
  let env: Record<string, string>;
  const manifest = (fleet: string[]) => {
    const file = join(root, "manifest", ".fleetrc", "manifest.json");
    mkdirSync(join(root, "manifest", ".fleetrc"), { recursive: true });
    writeFileSync(file, JSON.stringify({ agents: ["claude-code"], sources: [], fleet }));
    mkdirSync(join(root, "config", "fleetrc"), { recursive: true });
    writeFileSync(
      join(root, "config", "fleetrc", "config.json"),
      JSON.stringify({ manifest: file }),
    );
  };
  const loadsheet = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      cwd: home,
      env: { ...env, ...extra },
    });
  const sshCalls = () => existsSync(log);
  const findings = ["--rule", "expensive-description.maxChars=100"];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "loadsheet-fleet-"));
    home = join(root, "home");
    log = join(root, "ssh.log");
    makeHome(home, "desk-notes");
    makeHome(join(root, "hosts", "box"), "box-notes");
    makeHome(join(root, "hosts", "extra"), "extra-notes");
    for (const host of ["junk", "broken", "slow"]) mkdirSync(join(root, "hosts", host));
    fakeSsh(join(root, "bin"), log, join(root, "hosts"));
    remoteScript(join(root, "remote.mjs"));
    mkdirSync(join(root, "config", "loadsheet"), { recursive: true });
    // A window long enough to hold the fixtures' days whenever the test runs.
    writeFileSync(
      join(root, "config", "loadsheet", "config.json"),
      JSON.stringify({ window: 3650 }),
    );
    env = {
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      LOADSHEET_FLEET_COMMAND: `${process.execPath} ${join(root, "remote.mjs")}`,
    };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("merges the other machine's Scan into one Report, with findings from both", () => {
    manifest(["box"]);
    const result = loadsheet(["--fleet", "--json", ...findings]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("Read 2 of 2 machines\n");
    const report = parseReport(JSON.parse(result.stdout));
    // Both machines call themselves this hostname, so the other one goes by its fleet name too.
    const box = `${hostname()} (box)`;
    expect(report.mode).toBe("fleet");
    expect(report.machines.map(({ name, reachable }) => [name, reachable])).toEqual([
      [hostname(), true],
      [box, true],
    ]);
    expect([...new Set(report.coverage.map((row) => row.machine))]).toEqual([hostname(), box]);
    const fixed = Object.fromEntries(
      report.findings.map((finding) => [finding.id, finding.fixes.map((fix) => fix.machine)]),
    );
    expect(fixed).toMatchObject({
      "expensive-description:skill:desk-notes": [hostname()],
      "expensive-description:skill:box-notes": [box],
    });
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stdout).not.toContain(root);
  });

  it("lists a host that sends no Scan with a fixed phrase, and nothing it printed", () => {
    manifest(["box", "extra", "gone", "junk", "broken", "slow"]);
    const json = loadsheet(["--fleet", "--json", "--timeout", "4", ...findings]);
    expect(json.status, json.stderr).toBe(0);
    expect(json.stderr).toBe("Read 3 of 7 machines\n");
    const report = parseReport(JSON.parse(json.stdout));
    // extra's Scan validates, and only the keys the schema names are kept.
    expect(report.machines[2]).toMatchObject({ name: `${hostname()} (extra)`, reachable: true });
    expect(report.findings.map((finding) => finding.id)).toContain(
      "expensive-description:skill:extra-notes",
    );
    expect(report.machines.slice(3)).toEqual([
      { name: "gone", reachable: false, error: "offline" },
      { name: "junk", reachable: false, error: "sent no Scan" },
      { name: "broken", reachable: false, error: "loadsheet failed there" },
      { name: "slow", reachable: false, error: "timed out" },
    ]);
    // The text says the same, from the same Report.
    const text = loadsheet(["--fleet", "--timeout", "4", ...findings]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("not read: junk (sent no Scan)");
    for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) {
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain("/home/someone");
      expect(output).not.toContain(CANARY);
    }
  }, 30_000);

  it("reports this machine alone, exit 0, when no other machine answers", () => {
    manifest(["gone"]);
    const result = loadsheet(["--fleet", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("Read 1 of 2 machines; no other machine could be read\n");
    expect(parseReport(JSON.parse(result.stdout)).machines).toEqual([
      expect.objectContaining({ name: hostname(), reachable: true }),
      { name: "gone", reachable: false, error: "offline" },
    ]);
  });

  it("leaves a fleet name to the host that has it, whatever another host calls itself", () => {
    const scan = JSON.parse(loadsheet(["--scan", "--days", "3650"]).stdout);
    const { scans, machines } = fleetScans(parseScan({ ...scan, machine: "desk" }), [
      {
        host: "alias",
        reachable: true,
        exitCode: 0,
        stdout: JSON.stringify({ ...scan, machine: "build" }),
        stderr: "",
      },
      { host: "build", reachable: false, stdout: "", stderr: "", error: "offline in Tailscale" },
      { host: "build (alias)", reachable: false, stdout: "", stderr: "", error: "refused" },
    ]);
    expect(scans.map((one) => one.machine)).toEqual(["desk", "build #2"]);
    expect(machines).toEqual([
      { name: "build", reachable: false, error: "offline" },
      { name: "build (alias)", reachable: false, error: "offline" },
    ]);
  });

  it("leaves a peer its fleet name even when this machine has the same hostname", () => {
    const here = parseScan({
      schema: 1,
      tool: "loadsheet@0.0.1",
      machine: "build",
      scannedAt: "2026-01-01T00:00:00.000Z",
      window: ["2026-01-01", "2026-01-01"],
      coverage: [],
      items: [],
      sessions: [],
      cells: [],
    });
    const { scans, machines } = fleetScans(here, [
      { host: "build", reachable: false, stdout: "", stderr: "", error: "refused" },
    ]);
    expect(scans[0]?.machine).toBe("build (local)");
    expect(machines).toEqual([{ name: "build", reachable: false, error: "offline" }]);
  });

  it("reads no Scan from the end of an output that was cut", () => {
    const scan = JSON.parse(loadsheet(["--scan", "--days", "3650"]).stdout);
    const sent = { reachable: true, exitCode: 0, stdout: JSON.stringify(scan), stderr: "" };
    const { scans, machines } = fleetScans(parseScan({ ...scan, machine: "desk" }), [
      { host: "whole", ...sent },
      { host: "cut", ...sent, truncated: true },
    ]);
    expect(scans).toHaveLength(2);
    expect(machines).toEqual([{ name: "cut", reachable: false, error: "sent no Scan" }]);
  });

  it("takes a fleet of empty entries for no fleet", () => {
    rmSync(log, { force: true });
    manifest(["", " "]);
    const result = loadsheet(["--fleet", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseReport(JSON.parse(result.stdout)).mode).toBe("local");
    expect(sshCalls()).toBe(false);
  });

  it("reports this machine alone without --fleet, with the old --local, and with no fleet config", () => {
    rmSync(log, { force: true });
    manifest(["box"]);
    for (const args of [["--json"], ["--json", "--local"]]) {
      const local = loadsheet(args);
      expect(local.status).toBe(0);
      expect(local.stderr).toBe("");
      expect(parseReport(JSON.parse(local.stdout)).mode).toBe("local");
    }
    const none = loadsheet(["--fleet", "--json"], { XDG_CONFIG_HOME: join(root, "no-config") });
    expect(none.status).toBe(0);
    expect(none.stderr).toBe("");
    expect(parseReport(JSON.parse(none.stdout)).mode).toBe("local");
    expect(sshCalls()).toBe(false);
  });

  it("--scan prints this machine's Scan and nothing else", () => {
    manifest(["box"]);
    rmSync(log, { force: true });
    const result = loadsheet(["--scan", "--days", "3650", "--no-cache"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const scan = parseScan(JSON.parse(result.stdout));
    expect(scan.machine).toBe(hostname());
    expect(scan.items.map((item) => item.id)).toContain("skill:desk-notes");
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stdout).not.toContain(root);
    expect(sshCalls()).toBe(false);
  });

  it("loadsheet fleet runs fleetrc's CLI under that name, with its own flags", () => {
    rmSync(log, { force: true });
    const help = loadsheet(["fleet", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: loadsheet fleet [command]");
    // --dry-run is fleetrc's alone: loadsheet's parser would refuse it.
    const run = loadsheet(["fleet", "fleet", "run", "--dry-run", "--", "true"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toBe("loadsheet fleet: fleet run has no --dry-run\n");
    expect(sshCalls()).toBe(false);
  });
});

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildReport, packReport, PROMPT_DOC, renderText } from "@loadsheet/core";
import { runOnFleet, type RunResult } from "@loadsheet/fleet";
import { claudeCode, findHarness, harnesses } from "@loadsheet/harnesses";
import type { Files } from "@loadsheet/kit";
import {
  dirFiles,
  githubFiles,
  githubUrl,
  scanMachine,
  type ScanProgress,
} from "@loadsheet/kit/node";
import { parseConfig, resolveConfig, RULES, type Config } from "@loadsheet/schema";
import pkg from "../package.json" with { type: "json" };
import { fleetScans } from "./fleet.ts";

const ids = harnesses.map((h) => h.id).join(", ");

const usage = `loadsheet ${pkg.version}
Reports which skills, instruction files and MCP servers cost your coding agents context without being used.

Usage: loadsheet [options]                     Scan this machine's sessions and report
       loadsheet <dir | GitHub URL> [options]  Weigh a skill pack, with no usage data
       loadsheet fleet [command] [options]     Run fleetrc, which keeps a fleet's skills in sync;
                                               \`loadsheet fleet --help\` lists its commands
       loadsheet build [--out <dir>] [options] Write the report as a web page to <dir>
                                               (default ./loadsheet-report)
       loadsheet --ui [--port <n>] [options]   Serve the report as a web page on 127.0.0.1

  <dir | GitHub URL>  A URL is https://github.com/<owner>/<repo>[/tree/<ref>[/<folder>]].
                      A pack in a folder named fleet or build is ./fleet or ./build.

Options:
  --fleet               Also ask every other machine of this machine's fleet for its Scan, over
                        ssh, and report them all in one Report
  --scan                Print this machine's Scan as JSON: what each machine of a fleet sends.
                        It holds every session in --days: --harness, --ignore, --via,
                        --exclude-via and --rule shape a Report
  --timeout <seconds>   With --fleet, how long to wait for each machine (default 300)
  --config <path>       Config file (default $XDG_CONFIG_HOME/loadsheet/config.json,
                        else ~/.config/loadsheet/config.json)
  --days <n>            Days of history to read (default 30)
  --harness <id>        Report only this harness, repeatable (${ids}); a pack is weighed
                        for one (default ${claudeCode.id})
  --ignore <id>         Leave an item out of the findings, repeatable, as kind:name
  --via <name>          Read only sessions started from this entrypoint, repeatable
  --exclude-via <name>  Skip sessions started from this entrypoint, repeatable
  --rule <id>=off|on    Turn a rule off or on, repeatable
  --rule <id>.<option>=<n>
                        Set a rule's threshold, repeatable
  --no-cache            Read every transcript in full and write no cache
  --json                Print the Report as JSON
  -v, --version         Print the version
  -h, --help            Print this help

Flags override the config file; --ignore adds to its list, the others replace it.
Rules: ${RULES.join(", ")}.

With --fleet: when fleetrc's config.json ($XDG_CONFIG_HOME/fleetrc, else ~/.config/fleetrc) names a
manifest whose fleet lists other machines, loadsheet asks each over ssh for its Scan, counters,
names and skill descriptions, by running \`npx -y loadsheet@${pkg.version} --scan --days <n>\` there,
and reports every machine in one Report. LOADSHEET_FLEET_COMMAND, split on spaces, replaces
\`npx -y loadsheet@${pkg.version}\`, to run another build there, such as one not yet on npm.

loadsheet changes none of your files. To have your agent apply the fixes you accept,
paste it the prompt in ${PROMPT_DOC}
`;

/** A usage error: the reason and the usage, exit 2. */
function fail(message: string): never {
  process.stderr.write(`${message}\n\n${usage}`);
  process.exit(2);
}

/** A config error: the reason only, exit 2. */
function failConfig(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      days: { type: "string" },
      harness: { type: "string", multiple: true },
      ignore: { type: "string", multiple: true },
      via: { type: "string", multiple: true },
      "exclude-via": { type: "string", multiple: true },
      rule: { type: "string", multiple: true },
      "no-cache": { type: "boolean" },
      json: { type: "boolean" },
      fleet: { type: "boolean" },
      // The default since 0.1.0; still taken so older scripts keep working.
      local: { type: "boolean" },
      scan: { type: "boolean" },
      timeout: { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  fail((error as Error).message);
}
const { values, positionals } = args;

if (values.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (values.help) {
  process.stdout.write(usage);
  process.exit(0);
}
if (positionals.length > 1) fail(`Expected at most one pack, got ${positionals.length}`);
if (values.fleet && values.scan) fail("--scan prints this machine's Scan; it takes no --fleet");
if (values.fleet && values.local) fail("--local and --fleet ask for different reports");
for (const flag of ["fleet", "local", "scan", "timeout"] as const)
  if (positionals.length > 0 && values[flag] !== undefined)
    fail(`--${flag} is for this machine and its fleet, not a pack`);
if (values.timeout !== undefined && !values.fleet) fail("--timeout is for --fleet");
const timeoutMs = values.timeout === undefined ? 300_000 : Number(values.timeout) * 1000;
if (!/^\d+$/u.test(values.timeout ?? "300") || timeoutMs < 1000 || timeoutMs > 86_400_000)
  fail(`--timeout takes a whole number of seconds from 1 to 86400, got ${values.timeout}`);

const defaultConfigPath = () => {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"),
    "loadsheet",
    "config.json",
  );
};

/** The config file, or none when the default file is missing. */
const readConfigFile = async (): Promise<Config> => {
  const path = values.config ?? defaultConfigPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && values.config === undefined) return {};
    failConfig(
      `Cannot read config ${path}: ${code === "ENOENT" ? "no such file" : (error as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    failConfig(`Config ${path} is not JSON: ${(error as Error).message}`);
  }
  try {
    return parseConfig(json);
  } catch (error) {
    failConfig(`Config ${path}: ${(error as Error).message}`);
  }
};

const RULE_TOGGLE = /^([a-z][a-z-]*)=(off|on)$/u;
const RULE_OPTION = /^([a-z][a-z-]*)\.([A-Za-z]+)=(.+)$/u;

/** The config file with the flags laid over it. */
const withFlags = (file: Config): Config => {
  const config: Config = structuredClone(file);
  if (values.days !== undefined) {
    const days = Number(values.days);
    if (!/^\d+$/u.test(values.days) || days < 1)
      fail(`--days takes a whole number of 1 or more, got ${values.days}`);
    config.window = days;
  }
  if (values.harness) config.harnesses = values.harness;
  if (values.ignore) config.ignore = [...(config.ignore ?? []), ...values.ignore];
  if (values.via) config.via = { ...config.via, include: values.via };
  if (values["exclude-via"]) config.via = { ...config.via, exclude: values["exclude-via"] };
  const rules: Record<string, false | Record<string, number>> = { ...config.rules };
  for (const flag of values.rule ?? []) {
    const toggle = RULE_TOGGLE.exec(flag);
    const option = RULE_OPTION.exec(flag);
    if (toggle) {
      const [, id, state] = toggle;
      rules[id!] = state === "off" ? false : rules[id!] || {};
    } else if (option) {
      const [, id, key, raw] = option;
      const value = Number(raw);
      if (raw!.trim() === "" || Number.isNaN(value)) fail(`--rule ${flag}: ${raw} is not a number`);
      rules[id!] = { ...rules[id!], [key!]: value };
    } else {
      fail(`--rule takes <id>=off, <id>=on or <id>.<option>=<number>, got ${flag}`);
    }
  }
  if (Object.keys(rules).length) config.rules = rules as Config["rules"];
  try {
    return parseConfig(config);
  } catch (error) {
    fail((error as Error).message.replace(/^Invalid config/u, "Invalid flags"));
  }
};

const config = resolveConfig(withFlags(await readConfigFile()));
const tool = `loadsheet@${pkg.version}`;
const print = (report: Parameters<typeof renderText>[0]) =>
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));

/**
 * The Scan of each other machine in this machine's fleet, or undefined when it has none. A fleet
 * config that does not read is said on stderr, and this machine is reported alone.
 */
const askFleet = async (): Promise<RunResult[] | undefined> => {
  const custom = process.env.LOADSHEET_FLEET_COMMAND?.trim().split(/\s+/u).filter(Boolean);
  const [program, ...args] = custom?.length ? custom : ["npx", "-y", tool];
  const argv: [string, ...string[]] = [
    program!,
    ...args,
    "--scan",
    "--days",
    String(config.window),
    ...(values["no-cache"] ? ["--no-cache"] : []),
  ];
  try {
    const results = await runOnFleet(argv, { timeoutMs });
    // A fleet whose every host is this machine is no fleet.
    return results?.length ? results : undefined;
  } catch (error) {
    process.stderr.write(
      `Cannot read the fleet's config, so only this machine is read: ${(error as Error).message}\n`,
    );
    return undefined;
  }
};

/**
 * Progress on stderr for a scan that takes over 2 s, such as a first run, which reads every
 * transcript before the cache holds them. On a terminal one line is rewritten in place and cleared
 * at the end; elsewhere a line is printed every 5 s.
 */
function scanProgress() {
  const started = Date.now();
  const tty = process.stderr.isTTY === true;
  const names: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
  let latest: ScanProgress | undefined;
  let printed = 0;
  let shown = false;
  const line = () =>
    latest
      ? `Reading ${names[latest.harness] ?? latest.harness} sessions: ${latest.done.toLocaleString("en-US")} of ${latest.total.toLocaleString("en-US")} files`
      : "Reading this machine's sessions";
  const show = () => {
    if (tty) process.stderr.write(`\r\u001b[2K${line()}`);
    else process.stderr.write(`${line()}\n`);
    printed = Date.now();
    shown = true;
  };
  const timer = setTimeout(() => {
    if (!tty)
      process.stderr.write("The first run reads every transcript; later runs use a cache.\n");
    show();
  }, 2000);
  timer.unref();
  return {
    update: (progress: ScanProgress) => {
      latest = progress;
      if (Date.now() - started < 2000) return;
      if (tty ? Date.now() - printed >= 100 : Date.now() - printed >= 5000) show();
    },
    stop: () => {
      clearTimeout(timer);
      if (shown && tty) process.stderr.write("\r\u001b[2K");
    },
  };
}

if (positionals.length === 0) {
  for (const id of config.harnesses ?? []) {
    if (!findHarness(id)) fail(`Unknown harness ${id}`);
  }
  const fleet = values.fleet ? askFleet() : undefined;
  let scan;
  // A fleet host's --scan runs over ssh, where no one reads stderr.
  const progress = values.scan ? { update: () => {}, stop: () => {} } : scanProgress();
  try {
    // Every harness is read, whatever --harness says: whether a path is safe to remove depends on
    // every harness that loads it. The Report keeps only the wanted harnesses' sheets.
    scan = await scanMachine({
      harnesses,
      days: config.window,
      tool,
      onProgress: progress.update,
      ...(values["no-cache"] ? { cacheDir: false as const } : {}),
    });
  } catch (error) {
    progress.stop();
    process.stderr.write(`Cannot scan this machine: ${(error as Error).message}\n`);
    process.exit(1);
  }
  progress.stop();
  if (values.scan) {
    process.stdout.write(`${JSON.stringify(scan)}\n`);
  } else {
    const results = await fleet;
    const { scans, machines } = results
      ? fleetScans(scan, results)
      : { scans: [scan], machines: [] };
    if (results) {
      const total = scans.length + machines.length;
      process.stderr.write(
        `Read ${scans.length} of ${total} machines${scans.length === 1 ? "; no other machine could be read" : ""}\n`,
      );
    }
    // Findings never change the exit code, and neither does a machine that could not be read.
    print(buildReport({ scans, machines, config, now: new Date(), tool }));
  }
} else {
  const target = positionals[0]!;
  if ((values.harness?.length ?? 0) > 1) fail("A pack is weighed for one harness");
  const harness = values.harness === undefined ? claudeCode : findHarness(values.harness[0]!);
  if (!harness) fail(`Unknown harness ${values.harness![0]}`);

  const isUrl = /^[a-z][a-z\d+.-]*:\/\//iu.test(target);
  let files: Files;
  try {
    files = isUrl ? await githubFiles(target) : await dirFiles(target);
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "no such directory"
        : (error as Error).message;
    fail(`Cannot read ${target}: ${reason}`);
  }

  print(
    packReport({
      items: await harness.inventory(files),
      harness,
      source: isUrl ? githubUrl(target) : basename(resolve(target)),
      config,
      now: new Date(),
      tool,
    }),
  );
}

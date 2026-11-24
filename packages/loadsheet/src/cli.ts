#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildReport, packReport, renderText } from "@loadsheet/core";
import { claudeCode, findHarness, harnesses } from "@loadsheet/harnesses";
import type { Files } from "@loadsheet/kit";
import { dirFiles, githubFiles, githubUrl, scanMachine } from "@loadsheet/kit/node";
import { parseConfig, resolveConfig, RULES, type Config } from "@loadsheet/schema";
import pkg from "../package.json" with { type: "json" };

const ids = harnesses.map((h) => h.id).join(", ");

const usage = `loadsheet ${pkg.version}
Reports which skills, instruction files and MCP servers cost your coding agents context without being used.

Usage: loadsheet [options]                     Scan this machine's sessions and report
       loadsheet <dir | GitHub URL> [options]  Weigh a skill pack, with no usage data

  <dir | GitHub URL>  A URL is https://github.com/<owner>/<repo>[/tree/<ref>[/<folder>]].

Options:
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

if (positionals.length === 0) {
  for (const id of config.harnesses ?? []) {
    if (!findHarness(id)) fail(`Unknown harness ${id}`);
  }
  let scan;
  try {
    // Every harness is read, whatever --harness says: whether a path is safe to remove depends on
    // every harness that loads it. The Report keeps only the wanted harnesses' sheets.
    scan = await scanMachine({
      harnesses,
      days: config.window,
      tool,
      ...(values["no-cache"] ? { cacheDir: false as const } : {}),
    });
  } catch (error) {
    process.stderr.write(`Cannot scan this machine: ${(error as Error).message}\n`);
    process.exit(1);
  }
  // Findings never change the exit code.
  print(buildReport({ scans: [scan], config, now: new Date(), tool }));
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

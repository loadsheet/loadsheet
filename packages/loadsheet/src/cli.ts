#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packReport, renderText } from "@loadsheet/core";
import { claudeCode, findHarness, harnesses } from "@loadsheet/harnesses";
import type { Files } from "@loadsheet/kit";
import { dirFiles, githubFiles, githubUrl } from "@loadsheet/kit/node";
import { resolveConfig } from "@loadsheet/schema";
import pkg from "../package.json" with { type: "json" };

const usage = `loadsheet ${pkg.version}
Reports which skills, instruction files and MCP servers cost your coding agents context without being used.

Usage: loadsheet <dir | GitHub URL> [options]

  <dir | GitHub URL>  Weigh a skill pack: what it adds to every session, with no usage data.
                      A URL is https://github.com/<owner>/<repo>[/tree/<ref>[/<folder>]].

Options:
  --json             Print the Report as JSON
  --harness <id>     The harness to weigh for (${harnesses.map((h) => h.id).join(", ")}; default ${claudeCode.id})
  -v, --version      Print the version
  -h, --help         Print this help
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${usage}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      harness: { type: "string" },
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
if (values.help || positionals.length === 0) {
  process.stdout.write(usage);
  process.exit(0);
}
if (positionals.length > 1) fail(`Expected one pack, got ${positionals.length}`);

const target = positionals[0]!;
const harness = values.harness === undefined ? claudeCode : findHarness(values.harness);
if (!harness) fail(`Unknown harness ${values.harness}`);

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

const report = packReport({
  items: await harness.inventory(files),
  harness,
  source: isUrl ? githubUrl(target) : basename(resolve(target)),
  config: resolveConfig(),
  now: new Date(),
  tool: `loadsheet@${pkg.version}`,
});
process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));

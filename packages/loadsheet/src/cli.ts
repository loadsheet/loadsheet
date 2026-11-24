#!/usr/bin/env node
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };

const usage = `loadsheet ${pkg.version}
Reports which skills, instruction files and MCP servers cost your coding agents context without being used.

Usage: loadsheet [options]

Options:
  -v, --version  Print the version
  -h, --help     Print this help
`;

let values: { version?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n\n${usage}`);
  process.exit(2);
}

if (values.version) process.stdout.write(`${pkg.version}\n`);
else process.stdout.write(usage);

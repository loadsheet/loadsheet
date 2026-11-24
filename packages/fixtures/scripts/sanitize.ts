// pnpm --filter @loadsheet/fixtures sanitize <in.jsonl> <out.jsonl> [--policy <module>]
// The policy module default-exports a Policy (or exports `policy`); without one every string is replaced.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CANARY, findCanary, sanitizeJsonl, type Policy } from "../src/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { policy: { type: "string" } },
});
if (positionals.length !== 2) {
  console.error("Usage: sanitize <in.jsonl> <out.jsonl> [--policy <module>]");
  process.exit(2);
}
// pnpm runs scripts in the package directory; paths are relative to where it was called.
const cwd = process.env.INIT_CWD ?? process.cwd();
const [input, output] = positionals.map((path) => NodePath.resolve(cwd, path)) as [string, string];

let policy: Policy = {};
if (values.policy !== undefined) {
  const module = (await import(pathToFileURL(NodePath.resolve(cwd, values.policy)).href)) as {
    default?: Policy;
    policy?: Policy;
  };
  policy = module.default ?? module.policy ?? {};
}

const text = await NodeFSP.readFile(input, "utf8");
const sanitized = sanitizeJsonl(text, policy);
await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
await NodeFSP.writeFile(output, sanitized);

const lines = sanitized.split("\n").filter((line) => line.trim() !== "");
const withCanary = lines.filter((line) => {
  try {
    return findCanary(JSON.parse(line)).length > 0;
  } catch {
    return line.includes(CANARY);
  }
}).length;
console.log(`${lines.length} lines written to ${output}, ${withCanary} carry the canary.`);

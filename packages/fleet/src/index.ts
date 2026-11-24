import type { RunResult } from "./fleet.ts";
import { setCliName } from "./name.ts";

export type { RunResult };

/**
 * Runs `argv` on every host of this machine's fleet, as `fleet run` does, and never on this machine:
 * a host that turns out to be this machine is left out. The fleet is the one in the manifest
 * fleetrc's config.json names, read as it was last fetched. Undefined when there is no config.json
 * or its manifest names no host. Throws when config.json or the manifest does not read.
 */
export async function runOnFleet(
  argv: readonly [string, ...string[]],
  { timeoutMs }: { timeoutMs: number },
): Promise<RunResult[] | undefined> {
  const { loadManifest, readConfig } = await import("./manifest.ts");
  const config = readConfig();
  if (!config) return undefined;
  const { root } = await loadManifest(config.manifest, { offline: true, readOnly: true });
  if (root.fleet.length === 0) return undefined;
  const { fleetRun, resolveFleet } = await import("./fleet.ts");
  const { targets } = await resolveFleet(root.fleet, undefined, timeoutMs);
  return fleetRun(targets, argv, timeoutMs, { here: "leave out" });
}

/**
 * Runs the fleetrc CLI on `argv`, the arguments after the program name, as `name`: the command the
 * user typed, such as `fleetrc` or `loadsheet fleet`, which help and error text name. Like the CLI
 * it is, it writes to stdout and stderr and sets process.exitCode, and a command line it can't
 * run exits the process with code 2. Run it once per process.
 */
export async function run(argv: readonly string[], name: string): Promise<void> {
  setCliName(name);
  // What an agent's session hook runs, when a session starts: hook.ts alone, without the rest of
  // the CLI. `hook prompt`, the legacy Claude Code hook, only reports new skills and never starts a sync.
  const [command, action, agent] = argv;
  if (command === "hook" && action === "prompt" && argv.length === 2)
    return import("./hook.ts").then((hook) => hook.runHook("claude-code", true));
  if (
    command === "hook" &&
    action === "run" &&
    (agent === "claude-code" || agent === "codex") &&
    argv.length === 3
  )
    return import("./hook.ts").then((hook) => hook.runHook(agent));
  // What programs built on fleetrc run: list.ts reads state.json alone. An error it meets (a
  // state.json it may not read) goes to the CLI, which says it in one line.
  if (command === "list" && action === "--json" && argv.length === 2)
    return import("./list.ts")
      .then((list) => list.printSkillList())
      .catch(() => import("./cli.ts").then(({ cli }) => cli(argv)));
  if ((command === "--version" || command === "-v") && argv.length === 1)
    return import("./version.ts").then(({ version }) => console.log(version));
  return import("./cli.ts").then(({ cli }) => cli(argv));
}

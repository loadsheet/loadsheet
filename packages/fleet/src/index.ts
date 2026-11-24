import { setCliName } from "./name.ts";

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

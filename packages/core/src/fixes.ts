// What the user's agent should change, per harness and per installer. loadsheet never runs any of
// it: a Fix names the machine, the path and, when one exists, the exact command.
import type { Fix, Item, Line } from "@loadsheet/schema";
import type { Install, RuleSheet, Unfiltered } from "./rules/rule.ts";

/** A word the shell reads as itself, or the text in single quotes. */
const quote = (text: string) =>
  /^[\w@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/** A path for the shell, keeping a leading `~/` outside the quotes so the shell expands it. */
const shellPath = (path: string) =>
  path.startsWith("~/") ? `~/${quote(path.slice(2))}` : quote(path);

const baseName = (path: string) => path.replace(/\/+$/u, "").split("/").pop() ?? path;

/** A skill's SKILL.md: its path when that is a file, else the file in its folder. */
const skillFile = (path: string) => (path.endsWith(".md") ? path : `${path}/SKILL.md`);

/** The change that keeps one install from the model, without a machine. */
type Change = Omit<Fix, "machine">;

/** What a harness offers: how to hide a skill from its model, and its id in the skills CLI. */
interface HarnessFixes {
  /** The change that hides one install, or none when no change to it would last. */
  hide: (item: Item) => Change | undefined;
  /** The change that turns one install off in this harness alone, where another harness uses its path. */
  off?: (item: Item, sheet: RuleSheet, machine: string) => Change | undefined;
  /** The skills CLI's `--agent` id for this harness. */
  skillsAgent?: string;
  /** Whether a bare listing is the user's own choice, not the listing's budget. */
  bareByChoice?: (item: Item) => boolean;
}

/** A path under Claude Code's config directory, which the first group names. */
const CONFIG_DIR = /^(.*?)\/(?:skills|commands|agents|rules|plugins)\//u;

/** Claude Code's config directory, from the path of something installed in it. */
const claudeConfigDir = (path: string) => CONFIG_DIR.exec(path)?.[1] ?? "~/.claude";

/** Claude Code's settings file on the machine of an install. */
export const claudeSettingsPath = (item: Item) => `${claudeConfigDir(item.path)}/settings.json`;

/**
 * Claude Code's user settings file on a machine: in the config directory one of its user or plugin
 * Items is under, else `~/.claude`. A project's Item names the project's directory, so it is skipped.
 */
const userSettingsPath = (sheet: RuleSheet, machine: string) => {
  for (const item of sheet.itemsOn(machine)) {
    if (item.scope === "project") continue;
    const dir = CONFIG_DIR.exec(item.path)?.[1];
    if (dir !== undefined) return `${dir}/settings.json`;
  }
  return "~/.claude/settings.json";
};

/**
 * A path in Codex's home, which the first group names: its own skills folder, its plugins, its
 * AGENTS.md or the config.toml its MCP servers come from. `~/.agents/skills` is not in it.
 */
const CODEX_HOME =
  /^(.*?)\/(?:skills\/|plugins\/cache\/|AGENTS(?:\.override)?\.md$|config\.toml$)/u;

/**
 * Codex's config.toml on a machine: in the home one of its user or plugin Items is in, since
 * `CODEX_HOME` moves it, else `~/.codex`.
 */
const codexConfigPath = (sheet: RuleSheet, machine: string) => {
  for (const item of sheet.itemsOn(machine)) {
    if (item.scope === "project") continue;
    const dir = CODEX_HOME.exec(item.path)?.[1];
    if (dir !== undefined && !dir.endsWith("/.agents")) return `${dir}/config.toml`;
  }
  return "~/.codex/config.toml";
};

const HARNESSES: Record<string, HarnessFixes> = {
  "claude-code": {
    // An installer rewrites the skill's files, so its skills are hidden in settings.json, where
    // `user-invocable-only` keeps `/name`. Claude Code reads no skillOverrides for a plugin's
    // skills, and a plugin update replaces its files, so a plugin's skill has no hide that lasts.
    hide: (item) => {
      if (item.managedBy === "plugin") return undefined;
      return item.managedBy === "skills" || item.managedBy === "fleetrc"
        ? {
            action: "hide-from-model",
            path: claudeSettingsPath(item),
            set: { key: `skillOverrides.${item.ref.name}`, value: "user-invocable-only" },
          }
        : {
            action: "hide-from-model",
            path: skillFile(item.path),
            set: { key: "disable-model-invocation", value: true },
          };
    },
    skillsAgent: "claude-code",
    // `skillOverrides: name-only` lists the skill as the bare `- name`, which is all its Item lists.
    bareByChoice: (item) =>
      item.modelInvocable && item.chars.listed === `- ${item.ref.name}\n`.length,
  },
  codex: {
    // Codex reads the setting only from `agents/openai.yaml` in the skill's folder, which only a
    // hand-made skill keeps. A plugin update replaces the plugin's files. The skills CLI's `update`
    // deletes the skill's folder and copies it afresh (`cleanAndCreateDirectory`), taking the file
    // with it. fleetrc keeps the file, but as a local edit of its copy, which holds back every
    // later update of the skill until the user resolves it.
    hide: (item) =>
      item.managedBy === "hand"
        ? {
            action: "hide-from-model",
            path: `${item.path.endsWith(".md") ? item.path.slice(0, item.path.lastIndexOf("/")) : item.path}/agents/openai.yaml`,
            set: { key: "policy.allow_implicit_invocation", value: false },
          }
        : undefined,
    // Codex's own config turns a skill off by its SKILL.md path, for the model and for `$name`, and
    // expands `~` in it. The key names the `[[skills.config]]` entry with that path, to add when
    // there is none. A plugin's path holds its version, so an entry for it would not last.
    off: (item, sheet, machine) =>
      item.managedBy === "plugin"
        ? undefined
        : {
            action: "set",
            path: codexConfigPath(sheet, machine),
            set: { key: `skills.config[path="${skillFile(item.path)}"].enabled`, value: false },
          },
    skillsAgent: "codex",
  },
};

const withMachine = (machine: string, change: Change | undefined): Fix | undefined =>
  change && { machine, ...change };

/** Each install of a line on the machines it holds for. */
export const installsOf = (sheet: RuleSheet, line: Line) => {
  const machines = new Set(line.machines);
  return sheet.installs(line.item).filter((install) => machines.has(install.machine));
};

/**
 * One Fix per distinct machine, action, path and key, and per machine and command: a command run
 * once does its work, so the same command again would fail. The first of each is kept.
 */
export const uniqueFixes = (fixes: Fix[]) => {
  const seen = new Set<string>();
  return fixes.filter((fix) => {
    const keys = [JSON.stringify([fix.machine, fix.action, fix.path, fix.set?.key])];
    if (fix.run !== undefined) keys.push(JSON.stringify([fix.machine, fix.run]));
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
};

/** Keeps a skill from one harness's model on every machine that has it. */
// A hide-from-model Fix needs a key or a command, so a harness loadsheet has no table for gets none.
export const hideFixes = (sheet: RuleSheet, line: Line): Fix[] => {
  const hide = HARNESSES[sheet.harness]?.hide;
  if (!hide) return [];
  return uniqueFixes(
    installsOf(sheet, line).flatMap(({ machine, item }) => withMachine(machine, hide(item)) ?? []),
  );
};

/** fleetrc's key for a name, as `fleetrc remove` compares a source id with what it is given. */
const fleetrcKey = (name: string) =>
  name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[. ]+$/u, "");

const removeOne = (
  sheet: RuleSheet,
  { machine, item }: Install,
  unfiltered: Unfiltered,
): Fix | undefined => {
  const table = HARNESSES[sheet.harness];
  const hide = () =>
    table ? withMachine(machine, table.hide(item) ?? table.off?.(item, sheet, machine)) : undefined;
  const usedBy = unfiltered.usedBy(item.id);
  // This harness used it in sessions the filters left out, so nothing about it is dead there.
  if (usedBy.includes(sheet.harness)) return undefined;
  // Another harness that loads this path uses it, or cannot tell whether it does on this machine:
  // hide it from this one, or turn it off here.
  const others = item.harnesses.filter((harness) => harness !== sheet.harness);
  if (others.some((other) => usedBy.includes(other) || !unfiltered.tellsUse(machine, other))) {
    return hide();
  }
  const remove: Fix = { machine, action: "remove", path: item.path };
  // A harness loadsheet has no table for gets the path and no command.
  if (!table) return remove;
  const name = quote(baseName(item.path));
  switch (item.managedBy) {
    case "skills": {
      if (!table.skillsAgent) return remove;
      const scope = item.scope === "user" ? " --global" : "";
      return {
        ...remove,
        run: `npx skills remove ${name}${scope} --agent ${table.skillsAgent} --yes`,
      };
    }
    // `fleetrc remove` adds the skill to its source's `exclude` in the manifest and syncs, which
    // unlinks it from every agent; other machines follow at their next sync, after a commit and
    // push when the manifest lives in a repository. So only a fleet Report that read every machine
    // and found no use of the skill anywhere, where every harness that loads a copy of it can tell
    // use, gives it; otherwise it is hidden or turned off here. It takes a name that matches a
    // source id as that whole source, so a skill named like a source any machine links from gets
    // no command.
    case "fleetrc": {
      const blind = unfiltered.machines.some((other) =>
        unfiltered
          .items(other)
          .some(
            (copy) =>
              copy.id === item.id &&
              copy.harnesses.some((harness) => !unfiltered.tellsUse(other, harness)),
          ),
      );
      if (!unfiltered.wholeFleet || usedBy.length || blind) return hide();
      const key = fleetrcKey(baseName(item.path));
      const source = unfiltered
        .items()
        .some((other) => other.managedBy === "fleetrc" && fleetrcKey(other.pack ?? "") === key);
      return source ? undefined : { ...remove, run: `fleetrc remove ${name}` };
    }
    // A plugin's skills come and go with the plugin, and an update replaces its files.
    case "plugin":
      return undefined;
    // A folder can hold skills of their own (Codex reads `parent/child/SKILL.md` as one), which
    // `rm -r` would take too, so such a folder is hidden instead.
    case "hand": {
      const folder = `${item.path.replace(/\/+$/u, "")}/`;
      const nested = unfiltered
        .items(machine)
        .some((other) => other !== item && other.path.startsWith(folder));
      return nested ? hide() : { ...remove, run: `rm -r ${shellPath(item.path)}` };
    }
  }
};

/**
 * Removes a skill from one harness on every machine that has it, or hides it where removing could
 * take it from a harness that uses it. Use is read from the Scans before any filter.
 */
export const removeFixes = (sheet: RuleSheet, line: Line, unfiltered: Unfiltered): Fix[] =>
  uniqueFixes(
    installsOf(sheet, line).flatMap((install) => removeOne(sheet, install, unfiltered) ?? []),
  );

/** Shortens the file that holds a skill's description, for each of these installs. */
export const shortenFixes = (installs: Install[]): Fix[] =>
  uniqueFixes(
    installs.map(({ machine, item }) => ({
      machine,
      action: "shorten",
      path: skillFile(item.path),
    })),
  );

/** Whether every install of a line lists it bare by the user's own setting. */
export const bareByChoice = (sheet: RuleSheet, line: Line) => {
  const test = HARNESSES[sheet.harness]?.bareByChoice;
  const installs = sheet.installs(line.item);
  return test !== undefined && installs.length > 0 && installs.every(({ item }) => test(item));
};

/** The bare listing entry of a skill, `- name`, which is all a session that lists it bare pays. */
export const bareEntry = (name: string) => `- ${name}\n`.length;

/**
 * The longest description Claude Code puts in a listing entry: the default of its
 * `skillListingMaxDescChars` setting (2.1.330), which cuts a longer one.
 */
const LISTED_DESCRIPTION_MAX = 1536;

/**
 * The characters one machine's Claude Code listing needs for every description: the full entry of
 * every skill its sessions listed in the window, ignored ones included since they still take room,
 * plus a tenth. A skill installed there counts its Item's entry; one installed nowhere loadsheet
 * reads, what the sessions that listed it in full held. One installed nowhere loadsheet reads and
 * listed bare in every session has an unknown description, so it counts at the longest Claude
 * Code lists: too low a budget could be under the one the machine has, while one above what the
 * listing needs costs nothing, since a session pays for the listing and not for the budget.
 * Undefined when no session listed a skill bare, so the budget already fits.
 */
const listingBudget = (sheet: RuleSheet, machine: string, unfiltered: Unfiltered) => {
  const listed = new Map<string, { sessions: number; bare: number; chars: number }>();
  for (const cell of unfiltered.cells(machine)) {
    if (cell.harness !== sheet.harness || !cell.item.startsWith("skill:")) continue;
    const known = listed.get(cell.item) ?? { sessions: 0, bare: 0, chars: 0 };
    known.sessions += cell.sessions;
    known.bare += cell.bare;
    known.chars += cell.chars;
    listed.set(cell.item, known);
  }
  if (![...listed.values()].some(({ bare }) => bare > 0)) return undefined;
  const installed = new Map<string, number>();
  for (const item of sheet.itemsOn(machine)) {
    installed.set(item.id, Math.max(installed.get(item.id) ?? 0, item.chars.listed));
  }
  let total = 0;
  for (const [id, { sessions, bare, chars }] of listed) {
    const own = installed.get(id);
    if (own !== undefined) total += own;
    else if (sessions > bare) {
      total += Math.round(
        (chars - bare * bareEntry(id.slice("skill:".length))) / (sessions - bare),
      );
    } else {
      // `- name: description` against `- name`.
      total += bareEntry(id.slice("skill:".length)) + ": ".length + LISTED_DESCRIPTION_MAX;
    }
  }
  return Math.ceil((total * 11) / 10);
};

/**
 * The settings change that gives Claude Code's skill listing room for every description, per
 * machine. Claude Code gives the listing `SLASH_COMMAND_TOOL_CHAR_BUDGET` characters when that
 * variable is set, else `contextWindow × 4 × (skillListingBudgetFraction ?? 0.01)`; past it, the
 * skills it has used least lose their descriptions. The Fix sets the variable in settings.json's
 * `env`, as a string since `env` holds strings: an absolute budget needs no knowledge of the
 * fraction or context window the machine has, where a fraction scaled from the default could
 * lower one the user already raised. Each machine gets the budget its own listing needs.
 */
export const listingBudgetFixes = (sheet: RuleSheet, line: Line, unfiltered: Unfiltered): Fix[] => {
  if (sheet.harness !== "claude-code") return [];
  // The budget is the machine's setting, so every machine the line holds for gets it, also one
  // where the skill is installed nowhere loadsheet reads, such as a project's or a bundled skill.
  return uniqueFixes(
    line.machines.flatMap((machine) => {
      const budget = listingBudget(sheet, machine, unfiltered);
      if (budget === undefined) return [];
      return [
        {
          machine,
          action: "set" as const,
          path: userSettingsPath(sheet, machine),
          set: { key: "env.SLASH_COMMAND_TOOL_CHAR_BUDGET", value: String(budget) },
        },
      ];
    }),
  );
};

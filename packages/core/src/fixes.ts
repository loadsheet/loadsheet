// What the user's agent should change, per harness and per installer. loadsheet never runs any of
// it: a Fix names the machine, the path and, when one exists, the exact command.
import type { Fix, Id, Item, Line } from "@loadsheet/schema";
import type { Install, RuleSheet } from "./rules/rule.ts";

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
    skillsAgent: "codex",
  },
};

const withMachine = (machine: string, change: Change | undefined): Fix | undefined =>
  change && { machine, ...change };

/** Each install of a line on the machines it holds for. */
const installsOf = (sheet: RuleSheet, line: Line) => {
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
  usedBy: string[],
): Fix | undefined => {
  const table = HARNESSES[sheet.harness];
  const hide = () => (table ? withMachine(machine, table.hide(item)) : undefined);
  // Another harness that loads this path still uses it: hide it from this one instead.
  if (item.harnesses.some((harness) => harness !== sheet.harness && usedBy.includes(harness))) {
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
    // push when the manifest lives in a repository. It takes a name that matches a source id as
    // that whole source, so a skill named like a source the machine links from gets no command.
    case "fleetrc": {
      if (usedBy.length) return hide();
      const key = fleetrcKey(baseName(item.path));
      const source = sheet
        .itemsOn(machine)
        .some((other) => other.managedBy === "fleetrc" && fleetrcKey(other.pack ?? "") === key);
      return source ? undefined : { ...remove, run: `fleetrc remove ${name}` };
    }
    // A plugin's skills come and go with the plugin, and an update replaces its files.
    case "plugin":
      return undefined;
    case "hand":
      return { ...remove, run: `rm -r ${shellPath(item.path)}` };
  }
};

/** Removes a skill from one harness on every machine that has it, or hides it where removing would take it from a harness that uses it. */
export const removeFixes = (sheet: RuleSheet, line: Line, usedBy: (item: Id) => string[]): Fix[] =>
  uniqueFixes(
    installsOf(sheet, line).flatMap(
      (install) => removeOne(sheet, install, usedBy(line.item)) ?? [],
    ),
  );

/** Shortens the file that holds a skill's description, on every machine that has it. */
export const shortenFixes = (sheet: RuleSheet, line: Line): Fix[] =>
  uniqueFixes(
    installsOf(sheet, line).map(({ machine, item }) => ({
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

/**
 * Claude Code's skill listing gets `contextWindow × 4 × skillListingBudgetFraction` characters
 * (default 0.01); past that, the skills it has used least lose their descriptions. The fraction that
 * fits every description is the default scaled by what the full listing takes over what sessions
 * listed, with a tenth for headroom. A user who already set the fraction gets a value scaled from
 * the default, which is why the fix says what to set rather than by how much to raise it.
 */
const DEFAULT_BUDGET_FRACTION = 0.01;

/** The settings change that gives Claude Code's skill listing room for every description, per machine. */
export const listingBudgetFixes = (sheet: RuleSheet, line: Line): Fix[] => {
  if (sheet.harness !== "claude-code" || sheet.sessions === 0) return [];
  let full = 0;
  let listed = 0;
  for (const skill of sheet.lines) {
    if (skill.ref.kind !== "skill") continue;
    const bareChars = `- ${skill.ref.name}\n`.length;
    full += skill.exposure.sessions * skill.chars.listed;
    listed +=
      (skill.exposure.sessions - skill.exposure.bare) * skill.chars.listed +
      skill.exposure.bare * Math.min(bareChars, skill.chars.listed);
  }
  if (listed === 0 || full <= listed) return [];
  const fraction = Math.min(
    1,
    Math.ceil(((DEFAULT_BUDGET_FRACTION * full * 1.1) / listed) * 1000) / 1000,
  );
  if (fraction <= DEFAULT_BUDGET_FRACTION) return [];
  // The budget is the machine's setting, so every machine the line holds for gets it, also one
  // where the skill is installed nowhere loadsheet reads, such as a project's or a bundled skill.
  return uniqueFixes(
    line.machines.map((machine) => ({
      machine,
      action: "set",
      path: userSettingsPath(sheet, machine),
      set: { key: "skillListingBudgetFraction", value: fraction },
    })),
  );
};

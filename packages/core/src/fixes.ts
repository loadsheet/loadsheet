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
  hide: (item: Item) => Change;
  /** The skills CLI's `--agent` id for this harness. */
  skillsAgent?: string;
  /** Whether a bare listing is the user's own choice, not the listing's budget. */
  bareByChoice?: (item: Item) => boolean;
}

/** Claude Code's config directory, from the path of something installed in it. */
const claudeConfigDir = (path: string) =>
  /^(.*?)\/(?:skills|commands|agents|plugins)\//u.exec(path)?.[1] ?? "~/.claude";

/** Claude Code's settings file on the machine of an install. */
export const claudeSettingsPath = (item: Item) => `${claudeConfigDir(item.path)}/settings.json`;

const HARNESSES: Record<string, HarnessFixes> = {
  "claude-code": {
    // An installer rewrites the skill's files, so its skills are hidden in settings.json, where
    // `user-invocable-only` keeps `/name`. Claude Code reads no skillOverrides for a plugin's
    // skills, so those, like hand-made ones, get the frontmatter key.
    hide: (item) =>
      item.managedBy === "skills" || item.managedBy === "fleetrc"
        ? {
            action: "hide-from-model",
            path: claudeSettingsPath(item),
            set: { key: `skillOverrides.${item.ref.name}`, value: "user-invocable-only" },
          }
        : {
            action: "hide-from-model",
            path: skillFile(item.path),
            set: { key: "disable-model-invocation", value: true },
          },
    skillsAgent: "claude-code",
    // `skillOverrides: name-only` lists the skill as the bare `- name`, which is all its Item lists.
    bareByChoice: (item) =>
      item.modelInvocable && item.chars.listed === `- ${item.ref.name}\n`.length,
  },
  codex: {
    hide: (item) => ({
      action: "hide-from-model",
      path: `${item.path.endsWith(".md") ? item.path.slice(0, item.path.lastIndexOf("/")) : item.path}/agents/openai.yaml`,
      set: { key: "policy.allow_implicit_invocation", value: false },
    }),
    skillsAgent: "codex",
  },
};

const withMachine = (machine: string, change: Change): Fix => ({ machine, ...change });

/** Each install of a line on the machines it holds for. */
const installsOf = (sheet: RuleSheet, line: Line) => {
  const machines = new Set(line.machines);
  return sheet.installs(line.item).filter((install) => machines.has(install.machine));
};

/** One Fix per distinct machine, action and path. */
export const uniqueFixes = (fixes: Fix[]) => {
  const seen = new Set<string>();
  return fixes.filter((fix) => {
    const key = JSON.stringify([fix.machine, fix.action, fix.path, fix.set?.key]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Keeps a skill from one harness's model on every machine that has it. */
// A hide-from-model Fix needs a key or a command, so a harness loadsheet has no table for gets none.
export const hideFixes = (sheet: RuleSheet, line: Line): Fix[] => {
  const hide = HARNESSES[sheet.harness]?.hide;
  if (!hide) return [];
  return uniqueFixes(
    installsOf(sheet, line).map(({ machine, item }) => withMachine(machine, hide(item))),
  );
};

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
    // fleetrc excludes the skill from its source for every agent and machine it manages.
    case "fleetrc":
      return usedBy.length ? hide() : { ...remove, run: `fleetrc remove ${name}` };
    // A plugin's skills come and go with the plugin.
    case "plugin":
      return hide();
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
  return uniqueFixes(
    installsOf(sheet, line).map(({ machine, item }) => ({
      machine,
      action: "set",
      path: claudeSettingsPath(item),
      set: { key: "skillListingBudgetFraction", value: fraction },
    })),
  );
};

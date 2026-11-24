// Grok (xAI's coding agent CLI, `grok`): what is installed for the user. loadsheet reads none of
// its transcripts, so it declares every usage signal `none`.
//
// Source: the user guide the Grok CLI installs with itself (1.0.92), in `~/.grok/docs/user-guide/`:
// `08-skills.md` (skill and command folders, their order, `[skills]`, bundled skills),
// `12-project-rules.md` (instruction files and rules folders), `07-mcp-servers.md` (MCP sources and
// their order), `05-configuration.md` and `26-config-reference.md` (`GROK_HOME`, the
// `[compat.claude]` and `[compat.cursor]` cells and their `GROK_*_ENABLED` variables).
//
// Left out: plugins (Grok's own and the Claude plugins it reads); their install layout and
// enablement are not established from the guide. `[skills] paths` and `[paths] extra_rule_dirs`
// name folders anywhere, which a source list fixed before config is read cannot follow. Skills a
// managed workspace syncs from its server. How Grok words its skill listing is not documented, so a
// skill's listed size is the plain `- name: description` form.
import { defineHarness, sha256, type Files, type Place } from "@loadsheet/kit";
import type { Item } from "@loadsheet/schema";
import { readCodexConfig, readTomlFlags } from "./codex-toml.ts";
import {
  envDir,
  envFlag,
  findSkills,
  instructionItem,
  instructionName,
  isRecord,
  jsonMcpItems,
  keyOf,
  mcpItem,
  NO_USAGE,
  oneByKey,
  placeOr,
  plainListedChars,
  readJsonc,
  skillItem,
  trimSlash,
  type FoundSkill,
} from "./inventory.ts";
import { readManagers, skillsLockPath } from "./managed.ts";
import { packInventory } from "./pack.ts";
import { readSkillMd, splitFrontmatter } from "./skill-md.ts";

const HARNESS = "grok";

/** The instruction files Grok loads from a folder, every one present, in this order. */
const NAMED_FILES = [
  "Agents.md",
  "Claude.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENT.md",
  "AGENTS.md",
];

/** Cursor's own default skills, which Grok always filters out. The guide names these three. */
const CURSOR_DEFAULTS = new Set(["shell", "canvas", "statusline"]);

/** Grok's home: `GROK_HOME`, else `~/.grok`. */
const grokHome = (place: Place) => envDir(place, "GROK_HOME") ?? `${trimSlash(place.home)}/.grok`;

type Vendor = "claude" | "cursor";
type Cell = "agents" | "rules" | "skills" | "mcps";

/** A `[compat.<vendor>]` cell: its `GROK_<VENDOR>_<CELL>_ENABLED` variable, else config.toml, else on. */
const compat = (
  flags: ReadonlyMap<string, boolean | string[]>,
  place: Place,
  vendor: Vendor,
  cell: Cell,
) => {
  const fromEnv = envFlag(place, `GROK_${vendor.toUpperCase()}_${cell.toUpperCase()}_ENABLED`);
  const fromConfig = flags.get(`compat.${vendor}.${cell}`);
  return fromEnv ?? (typeof fromConfig === "boolean" ? fromConfig : true);
};

const strings = (value: boolean | string[] | undefined) => (Array.isArray(value) ? value : []);

/** The `*.md` files directly in a commands folder, each a skill named after its file, as Claude Code names a command. */
const commandSkills = async (files: Files, dir: string): Promise<FoundSkill[]> => {
  const managers = await readManagers(files, dir);
  const found: FoundSkill[] = [];
  for (const file of files.paths) {
    if (!file.startsWith(`${dir}/`)) continue;
    const rest = file.slice(dir.length + 1);
    if (rest.includes("/") || rest.startsWith(".") || !rest.endsWith(".md")) continue;
    const source = await files.text(file);
    if (source === undefined) continue;
    const name = rest.slice(0, -3);
    const skill = readSkillMd(source);
    found.push({ file, path: file, folder: name, name, source, skill, manager: managers(name) });
  }
  return found;
};

/** The name Grok dedupes a skill by: spaces and underscores become hyphens. */
const grokName = (found: FoundSkill) => found.name.replace(/[\s_]+/gu, "-");

/** What Grok lists for a skill: its description, or the first paragraph of its body without one. */
const grokDescription = (found: FoundSkill) => {
  if (found.skill.description) return found.skill.description;
  const paragraph = splitFrontmatter(found.source)
    .body.trim()
    .split(/\n\s*\n/u)[0];
  return paragraph?.split(/\s+/u).filter(Boolean).join(" ") || undefined;
};

const machineInventory = async (files: Files, given?: Place): Promise<Item[]> => {
  const place = placeOr(given);
  const home = keyOf(grokHome(place), place);
  const user = (path: string) => keyOf(`${trimSlash(place.home)}/${path}`, place);
  const configPath = `${home}/config.toml`;
  const configText = (await files.text(configPath)) ?? "";
  const flags = readTomlFlags(configText);
  const on = (vendor: Vendor, cell: Cell) => compat(flags, place, vendor, cell);

  // Skills: Grok's home, `~/.agents`, then Claude's and Cursor's folders, then the bundled ones.
  // The first of a name wins, and a folder's `skills/` wins over its `commands/`.
  const folders = [
    home,
    user(".agents"),
    ...(on("claude", "skills") ? [user(".claude")] : []),
    ...(on("cursor", "skills") ? [user(".cursor")] : []),
  ];
  const found: FoundSkill[] = [];
  for (const folder of folders) {
    const skills = await findSkills(files, { dir: `${folder}/skills`, depth: Infinity });
    found.push(
      ...(folder === user(".cursor")
        ? skills.filter((skill) => !CURSOR_DEFAULTS.has(skill.name))
        : skills),
      ...(await commandSkills(files, `${folder}/commands`)),
    );
  }
  found.push(...(await findSkills(files, { dir: `${home}/bundled/skills`, depth: Infinity })));

  // `[skills] ignore` hides a skill entirely; `[skills] disabled` keeps it out of the prompt.
  const ignored = strings(flags.get("skills.ignore")).map((path) =>
    path.startsWith("~/") ? path : keyOf(trimSlash(path), place),
  );
  const disabled = new Set(strings(flags.get("skills.disabled")));
  const visible = found.filter(
    (skill) =>
      !ignored.some(
        (path) => skill.path === path || skill.file === path || skill.path.startsWith(`${path}/`),
      ),
  );
  const items: Item[] = [];
  for (const skill of oneByKey(visible, grokName, "first")) {
    const off =
      disabled.has(skill.name) ||
      disabled.has(grokName(skill)) ||
      skill.skill.disableModelInvocation;
    const listed = off ? 0 : plainListedChars(grokName(skill), grokDescription(skill));
    items.push(await skillItem(HARNESS, skill, { listed, modelInvocable: !off }));
  }

  // Instructions: the named files and `rules/*.md` of Grok's home, then of `~/.claude` and
  // `~/.cursor` as their cells allow.
  const instructionFolders = [
    { dir: home, display: "~/.grok", named: true, rules: true },
    {
      dir: user(".claude"),
      display: "~/.claude",
      named: on("claude", "agents"),
      rules: on("claude", "rules"),
    },
    {
      dir: user(".cursor"),
      display: "~/.cursor",
      named: on("cursor", "agents"),
      rules: on("cursor", "rules"),
    },
  ];
  for (const { dir, display, named, rules } of instructionFolders) {
    const paths = [
      ...(named ? NAMED_FILES.map((name) => `${dir}/${name}`) : []),
      ...(rules
        ? files.paths.filter((path) => {
            const rest = path.startsWith(`${dir}/rules/`) ? path.slice(dir.length + 7) : "";
            return rest.endsWith(".md") && !rest.includes("/");
          })
        : []),
    ];
    for (const path of paths) {
      const source = await files.text(path);
      if (source === undefined) continue;
      const name = instructionName(`${display}${path.slice(dir.length)}`);
      items.push(await instructionItem(HARNESS, { name, path, source }));
    }
  }

  // MCP servers: config.toml, then `~/.claude.json`, then `~/.cursor/mcp.json`; a name once.
  const off = new Set(strings(flags.get("disabled_mcp_servers")));
  const seen = new Set<string>();
  const keep = (name: string) => {
    if (off.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  };
  const configDigest = await sha256(configText);
  for (const [server, enabled] of readCodexConfig(configText).mcpServers) {
    if (!enabled) {
      seen.add(server);
      continue;
    }
    if (keep(server)) items.push(mcpItem(HARNESS, server, configPath, configDigest));
  }
  for (const [vendor, path] of [
    ["claude", user(".claude.json")],
    ["cursor", user(".cursor/mcp.json")],
  ] as const) {
    if (!on(vendor, "mcps")) continue;
    const servers = (await readJsonc(files, path)).mcpServers;
    if (isRecord(servers)) items.push(...(await jsonMcpItems(HARNESS, servers, path, keep)));
  }
  return items;
};

/** Grok: what it has installed for the user; inventory only. */
export const grok = defineHarness({
  id: HARNESS,
  signals: NO_USAGE,
  inventory: (files: Files) =>
    packInventory(files, {
      harness: HARNESS,
      description: (skill) => skill.description,
      listedChars: (name, skill) => plainListedChars(name, skill.description),
    }),
  machine: {
    home: grokHome,
    sources: (place) => {
      const home = grokHome(place);
      const user = trimSlash(place.home);
      const folders = (dir: string) => [
        `${dir}/skills`,
        `${dir}/commands`,
        `${dir}/rules`,
        ...NAMED_FILES.map((name) => `${dir}/${name}`),
      ];
      return [
        ...folders(home),
        `${home}/bundled/skills`,
        `${home}/config.toml`,
        `${user}/.agents/skills`,
        `${user}/.agents/commands`,
        ...folders(`${user}/.claude`),
        ...folders(`${user}/.cursor`),
        `${user}/.claude.json`,
        `${user}/.cursor/mcp.json`,
        skillsLockPath(user, place.env),
      ];
    },
    inventory: machineInventory,
  },
});

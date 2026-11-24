// OpenCode (`opencode`): what is installed for the user. loadsheet reads none of its sessions, so
// it declares every usage signal `none`.
//
// Source: https://github.com/anomalyco/opencode (branch `dev`), the docs in
// `services/site/src/docs/content/`: `config.mdx` (where config lives), `skills.mdx` (skill sources,
// their order, ids, `opencode/autoinvoke`), `instructions.mdx` (the global AGENTS.md and its
// CLAUDE.md fallback), `mcp-servers.mdx` and `migrate-v1.mdx` (V2 `mcp.servers` and V1 `mcp`), and
// `packages/util/src/global-roots.ts` (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`).
//
// Left out: plugins (`<config>/plugins/`), which are JavaScript code rather than context loadsheet
// tracks; the folders and files the config's `skills` and `instructions` arrays add, which a
// source list fixed before config is read cannot follow; built-in skills. OpenCode's skill listing
// holds each skill's id, name and description; its exact wording is not documented, so a skill's
// listed size is the plain `- name: description` form.
import { defineHarness, type Files, type Place } from "@loadsheet/kit";
import type { Item } from "@loadsheet/schema";
import {
  envDir,
  envFlag,
  findSkills,
  instructionItem,
  instructionName,
  isRecord,
  jsonMcpItems,
  keyOf,
  NO_USAGE,
  oneByKey,
  placeOr,
  plainListedChars,
  readJsonc,
  skillItem,
  trimSlash,
  type FoundSkill,
} from "./inventory.ts";
import { skillsLockPath } from "./managed.ts";
import { packInventory } from "./pack.ts";
import { splitFrontmatter } from "./skill-md.ts";

const HARNESS = "opencode";

/** How deep OpenCode searches a skill source: six folders below it. */
const DEPTH = 6;
const CONFIG_FILES = ["opencode.json", "opencode.jsonc"];

/** OpenCode's config folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
const configDir = (place: Place) =>
  `${envDir(place, "XDG_CONFIG_HOME") ?? `${trimSlash(place.home)}/.config`}/opencode`;

/** Whether the skill sets `metadata.opencode/autoinvoke: false`, which keeps it out of the listing. */
const autoinvokeOff = (found: FoundSkill) => {
  const metadata = splitFrontmatter(found.source).data.metadata;
  return isRecord(metadata) && metadata["opencode/autoinvoke"] === false;
};

/** A config file's MCP servers: V2's `mcp.servers` but those `disabled`, and V1's `mcp.<name>` but those not `enabled`. */
const mcpServers = async (files: Files, path: string): Promise<Item[]> => {
  const mcp = (await readJsonc(files, path)).mcp;
  if (!isRecord(mcp)) return [];
  const items = await jsonMcpItems(
    HARNESS,
    mcp.servers,
    path,
    (_name, config) => !isRecord(config) || config.disabled !== true,
  );
  const v1 = Object.fromEntries(
    Object.entries(mcp).filter(
      ([name, config]) =>
        name !== "servers" &&
        isRecord(config) &&
        ("type" in config || "command" in config || "url" in config),
    ),
  );
  items.push(
    ...(await jsonMcpItems(
      HARNESS,
      v1,
      path,
      (_name, config) => !isRecord(config) || config.enabled !== false,
    )),
  );
  return items;
};

const machineInventory = async (files: Files, given?: Place): Promise<Item[]> => {
  const place = placeOr(given);
  const config = keyOf(configDir(place), place);
  const user = (path: string) => keyOf(`${trimSlash(place.home)}/${path}`, place);
  const noClaudeSkills = envFlag(place, "OPENCODE_DISABLE_CLAUDE_CODE") === true;
  const noClaudePrompt =
    noClaudeSkills || envFlag(place, "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT") === true;
  const items: Item[] = [];

  // Skills, lowest precedence first: `~/.claude/skills`, `~/.agents/skills`, the config folder's.
  // A skill's id is its folder or file name, and a later source's skill of an id replaces it.
  const found: FoundSkill[] = [];
  for (const dir of [
    ...(noClaudeSkills ? [] : [user(".claude/skills")]),
    user(".agents/skills"),
    `${config}/skills`,
  ]) {
    found.push(...(await findSkills(files, { dir, depth: DEPTH, flat: true })));
  }
  for (const skill of oneByKey(found, (entry) => entry.folder, "last")) {
    // Listed: a skill with a description that does not opt out of the list.
    const description = skill.skill.description;
    const optedOut = autoinvokeOff(skill) || skill.skill.disableModelInvocation;
    const listed = description && !optedOut ? plainListedChars(skill.folder, description) : 0;
    items.push(await skillItem(HARNESS, skill, { listed, modelInvocable: listed > 0 }));
  }

  // Instructions: the config folder's AGENTS.md, or without one `~/.claude/CLAUDE.md`.
  const agents = `${config}/AGENTS.md`;
  const claude = user(".claude/CLAUDE.md");
  for (const [path, name] of [
    [agents, "~/.config/opencode/AGENTS.md"],
    [claude, instructionName(claude)],
  ] as const) {
    if (path === claude && (noClaudePrompt || files.paths.includes(agents))) continue;
    const source = await files.text(path);
    if (source !== undefined) items.push(await instructionItem(HARNESS, { name, path, source }));
  }

  for (const name of CONFIG_FILES) items.push(...(await mcpServers(files, `${config}/${name}`)));
  return items;
};

/** OpenCode: what it has installed for the user; inventory only. */
export const opencode = defineHarness({
  id: HARNESS,
  signals: NO_USAGE,
  inventory: (files: Files) =>
    packInventory(files, {
      harness: HARNESS,
      description: (skill) => skill.description,
      listedChars: (name, skill) => plainListedChars(name, skill.description),
    }),
  machine: {
    home: configDir,
    sources: (place) => {
      const config = configDir(place);
      const home = trimSlash(place.home);
      return [
        `${home}/.claude/skills`,
        `${home}/.agents/skills`,
        `${config}/skills`,
        `${config}/AGENTS.md`,
        `${home}/.claude/CLAUDE.md`,
        ...CONFIG_FILES.map((name) => `${config}/${name}`),
        skillsLockPath(home, place.env),
      ];
    },
    inventory: machineInventory,
  },
});

// Pi (the pi coding agent, `pi`): what is installed for the user. loadsheet reads none of its
// transcripts, so it declares every usage signal `none`.
//
// Source: https://github.com/earendil-works/pi, `packages/coding-agent/docs/configuration.md`,
// `docs/skills.md` and `docs/mcp.md`, and `packages/coding-agent/src/config.ts` (`getAgentDir`,
// `PI_CODING_AGENT_DIR`), `src/core/skills.ts` (`loadSkillsFromDir`, `formatSkillsForPrompt`) and
// `src/core/resource-loader.ts` (`loadContextFileFromDir`, `SYSTEM.md`, `APPEND_SYSTEM.md`).
//
// Left out: extensions (`<agent dir>/extensions/`), which are TypeScript code rather than context
// loadsheet tracks; packages declared in `settings.json`, whose install location is not
// established; and the skill paths and overrides `settings.json` can add. Pi also counts a loose
// `.md` file below the top of `~/.agents/skills` as a skill; loadsheet counts SKILL.md folders there.
import { defineHarness, type Files, type Place } from "@loadsheet/kit";
import type { Item } from "@loadsheet/schema";
import {
  absoluteOf,
  baseOf,
  envDir,
  findSkills,
  instructionItem,
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
  xmlListedChars,
  type FoundSkill,
} from "./inventory.ts";
import { skillsLockPath } from "./managed.ts";
import { packInventory } from "./pack.ts";

const HARNESS = "pi";

/** The agent folder's context file: the first of these that exists. */
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** Files that replace and extend Pi's system prompt, each loaded when present. */
const SYSTEM_FILES = ["SYSTEM.md", "APPEND_SYSTEM.md"];

/** Pi's agent folder: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
const agentDir = (place: Place) =>
  envDir(place, "PI_CODING_AGENT_DIR") ?? `${trimSlash(place.home)}/.pi/agent`;

/** Pi's name for a skill: its frontmatter name, else the name of the folder that holds the file. */
const piName = (found: FoundSkill) =>
  found.skill.name ?? baseOf(found.file.slice(0, found.file.lastIndexOf("/")));

const machineInventory = async (files: Files, given?: Place): Promise<Item[]> => {
  const place = placeOr(given);
  const dir = keyOf(agentDir(place), place);
  const items: Item[] = [];

  // Skills: the agent folder's (its top-level `.md` files too), then `~/.agents/skills`. A skill
  // without a description does not load, and the first of a name wins.
  const found = [
    ...(await findSkills(files, { dir: `${dir}/skills`, depth: Infinity, flat: true })),
    ...(await findSkills(files, {
      dir: keyOf(`${trimSlash(place.home)}/.agents/skills`, place),
      depth: Infinity,
    })),
  ].filter((skill) => skill.skill.description !== undefined);
  for (const skill of oneByKey(found, piName, "first")) {
    const hidden = skill.skill.disableModelInvocation;
    const listed = hidden
      ? 0
      : xmlListedChars(
          piName(skill),
          skill.skill.description!,
          absoluteOf(skill.file, place),
          true,
        );
    items.push(await skillItem(HARNESS, skill, { listed, modelInvocable: !hidden }));
  }

  // Instructions: the first context file, then SYSTEM.md and APPEND_SYSTEM.md.
  const context = CONTEXT_FILES.map((name) => `${dir}/${name}`).find((path) =>
    files.paths.includes(path),
  );
  for (const path of [
    ...(context ? [context] : []),
    ...SYSTEM_FILES.map((name) => `${dir}/${name}`),
  ]) {
    const source = await files.text(path);
    if (source === undefined) continue;
    const name = `~/.pi/agent/${baseOf(path)}`;
    items.push(await instructionItem(HARNESS, { name, path, source }));
  }

  // MCP servers: `mcp.json`'s `mcpServers`, but those set `enabled: false`.
  const mcpPath = `${dir}/mcp.json`;
  const servers = (await readJsonc(files, mcpPath)).mcpServers;
  items.push(
    ...(await jsonMcpItems(
      HARNESS,
      servers,
      mcpPath,
      (_name, config) => !isRecord(config) || config.enabled !== false,
    )),
  );
  return items;
};

/** Pi: what it has installed for the user; inventory only. */
export const pi = defineHarness({
  id: HARNESS,
  signals: NO_USAGE,
  inventory: (files: Files) =>
    packInventory(files, {
      harness: HARNESS,
      description: (skill) => skill.description,
      listedChars: (name, skill) => plainListedChars(name, skill.description),
    }),
  machine: {
    home: agentDir,
    sources: (place) => {
      const dir = agentDir(place);
      const home = trimSlash(place.home);
      return [
        `${dir}/skills`,
        `${home}/.agents/skills`,
        ...[...CONTEXT_FILES, ...SYSTEM_FILES].map((name) => `${dir}/${name}`),
        `${dir}/mcp.json`,
        skillsLockPath(home, place.env),
      ];
    },
    inventory: machineInventory,
  },
});

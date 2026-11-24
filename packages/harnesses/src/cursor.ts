// Cursor (its agent in the editor and the `cursor-agent` CLI): what is installed for the user.
// loadsheet reads none of its transcripts, so it declares every usage signal `none`.
//
// Source: Cursor's docs, https://cursor.com/docs/context/skills (skill folders, nested folders,
// `disable-model-invocation`), https://cursor.com/docs/context/mcp (`~/.cursor/mcp.json`),
// https://cursor.com/docs/context/rules (User Rules), https://cursor.com/docs/cli/using and
// https://cursor.com/docs/cli/reference/configuration (`CURSOR_CONFIG_DIR` moves only the CLI's
// `cli-config.json`, so `~/.cursor` does not move).
//
// Left out: global instructions, since User Rules live in Cursor's settings rather than in a file
// and AGENTS.md and CLAUDE.md are read in projects only; plugins and commands, whose locations on
// the machine are not established from the docs. Cursor keeps a server's on/off switch in its
// settings, not in `mcp.json`, so every server the file names counts. The docs do not say how
// Cursor words its skill listing or which of two same-named skills wins, so a skill's listed size
// is the plain `- name: description` form and every folder counts.
import { defineHarness, type Files, type Place } from "@loadsheet/kit";
import type { Item } from "@loadsheet/schema";
import {
  findSkills,
  jsonMcpItems,
  keyOf,
  NO_USAGE,
  placeOr,
  plainListedChars,
  readJsonc,
  skillItem,
  trimSlash,
} from "./inventory.ts";
import { skillsLockPath } from "./managed.ts";
import { packInventory } from "./pack.ts";

const HARNESS = "cursor";

/** The user skill folders Cursor reads: its own, `~/.agents`'s, and Claude's and Codex's for compatibility. */
const SKILL_FOLDERS = [".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills"];

const cursorHome = (place: Place) => `${trimSlash(place.home)}/.cursor`;

const machineInventory = async (files: Files, given?: Place): Promise<Item[]> => {
  const place = placeOr(given);
  const user = (path: string) => keyOf(`${trimSlash(place.home)}/${path}`, place);
  const items: Item[] = [];
  for (const folder of SKILL_FOLDERS) {
    for (const skill of await findSkills(files, { dir: user(folder), depth: Infinity })) {
      const hidden = skill.skill.disableModelInvocation;
      // Cursor names a skill after the folder that holds its SKILL.md.
      const listed = hidden ? 0 : plainListedChars(skill.folder, skill.skill.description);
      items.push(await skillItem(HARNESS, skill, { listed, modelInvocable: !hidden }));
    }
  }
  const mcpPath = user(".cursor/mcp.json");
  items.push(
    ...(await jsonMcpItems(HARNESS, (await readJsonc(files, mcpPath)).mcpServers, mcpPath)),
  );
  return items;
};

/** Cursor: what it has installed for the user; inventory only. */
export const cursor = defineHarness({
  id: HARNESS,
  signals: NO_USAGE,
  inventory: (files: Files) =>
    packInventory(files, {
      harness: HARNESS,
      description: (skill) => skill.description,
      listedChars: (name, skill) => plainListedChars(name, skill.description),
    }),
  machine: {
    home: cursorHome,
    sources: (place) => {
      const home = trimSlash(place.home);
      return [
        ...SKILL_FOLDERS.map((folder) => `${home}/${folder}`),
        `${home}/.cursor/mcp.json`,
        skillsLockPath(home, place.env),
      ];
    },
    inventory: machineInventory,
  },
});

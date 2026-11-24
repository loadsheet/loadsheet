// Kiro (the Kiro IDE's agent and `kiro-cli`): what is installed for the user. loadsheet reads none
// of its sessions, so it declares every usage signal `none`.
//
// Source: Kiro's docs, https://kiro.dev/docs/steering/ (`~/.kiro/steering/`, the `inclusion` modes
// `always`, `fileMatch`, `manual` and `auto`, AGENTS.md always included),
// https://kiro.dev/docs/skills/ (`~/.kiro/skills/<name>/SKILL.md`, a name matching its folder and
// a description required) and https://kiro.dev/docs/mcp/configuration/ (`~/.kiro/settings/mcp.json`,
// `disabled`).
//
// Left out: powers, which bundle steering, MCP servers and hooks under a layout the docs do not
// pin down for the machine; custom CLI agents (`~/.kiro/agents`), which choose their own resources.
// How Kiro words its skill listing and an `auto` steering file's entry is not documented, so each
// listed size is the plain `- name: description` form.
import { defineHarness, type Files, type Place } from "@loadsheet/kit";
import type { Item } from "@loadsheet/schema";
import {
  findSkills,
  instructionItem,
  isRecord,
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
import { splitFrontmatter } from "./skill-md.ts";

const HARNESS = "kiro";

const kiroHome = (place: Place) => `${trimSlash(place.home)}/.kiro`;

/** What a steering file costs by its `inclusion`: `always` (the default) every session, `auto` its entry, the others only when they load. */
const steeringChars = (file: string, source: string) => {
  const { data, body } = splitFrontmatter(source);
  const inclusion = file.endsWith("/AGENTS.md") ? "always" : (data.inclusion ?? "always");
  if (inclusion === "always")
    return { chars: { listed: source.length, body: 0 }, modelInvocable: true };
  if (inclusion === "auto") {
    const name =
      typeof data.name === "string" ? data.name : file.slice(file.lastIndexOf("/") + 1, -3);
    const description = typeof data.description === "string" ? data.description : undefined;
    return {
      chars: { listed: plainListedChars(name, description), body: body.length },
      modelInvocable: true,
    };
  }
  // `fileMatch` loads when a matching file is in play; `manual` only when the user names it.
  return { chars: { listed: 0, body: body.length }, modelInvocable: inclusion !== "manual" };
};

const machineInventory = async (files: Files, given?: Place): Promise<Item[]> => {
  const place = placeOr(given);
  const home = keyOf(kiroHome(place), place);
  const items: Item[] = [];

  // Skills: a folder whose SKILL.md names it and describes it; Kiro skips any other.
  for (const skill of await findSkills(files, { dir: `${home}/skills`, depth: 1 })) {
    if (skill.skill.name !== skill.folder || !skill.skill.description) continue;
    const hidden = skill.skill.disableModelInvocation;
    const listed = hidden ? 0 : plainListedChars(skill.folder, skill.skill.description);
    items.push(await skillItem(HARNESS, skill, { listed, modelInvocable: !hidden }));
  }

  // Steering: the `.md` files directly in `~/.kiro/steering`.
  const steering = `${home}/steering/`;
  for (const path of files.paths) {
    const rest = path.startsWith(steering) ? path.slice(steering.length) : "";
    if (!rest.endsWith(".md") || rest.includes("/") || rest.startsWith(".")) continue;
    const source = await files.text(path);
    if (source === undefined) continue;
    const { chars, modelInvocable } = steeringChars(path, source);
    const name = `~/.kiro/steering/${rest}`;
    items.push(await instructionItem(HARNESS, { name, path, source }, chars, modelInvocable));
  }

  // MCP servers: `settings/mcp.json`'s, but those set `disabled: true`.
  const mcpPath = `${home}/settings/mcp.json`;
  items.push(
    ...(await jsonMcpItems(
      HARNESS,
      (await readJsonc(files, mcpPath)).mcpServers,
      mcpPath,
      (_name, config) => !isRecord(config) || config.disabled !== true,
    )),
  );
  return items;
};

/** Kiro: what it has installed for the user; inventory only. */
export const kiro = defineHarness({
  id: HARNESS,
  signals: NO_USAGE,
  inventory: (files: Files) =>
    packInventory(files, {
      harness: HARNESS,
      description: (skill) => skill.description,
      listedChars: (name, skill) => plainListedChars(name, skill.description),
    }),
  machine: {
    home: kiroHome,
    sources: (place) => {
      const home = kiroHome(place);
      return [
        `${home}/skills`,
        `${home}/steering`,
        `${home}/settings/mcp.json`,
        skillsLockPath(trimSlash(place.home), place.env),
      ];
    },
    inventory: machineInventory,
  },
});

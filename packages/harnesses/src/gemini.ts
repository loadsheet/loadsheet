// Gemini CLI (`gemini`): what is installed for the user. loadsheet reads none of its transcripts,
// so it declares every usage signal `none`.
//
// Source: https://github.com/google-gemini/gemini-cli, `docs/cli/skills.md`,
// `docs/cli/gemini-md.md`, `docs/extensions/reference.md`, `docs/tools/mcp-server.md` and
// `docs/reference/configuration.md` (`skills.*`, `context.fileName`, `mcp.allowed`,
// `mcp.excluded`), and `packages/core/src/utils/paths.ts` (`GEMINI_CLI_HOME` replaces the home
// folder), `src/config/storage.ts` (`~/.gemini`, `~/.agents/skills`), `src/skills/skillLoader.ts`
// (`SKILL.md` and `*/SKILL.md`, a name and a description required, the name's sanitizing),
// `src/skills/skillManager.ts` (extensions, then `~/.gemini/skills`, then `~/.agents/skills`, a
// later skill of a name winning), `src/prompts/snippets.ts` (`renderAgentSkills`) and
// `packages/cli/src/config/extensions/extensionEnablement.ts` (`extension-enablement.json`).
//
// Left out: custom commands (`~/.gemini/commands/*.toml`), which only the user runs and the model
// is not shown; subagents (`~/.gemini/agents`), whose loading is not established here; built-in
// skills. Global context files are read under the names `GEMINI.md` and `AGENTS.md`: a
// `context.fileName` naming any other file is not followed, since the source list is fixed before
// settings are read. An extension is judged enabled or not for the home folder, as loadsheet has
// no working folder.
import { defineHarness, type Files, type Place } from "@loadsheet/kit";
import type { Item } from "@loadsheet/schema";
import {
  absoluteOf,
  envDir,
  findSkills,
  instructionItem,
  isRecord,
  jsonMcpItems,
  keyOf,
  mcpConfigDigest,
  mcpItem,
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

const HARNESS = "gemini";

/** The global context file names loadsheet reads: Gemini's default and the one its docs suggest beside it. */
const CONTEXT_FILES = ["GEMINI.md", "AGENTS.md"];
const EXTENSION_MANIFEST = "gemini-extension.json";

/** The folder Gemini CLI takes for home: `GEMINI_CLI_HOME`, else the user's home. */
const geminiBase = (place: Place) => envDir(place, "GEMINI_CLI_HOME") ?? trimSlash(place.home);
const geminiHome = (place: Place) => `${geminiBase(place)}/.gemini`;

/** Gemini's name for a skill: its frontmatter name with `:\/<>*?"|` made `-`. */
const geminiName = (found: FoundSkill) => found.skill.name!.replace(/[:\\/<>*?"|]/gu, "-");

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Whether `extension-enablement.json` leaves an extension on in `folder`: the last rule that matches it decides. */
const enabledIn = (enablement: Record<string, unknown>, name: string, folder: string) => {
  const entry = enablement[name];
  const path = `/${folder.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "")}/`;
  let enabled = true;
  for (const rule of isRecord(entry) ? strings(entry.overrides) : []) {
    const disable = rule.startsWith("!");
    let base = disable ? rule.slice(1) : rule;
    const subfolders = base.endsWith("*");
    if (subfolders) base = base.slice(0, -1);
    base = base.replace(/\\/gu, "/");
    if (!base.startsWith("/")) base = `/${base}`;
    if (!base.endsWith("/")) base = `${base}/`;
    const pattern = `${base}${subfolders ? "*" : ""}`
      .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/(\/?)\*/gu, "($1.*)?");
    if (new RegExp(`^${pattern}$`, "u").test(path)) enabled = !disable;
  }
  return enabled;
};

interface Extension {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
}

/** The extensions installed under `~/.gemini/extensions` and enabled for the home folder. */
const extensions = async (files: Files, home: string, place: Place): Promise<Extension[]> => {
  const root = `${home}/extensions`;
  const enablement = await readJsonc(files, `${root}/extension-enablement.json`);
  const found: Extension[] = [];
  for (const path of files.paths) {
    if (!path.startsWith(`${root}/`) || !path.endsWith(`/${EXTENSION_MANIFEST}`)) continue;
    const dir = path.slice(0, -EXTENSION_MANIFEST.length - 1);
    if (dir.slice(root.length + 1).includes("/")) continue;
    const manifest = await readJsonc(files, path);
    const name = typeof manifest.name === "string" && manifest.name ? manifest.name : undefined;
    if (name && enabledIn(enablement, name, trimSlash(place.home)))
      found.push({ name, dir, manifest });
  }
  return found;
};

const machineInventory = async (files: Files, given?: Place): Promise<Item[]> => {
  const place = placeOr(given);
  const home = keyOf(geminiHome(place), place);
  const settings = await readJsonc(files, `${home}/settings.json`);
  const installed = await extensions(files, home, place);
  const items: Item[] = [];

  // Skills, lowest precedence first: each extension's, `~/.gemini/skills`, `~/.agents/skills`.
  // One without a name or description does not load, and a later skill of a name replaces it.
  const found: { skill: FoundSkill; extension?: Extension }[] = [];
  const add = async (dir: string, extension?: Extension) => {
    for (const skill of await findSkills(files, { dir, depth: 1, self: true })) {
      if (skill.skill.name && skill.skill.description)
        found.push({ skill, ...(extension ? { extension } : {}) });
    }
  };
  for (const extension of installed) await add(`${extension.dir}/skills`, extension);
  await add(`${home}/skills`);
  await add(keyOf(`${geminiBase(place)}/.agents/skills`, place));
  const skillSettings = isRecord(settings.skills) ? settings.skills : {};
  const skillsOff = skillSettings.enabled === false;
  const disabled = new Set(strings(skillSettings.disabled).map((name) => name.toLowerCase()));
  for (const { skill, extension } of oneByKey(found, (entry) => geminiName(entry.skill), "last")) {
    const name = geminiName(skill);
    const off = skillsOff || disabled.has(name.toLowerCase());
    const listed = off
      ? 0
      : xmlListedChars(name, skill.skill.description!, absoluteOf(skill.file, place), false);
    const owner = extension ? { scope: "plugin" as const, pack: extension.name } : undefined;
    items.push(await skillItem(HARNESS, skill, { listed, modelInvocable: !off }, owner));
  }

  // Context: the global files `context.fileName` names (default GEMINI.md), then each
  // extension's `contextFileName`, or its GEMINI.md when it names none.
  const context = isRecord(settings.context) ? settings.context.fileName : undefined;
  const names = typeof context === "string" ? [context] : strings(context);
  for (const name of names.length > 0 ? names : ["GEMINI.md"]) {
    if (!CONTEXT_FILES.includes(name)) continue;
    const path = `${home}/${name}`;
    const source = await files.text(path);
    if (source === undefined) continue;
    items.push(await instructionItem(HARNESS, { name: `~/.gemini/${name}`, path, source }));
  }
  for (const extension of installed) {
    const declared = extension.manifest.contextFileName;
    const fileNames = typeof declared === "string" ? [declared] : strings(declared);
    for (const name of fileNames.length > 0 ? fileNames : ["GEMINI.md"]) {
      const path = `${extension.dir}/${name}`;
      const source = await files.text(path);
      if (source === undefined) continue;
      items.push(
        await instructionItem(HARNESS, {
          name: `${extension.name}:${name}`,
          path,
          source,
          scope: "plugin",
          pack: extension.name,
        }),
      );
    }
  }

  // MCP servers: settings.json's, then each extension's of a name settings does not define, kept
  // by `mcp.allowed` when set and dropped by `mcp.excluded`.
  const mcp = isRecord(settings.mcp) ? settings.mcp : {};
  const allowed = Array.isArray(mcp.allowed) ? new Set(strings(mcp.allowed)) : undefined;
  const excluded = new Set(strings(mcp.excluded));
  const userServers = isRecord(settings.mcpServers) ? settings.mcpServers : {};
  const keep = (name: string) =>
    (allowed === undefined || allowed.has(name)) && !excluded.has(name);
  items.push(...(await jsonMcpItems(HARNESS, userServers, `${home}/settings.json`, keep)));
  const seen = new Set(Object.keys(userServers));
  for (const extension of installed) {
    const servers = extension.manifest.mcpServers;
    if (!isRecord(servers)) continue;
    for (const [server, config] of Object.entries(servers)) {
      if (seen.has(server) || !keep(server)) continue;
      seen.add(server);
      const path = `${extension.dir}/${EXTENSION_MANIFEST}`;
      const owner = { scope: "plugin" as const, pack: extension.name };
      items.push(mcpItem(HARNESS, server, path, await mcpConfigDigest(config), owner));
    }
  }
  return items;
};

/** Gemini CLI: what it has installed for the user; inventory only. */
export const gemini = defineHarness({
  id: HARNESS,
  signals: NO_USAGE,
  inventory: (files: Files) =>
    packInventory(files, {
      harness: HARNESS,
      description: (skill) => skill.description,
      listedChars: (name, skill) => plainListedChars(name, skill.description),
    }),
  machine: {
    home: geminiHome,
    sources: (place) => {
      const home = geminiHome(place);
      return [
        `${home}/skills`,
        `${geminiBase(place)}/.agents/skills`,
        `${home}/settings.json`,
        ...CONTEXT_FILES.map((name) => `${home}/${name}`),
        `${home}/extensions`,
        skillsLockPath(trimSlash(place.home), place.env),
      ];
    },
    inventory: machineInventory,
  },
});

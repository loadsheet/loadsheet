import { defineHarness, sha256, type Files, type Place } from "@loadsheet/kit";
import type { Item } from "@loadsheet/schema";
import { parse } from "tinyaml";
import { readCodexConfig, type SkillRule } from "./codex-toml.ts";
import { CODEX_INSTRUCTIONS, codexTranscripts } from "./codex-transcripts.ts";
import { readManagers, skillsLockPath, type Manager } from "./managed.ts";
import { readSkillMd, type SkillMd } from "./skill-md.ts";

/** Codex cuts a listed description to this many characters, the last three being `...`. */
const DESCRIPTION_CAP = 1024;

const PLUGIN_MANIFESTS = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const singleLine = (text: string) => text.split(/\s+/u).filter(Boolean).join(" ");

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const yaml = (source: string): Record<string, unknown> => {
  try {
    return record(parse(source)) ?? {};
  } catch {
    return {};
  }
};

/**
 * What Codex lists for a skill: its description on one line, cut to 1,024 characters. A skill
 * without one fails to load. (Codex's extension-style listing prefers `metadata.short-description`;
 * the sessions read list the description, so that is what is counted.)
 */
export const codexDescription = (skill: SkillMd): string | undefined => {
  const text = singleLine(skill.description ?? "");
  // Codex counts Unicode scalar values, as Rust `chars()` does.
  const points = Array.from(text);
  return points.length > DESCRIPTION_CAP
    ? `${points.slice(0, DESCRIPTION_CAP - 3).join("")}...`
    : text || undefined;
};

/**
 * Characters Codex's skills section spends on one skill when it keeps the whole description: the
 * line `- name: description (file: rN/<path>)` and its newline. Codex shortens descriptions when
 * the section passes its budget (2% of the context window), so a session can list fewer.
 */
export const codexListedChars = (name: string, description: string, locator: string): number =>
  `- ${name}: ${description} (file: ${locator})\n`.length;

/** Whether `agents/openai.yaml` beside a SKILL.md keeps it from the model (`allow_implicit_invocation: false`). */
const hiddenByPolicy = (source: string | undefined): boolean => {
  if (source === undefined) return false;
  return record(yaml(source).policy)?.allow_implicit_invocation === false;
};

const readManifest = (manifest: string | undefined): Record<string, unknown> | undefined => {
  if (manifest === undefined) return undefined;
  try {
    return record(JSON.parse(manifest));
  } catch {
    return undefined;
  }
};

const pluginName = (manifest: Record<string, unknown> | undefined): string | undefined => {
  const name = manifest?.name;
  return typeof name === "string" && name ? name : undefined;
};

/**
 * The skill roots a plugin manifest declares in `skills`, a path or a list of them, relative to the
 * plugin's folder. Codex keeps a path that starts with `./`, is not `./` and has no `..`, and falls
 * back to `skills/` when none is kept.
 */
const pluginSkillRoots = (manifest: Record<string, unknown> | undefined): string[] => {
  const declared = manifest?.skills;
  const paths = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
  const roots = paths.flatMap((path) => {
    if (typeof path !== "string" || !path.startsWith("./")) return [];
    const segments = path.slice(2).split("/");
    if (segments.includes("..")) return [];
    const root = segments.filter((segment) => segment && segment !== ".").join("/");
    return root ? [root] : [];
  });
  return roots.length > 0 ? [...new Set(roots)] : ["skills"];
};

interface SkillEntry {
  /** The SKILL.md key in Files. */
  file: string;
  /** The skill root the listing aliases, such as `~/.agents/skills`. */
  root: string;
  plugin?: string;
}

const skillItem = async (
  files: Files,
  entry: SkillEntry,
  alias: string,
  manager: Manager,
  pack: string | undefined,
  disabled: Disabled,
): Promise<Item | undefined> => {
  const source = await files.text(entry.file);
  if (source === undefined) return undefined;
  const skill = readSkillMd(source);
  const description = codexDescription(skill);
  if (description === undefined) return undefined;
  const dir = dirOf(entry.file);
  const folder = baseOf(dir) || baseOf(pack ?? "") || "skill";
  const own = skill.name ? singleLine(skill.name) : folder;
  const name = entry.plugin ? `${entry.plugin}:${own}` : own;
  const hidden =
    disabled(name, entry.file) || hiddenByPolicy(await files.text(`${dir}/agents/openai.yaml`));
  const rel = entry.root ? entry.file.slice(entry.root.length + 1) : entry.file;
  const item: Item = {
    id: `skill:${name}`,
    ref: { kind: "skill", name },
    harnesses: ["codex"],
    scope: entry.plugin ? "plugin" : "user",
    managedBy: manager.managedBy,
    path: dir || entry.file,
    digest: await sha256(source),
    chars: {
      listed: hidden ? 0 : codexListedChars(name, description, `${alias}/${rel}`),
      body: skill.bodyChars,
    },
    modelInvocable: !hidden,
  };
  if (pack) {
    item.pack = pack;
    item.description = description;
  } else if (manager.pack) {
    item.pack = manager.pack;
  }
  return item;
};

/** Whether `config.toml` turns off the skill of this name at this SKILL.md key. */
type Disabled = (name: string, file: string) => boolean;

/**
 * Whether the last `[[skills.config]]` entry that selects a skill, by its name or its SKILL.md
 * path, turns it off. A key under home (`~/…`) is the path under `home`, so a project's skill of
 * the same folder names is another file.
 */
const disabledBy =
  (rules: readonly SkillRule[], home: string | undefined): Disabled =>
  (name, file) => {
    const absolute =
      home !== undefined && file.startsWith("~/")
        ? `${home.replace(/\/+$/u, "")}${file.slice(1)}`
        : file;
    const at = (path: string) => path === file || path === absolute;
    const rule = rules.findLast((entry) =>
      entry.name === undefined ? at(entry.path!) : entry.name === name,
    );
    return rule?.enabled === false;
  };

/** Skills in Codex order, one Item per SKILL.md, each with the `rN` alias of its root. */
const skillItems = async (
  files: Files,
  entries: SkillEntry[],
  pack?: string,
  disabled: Disabled = () => false,
) => {
  const aliases = new Map<string, string>();
  const managers = new Map<string, (name: string) => Manager>();
  const items: Item[] = [];
  for (const entry of entries) {
    if (!aliases.has(entry.root)) aliases.set(entry.root, `r${aliases.size}`);
    let manager: Manager = { managedBy: "hand" };
    if (entry.plugin) {
      manager = { managedBy: "plugin", pack: entry.plugin };
    } else if (entry.root) {
      if (!managers.has(entry.root)) {
        managers.set(entry.root, await readManagers(files, entry.root));
      }
      manager = managers.get(entry.root)!(entry.file.slice(entry.root.length + 1).split("/")[0]!);
    }
    const item = await skillItem(files, entry, aliases.get(entry.root)!, manager, pack, disabled);
    if (item) items.push(item);
  }
  return items;
};

/** A pack: every SKILL.md in it, named `plugin:skill` when it carries a Codex plugin manifest. */
const packInventory = async (files: Files): Promise<Item[]> => {
  let plugin: string | undefined;
  for (const manifest of PLUGIN_MANIFESTS) {
    if (!files.paths.includes(manifest)) continue;
    plugin =
      pluginName(readManifest(await files.text(manifest))) ??
      files.name?.split("/").pop() ??
      "plugin";
    break;
  }
  const entries = files.paths
    .filter((path) => baseOf(path) === "SKILL.md")
    .map((file) => ({ file, root: "", ...(plugin ? { plugin } : {}) }));
  return skillItems(files, entries, files.name ?? plugin);
};

const PLUGIN_CACHE = /^(.*)\/plugins\/cache\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/u;

/** Orders plugin versions as Codex picks the active one: `local` first, then the highest. */
const compareVersions = (a: string, b: string): number => {
  if (a === "local" || b === "local") return a === "local" ? (b === "local" ? 0 : 1) : -1;
  const parts = (version: string) => version.split(/[.+-]/u).map((part) => Number(part));
  const [left, right] = [parts(a), parts(b)];
  if ([...left, ...right].some(Number.isNaN)) return a < b ? -1 : a > b ? 1 : 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** The SKILL.md files of each enabled plugin's active version in the cache. */
const pluginEntries = async (files: Files, enabled: (id: string) => boolean) => {
  const versions = new Map<string, { base: string; plugin: string; version: string }>();
  for (const path of files.paths) {
    const match = PLUGIN_CACHE.exec(path);
    if (!match) continue;
    const [, home, marketplace, plugin, version] = match;
    if (!enabled(`${plugin}@${marketplace}`)) continue;
    const key = `${home}\u0000${marketplace}\u0000${plugin}`;
    const known = versions.get(key);
    if (!known || compareVersions(version!, known.version) > 0) {
      versions.set(key, {
        base: `${home}/plugins/cache/${marketplace}/${plugin}/${version}`,
        plugin: plugin!,
        version: version!,
      });
    }
  }
  const entries: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const { base, plugin: folder } of versions.values()) {
    let manifest: Record<string, unknown> | undefined;
    for (const path of PLUGIN_MANIFESTS) {
      manifest = readManifest(await files.text(`${base}/${path}`));
      if (manifest) break;
    }
    const name = pluginName(manifest) ?? folder;
    for (const root of pluginSkillRoots(manifest)) {
      for (const path of files.paths) {
        if (!path.startsWith(`${base}/${root}/`) || baseOf(path) !== "SKILL.md") continue;
        if (seen.has(path)) continue;
        seen.add(path);
        entries.push({ file: path, root: `${base}/${root}`, plugin: name });
      }
    }
  }
  return entries;
};

/** A key under one of the skill roots: the root, `.system` included, or undefined when a folder on the way is hidden. */
const userSkillRoot = (path: string): string | undefined => {
  if (baseOf(path) !== "SKILL.md" || path.includes("/plugins/cache/")) return undefined;
  const at = path.indexOf("/skills/");
  if (at === -1) return undefined;
  let root = path.slice(0, at + "/skills".length);
  let rest = path.slice(root.length + 1);
  if (rest.startsWith(".system/")) {
    root += "/.system";
    rest = rest.slice(".system/".length);
  }
  return rest.split("/").some((segment) => segment.startsWith(".")) ? undefined : root;
};

/** A file at the top of a source, not inside a skill or plugin folder. */
const topFile = (files: Files, name: string) =>
  files.paths.filter(
    (path) => baseOf(path) === name && !path.includes("/skills/") && !path.includes("/plugins/"),
  );

/**
 * What is installed for the user on a machine: skills in `$CODEX_HOME/skills` (its `.system` too)
 * and `~/.agents/skills`, the skills of each plugin `config.toml` enables, the user's `AGENTS.md`,
 * and the MCP servers `config.toml` names. Of `config.toml` only table names, `enabled` and the
 * `[[skills.config]]` selectors are read.
 */
const machineInventory = async (files: Files, place?: Place): Promise<Item[]> => {
  const configPath = topFile(files, "config.toml")[0];
  const configText = configPath === undefined ? undefined : await files.text(configPath);
  const config = readCodexConfig(configText ?? "");

  const roots = files.paths.flatMap((file) => {
    const root = userSkillRoot(file);
    return root === undefined ? [] : [{ file, root }];
  });
  // Codex lists its own home's skills, then `~/.agents/skills`, then the bundled `.system` ones.
  const order = (root: string) =>
    root.endsWith("/.system") ? 2 : root.endsWith("/.agents/skills") ? 1 : 0;
  roots.sort((a, b) => order(a.root) - order(b.root));
  const plugins = await pluginEntries(files, (id) => config.plugins.get(id) === true);
  const items = await skillItems(
    files,
    [...roots, ...plugins],
    undefined,
    disabledBy(config.skills, place?.home),
  );

  const instructionPaths = [
    ...topFile(files, "AGENTS.override.md"),
    ...topFile(files, "AGENTS.md"),
  ];
  for (const path of instructionPaths) {
    const source = await files.text(path);
    // Codex loads the file trimmed, and skips an empty one.
    const text = source?.trim();
    if (!source || !text) continue;
    items.push({
      id: `instructions:${CODEX_INSTRUCTIONS}`,
      ref: { kind: "instructions", name: CODEX_INSTRUCTIONS },
      harnesses: ["codex"],
      scope: "user",
      managedBy: "hand",
      path,
      digest: await sha256(source),
      chars: { listed: text.length, body: 0 },
      modelInvocable: true,
    });
    break;
  }

  for (const [server, enabled] of config.mcpServers) {
    if (!enabled) continue;
    const name = codexMcpName(server);
    items.push({
      id: `mcp:${name}`,
      ref: { kind: "mcp", name },
      harnesses: ["codex"],
      scope: "user",
      managedBy: "hand",
      path: configPath!,
      digest: await sha256(configText ?? ""),
      chars: { listed: `- mcp__${name}\n`.length, body: 0 },
      modelInvocable: true,
    });
  }
  return items;
};

/** The name a server's tools go under, `mcp__<name>`: characters a tool name cannot hold become `_`. */
export const codexMcpName = (server: string) => server.replace(/[^A-Za-z0-9_-]/gu, "_");

const codexHome = (place: Place) =>
  (place.env.CODEX_HOME?.replace(/\/+$/u, "") || undefined) ?? `${place.home}/.codex`;

/** Codex (OpenAI's coding agent): its packs, its home directory and its rollout transcripts. */
export const codex = defineHarness({
  id: "codex",
  signals: {
    // The transcript holds the skills section as sent, line by line.
    listing: "exact",
    // No Skill tool: a use is a tool call that reads a listed SKILL.md.
    modelUse: "inferred",
    // A `$skill` mention injects a `<skill>` message, and only a mention does.
    userUse: "exact",
    // The AGENTS.md fragment holds the user's text before the project-doc separator.
    instructions: "exact",
    // Servers are listed by namespace; uses are `mcp__<server>__` names in tool calls.
    mcp: "inferred",
    // `token_count` events carry each request's input tokens.
    tokens: "exact",
  },
  inventory: packInventory,
  machine: {
    home: codexHome,
    sources: (place) => {
      const home = codexHome(place);
      return [
        `${home}/skills`,
        `${place.home}/.agents/skills`,
        `${home}/plugins/cache`,
        `${home}/AGENTS.override.md`,
        `${home}/AGENTS.md`,
        `${home}/config.toml`,
        skillsLockPath(place.home.replace(/\/+$/u, ""), place.env),
      ];
    },
    inventory: machineInventory,
    roots: (place) => [`${codexHome(place)}/sessions`, `${codexHome(place)}/archived_sessions`],
    transcripts: codexTranscripts,
  },
});

// Where Claude Code keeps what is installed for the user, and the Items in it. Pure string work on
// the Files kit reads: nothing here touches the filesystem.
import type { Files, Place } from "@loadsheet/kit";
import { sha256 } from "@loadsheet/kit";
import type { Item, Kind } from "@loadsheet/schema";
import {
  claudeCodeAgentChars,
  claudeCodeBareChars,
  claudeCodeDescription,
  claudeCodeEntryChars,
  claudeCodeListedChars,
} from "./claude-code-listing.ts";
import { readManagers, skillsLockPath, type Manager } from "./managed.ts";
import { packInventory } from "./pack.ts";
import { readSkillMd } from "./skill-md.ts";

const HARNESS = "claude-code";

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, "") : path);
const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path);

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export const claudeConfigDir = (place: Place): string => {
  const home = trimSlash(place.home);
  const configured = place.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return `${home}/.claude`;
  if (configured === "~" || configured.startsWith("~/"))
    return trimSlash(home + configured.slice(1));
  return trimSlash(isAbsolute(configured) ? configured : `${home}/${configured}`);
};

/** The file that holds user MCP servers: `~/.claude.json`, or inside `CLAUDE_CONFIG_DIR` when set. */
const mcpConfigPath = (place: Place) =>
  place.env.CLAUDE_CONFIG_DIR?.trim()
    ? `${claudeConfigDir(place)}/.claude.json`
    : `${trimSlash(place.home)}/.claude.json`;

export const claudeSources = (place: Place): string[] => {
  const config = claudeConfigDir(place);
  return [
    `${config}/CLAUDE.md`,
    `${config}/rules`,
    `${config}/skills`,
    `${config}/commands`,
    `${config}/agents`,
    `${config}/settings.json`,
    `${config}/plugins/installed_plugins.json`,
    `${config}/plugins/cache`,
    mcpConfigPath(place),
    skillsLockPath(trimSlash(place.home), place.env),
  ];
};

export const claudeRoots = (place: Place): string[] => [`${claudeConfigDir(place)}/projects`];

// The config directory's own files; a plugin has none of these at its root.
const HOME_FILE = /^(.*)\/(?:settings\.json|CLAUDE\.md|plugins\/installed_plugins\.json)$/u;
const HOME_FOLDER = /^(.*?)\/(?:skills\/[^/]+\/SKILL\.md|(?:commands|agents|rules)\/.+\.md)$/u;

/**
 * The config directory as `files` keys it. inventory is not given the Place, so it is the
 * shortest prefix of the config directory's own files, or failing those of its skill folders.
 */
const findConfigDir = (paths: readonly string[]): string | undefined => {
  const shortest = (pattern: RegExp) =>
    paths
      .map((path) => pattern.exec(path)?.[1])
      .filter((prefix): prefix is string => prefix !== undefined)
      .sort((a, b) => a.length - b.length)[0];
  return shortest(HOME_FILE) ?? shortest(HOME_FOLDER);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (files: Files, path: string): Promise<Record<string, unknown>> => {
  const text = await files.text(path);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** The name Claude Code gives an MCP server in its tool names: anything but `[A-Za-z0-9_-]` becomes `_`. */
export const mcpToolName = (name: string) => name.replace(/[^A-Za-z0-9_-]/gu, "_");

/** A server's config without the values that carry secrets, so its digest says when it changed. */
const mcpDigest = (server: unknown) => {
  const { env: _env, headers: _headers, ...rest } = isRecord(server) ? server : {};
  return sha256(JSON.stringify(rest));
};

const mcpItems = async (
  servers: unknown,
  path: string,
  scope: Item["scope"],
  manager: Manager,
  prefix = "",
): Promise<Item[]> => {
  if (!isRecord(servers)) return [];
  const items: Item[] = [];
  for (const [server, config] of Object.entries(servers)) {
    const name = mcpToolName(prefix + server);
    items.push({
      id: `mcp:${name}`,
      ref: { kind: "mcp", name },
      harnesses: [HARNESS],
      scope,
      ...(manager.pack === undefined ? {} : { pack: manager.pack }),
      managedBy: manager.managedBy,
      path,
      digest: await mcpDigest(config),
      // Its instructions come from the server when a session starts; only transcripts know them.
      chars: { listed: 0, body: 0 },
      modelInvocable: true,
    });
  }
  return items;
};

type Override = "on" | "name-only" | "user-invocable-only" | "off";
const OVERRIDES = new Set<string>(["on", "name-only", "user-invocable-only", "off"]);

/** `skillOverrides` from settings.json; one unknown value makes Claude Code drop them all. */
const skillOverrides = (settings: Record<string, unknown>) => {
  const overrides = new Map<string, Override>();
  if (!isRecord(settings.skillOverrides)) return overrides;
  const entries = Object.entries(settings.skillOverrides);
  if (!entries.every(([, value]) => typeof value === "string" && OVERRIDES.has(value))) {
    return overrides;
  }
  for (const [name, value] of entries) overrides.set(name, value as Override);
  return overrides;
};

/** One user skill, command or subagent file. */
const fileItem = async (
  files: Files,
  file: string,
  entry: { kind: Kind; name: string; path: string; manager: Manager; override?: Override },
): Promise<Item | undefined> => {
  const source = await files.text(file);
  if (source === undefined) return undefined;
  const md = readSkillMd(source);
  const { kind, name, override } = entry;
  const hidden = override === "off" || override === "user-invocable-only";
  const listed =
    kind === "subagent"
      ? claudeCodeAgentChars(name, md)
      : hidden || md.disableModelInvocation
        ? 0
        : override === "name-only"
          ? claudeCodeBareChars(name)
          : claudeCodeListedChars(name, md);
  return {
    id: `${kind}:${name}`,
    ref: { kind, name },
    harnesses: [HARNESS],
    scope: "user",
    ...(entry.manager.pack === undefined ? {} : { pack: entry.manager.pack }),
    managedBy: entry.manager.managedBy,
    path: entry.path,
    digest: await sha256(source),
    chars: { listed, body: md.bodyChars },
    modelInvocable: kind === "subagent" || (!hidden && !md.disableModelInvocation),
  };
};

/** The files under `prefix/`, keyed relative to it, named `name`. */
const subFiles = (files: Files, prefix: string, name: string): Files => ({
  name,
  paths: files.paths
    .filter((path) => path.startsWith(`${prefix}/`))
    .map((path) => path.slice(prefix.length + 1)),
  text: (path) => files.text(`${prefix}/${path}`),
});

/**
 * Where an installed plugin's files are keyed: its `installPath` is absolute, while kit keys the
 * home directory's files `~/...`, so the path is matched from its `plugins/` folder on.
 */
const pluginRoot = (files: Files, config: string, installPath: string) => {
  const at = installPath.lastIndexOf("/plugins/");
  const candidates = [trimSlash(installPath)];
  if (at !== -1) candidates.unshift(`${config}${trimSlash(installPath.slice(at))}`);
  return candidates.find((root) => files.paths.some((path) => path.startsWith(`${root}/`)));
};

/** The plugins enabled in settings.json and installed for the user, with their roots. */
const enabledPlugins = async (files: Files, config: string, settings: Record<string, unknown>) => {
  const installed = await readJson(files, `${config}/plugins/installed_plugins.json`);
  const enabled = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const plugins: { key: string; root: string }[] = [];
  if (!isRecord(installed.plugins)) return plugins;
  for (const [key, records] of Object.entries(installed.plugins).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (enabled[key] !== true || !Array.isArray(records)) continue;
    for (const record of records) {
      if (!isRecord(record) || typeof record.installPath !== "string") continue;
      if (record.scope !== "user" && record.scope !== "managed") continue;
      const root = pluginRoot(files, config, record.installPath);
      if (root !== undefined) {
        plugins.push({ key, root });
        break;
      }
    }
  }
  return plugins;
};

const pluginItems = async (files: Files, key: string, root: string): Promise<Item[]> => {
  const fallback = key.split("@")[0] || key;
  const plugin = subFiles(files, root, fallback);
  const manifest = await readJson(files, `${root}/.claude-plugin/plugin.json`);
  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : fallback;
  const manager: Manager = { managedBy: "plugin", pack: name };
  const items = (
    await packInventory(plugin, {
      harness: HARNESS,
      description: claudeCodeDescription,
      listedChars: claudeCodeEntryChars,
    })
  ).map(({ description: _description, ...item }): Item => ({
    ...item,
    scope: "plugin",
    managedBy: "plugin",
    pack: name,
    path: `${root}/${item.path}`,
  }));
  // A plugin's MCP servers sit in `.mcp.json` or the manifest's `mcpServers`; their tools are
  // named `mcp__plugin_<plugin>_<server>__<tool>`.
  const mcpFile = await readJson(files, `${root}/.mcp.json`);
  const fromFile = isRecord(mcpFile.mcpServers) ? mcpFile.mcpServers : mcpFile;
  for (const [servers, path] of [
    [fromFile, `${root}/.mcp.json`],
    [manifest.mcpServers, `${root}/.claude-plugin/plugin.json`],
  ] as const) {
    items.push(...(await mcpItems(servers, path, "plugin", manager, `plugin_${name}_`)));
  }
  return items;
};

/** Every piece of context Claude Code loads for the user, from the files `claudeSources` names. */
export const claudeInventory = async (files: Files): Promise<Item[]> => {
  const config = findConfigDir(files.paths);
  const items: Item[] = [];
  if (config !== undefined) {
    const settings = await readJson(files, `${config}/settings.json`);
    const overrides = skillOverrides(settings);

    for (const file of [
      `${config}/CLAUDE.md`,
      ...files.paths.filter((p) => p.startsWith(`${config}/rules/`)),
    ]) {
      if (!file.endsWith(".md")) continue;
      const text = await files.text(file);
      if (text === undefined) continue;
      const name = file.slice(config.length + 1);
      items.push({
        id: `instructions:${name}`,
        ref: { kind: "instructions", name },
        harnesses: [HARNESS],
        scope: "user",
        managedBy: "hand",
        path: file,
        digest: await sha256(text),
        chars: { listed: text.length, body: 0 },
        modelInvocable: true,
      });
    }

    const folders = [
      { dir: `${config}/skills`, kind: "skill" as const, pattern: /^([^/]+)\/SKILL\.md$/u },
      { dir: `${config}/commands`, kind: "skill" as const, pattern: /^(.+)\.md$/u },
      { dir: `${config}/agents`, kind: "subagent" as const, pattern: /^(.+)\.md$/u },
    ];
    for (const { dir, kind, pattern } of folders) {
      const managers = await readManagers(files, dir);
      for (const file of files.paths) {
        if (!file.startsWith(`${dir}/`)) continue;
        const match = pattern.exec(file.slice(dir.length + 1));
        if (!match?.[1]) continue;
        const relative = match[1];
        const top = relative.split("/")[0]!;
        let name: string;
        let path: string;
        if (kind === "skill" && !dir.endsWith("/skills")) {
          // A command in a subfolder is named `folder:name`.
          name = relative.replaceAll("/", ":");
          path = file;
        } else {
          // A skill and a subagent go by their frontmatter name, a skill by its folder without one.
          const declared = readSkillMd((await files.text(file)) ?? "").name;
          name =
            declared && !/[\\/<>\p{Cc}]/u.test(declared) ? declared : relative.split("/").pop()!;
          path = kind === "skill" ? `${dir}/${relative}` : file;
        }
        const item = await fileItem(files, file, {
          kind,
          name,
          path,
          manager: managers(top),
          ...(kind === "skill" && overrides.has(name) ? { override: overrides.get(name)! } : {}),
        });
        if (item) items.push(item);
      }
    }

    for (const { key, root } of await enabledPlugins(files, config, settings)) {
      items.push(...(await pluginItems(files, key, root)));
    }
  }

  // User MCP servers: names and a digest only, since the file also holds their secrets.
  const mcpPath =
    (config !== undefined && files.paths.includes(`${config}/.claude.json`)
      ? `${config}/.claude.json`
      : undefined) ??
    files.paths
      .filter((path) => path.endsWith("/.claude.json"))
      .sort((a, b) => a.length - b.length)[0];
  if (mcpPath !== undefined) {
    const mcp = await readJson(files, mcpPath);
    items.push(...(await mcpItems(mcp.mcpServers, mcpPath, "user", { managedBy: "hand" })));
  }
  return items;
};

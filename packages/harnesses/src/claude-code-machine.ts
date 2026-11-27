// Where Claude Code keeps what is installed for the user, and the Items in it. Pure string work on
// the Files kit reads: nothing here touches the filesystem.
import type { Files, Place, ProjectHint } from "@loadsheet/kit";
import { sha256 } from "@loadsheet/kit";
import type { Item, Kind, Settings } from "@loadsheet/schema";
import {
  claudeCodeAgentChars,
  claudeCodeBareChars,
  claudeCodeDescription,
  claudeCodeEntryChars,
  claudeCodeListedChars,
} from "./claude-code-listing.ts";
import { readManagers, skillsLockPath, type Manager } from "./managed.ts";
import { packInventory } from "./pack.ts";
import { isAbsolute, normalPath } from "./path.ts";
import { readSkillMd, SKILL_NAME } from "./skill-md.ts";

const HARNESS = "claude-code";

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, "") : path);

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export const claudeConfigDir = (place: Place): string => {
  const home = trimSlash(place.home);
  const configured = place.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return `${home}/.claude`;
  if (configured === "~" || configured.startsWith("~/"))
    return normalPath(home + configured.slice(1));
  return normalPath(isAbsolute(configured) ? configured : `${home}/${configured}`);
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
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

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

/** A name loadsheet will put in an id: no spaces, markup, quotes, path separators or invisible characters. */
export const NAME = /^[^\s<>"'`/\\\p{C}]{1,128}$/u;

/** The name Claude Code gives an MCP server in its tool names: anything but `[A-Za-z0-9_-]` becomes `_`. */
export const mcpToolName = (name: string) => name.replace(/[^A-Za-z0-9_-]/gu, "_");
/** A server's name as a tool name carries it. */
export const MCP_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

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
  const description = kind === "subagent" ? md.description : claudeCodeDescription(md);
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
    ...(description ? { description } : {}),
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
    await packInventory(
      plugin,
      { harness: HARNESS, description: claudeCodeDescription, listedChars: claudeCodeEntryChars },
      name,
    )
  ).map((item): Item => ({
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
          // A skill and a subagent go by their frontmatter name. Claude Code refuses one it cannot
          // show, such as a name with two spaces in a row, and goes by the folder or file instead.
          const declared = readSkillMd((await files.text(file)) ?? "").name;
          name = declared && SKILL_NAME.test(declared) ? declared : relative.split("/").pop()!;
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

/** `path` keyed as kit keys a source in Files: `~/...` under the home directory, absolute elsewhere. */
export const filesKey = (path: string, home: string): string => {
  const root = normalPath(home.replaceAll("\\", "/"));
  const at = normalPath(path.replaceAll("\\", "/"));
  if (at === root) return "~";
  return at.startsWith(`${root}/`) ? `~/${at.slice(root.length + 1)}` : at;
};

/** A home directory written out in full, as the schema rejects one in a project. */
const FULL_HOME = /^(?:\/(?:home|Users|var\/home)\/|\/root(?:\/|$)|[A-Za-z]:\/)/u;

/**
 * A session's working directory as a project key: `~/...` under `place`'s home, absolute
 * elsewhere, and `unknown` when it is not absolute, holds a control character, or would name a
 * home directory in full (another user's, or any without a Place to tell).
 */
export const folderKey = (cwd: string, place?: Place): string => {
  if (!isAbsolute(cwd) || /\p{C}/u.test(cwd)) return "unknown";
  const key = place ? filesKey(cwd, place.home) : normalPath(cwd.replaceAll("\\", "/"));
  return FULL_HOME.test(key) ? "unknown" : key;
};

/** Days Claude Code keeps a transcript when `cleanupPeriodDays` is unset. */
export const CLAUDE_CODE_RETENTION_DAYS = 30;

const TTLS = ["5m", "1h"] as const;
type Ttl = (typeof TTLS)[number];
const ttl = (value: unknown): Ttl | undefined =>
  typeof value === "string" ? TTLS.find((each) => each === value.trim().toLowerCase()) : undefined;
/** Claude Code's reading of a flag variable: `1`, `true`, `yes` or `on`, in any case. */
const truthy = (value: unknown) =>
  typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
const positive = (value: unknown) => {
  const number = typeof value === "string" && /^\s*\d+\s*$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined;
};
/** The variables that turn prompt caching off, for every model or one family. */
const CACHING_OFF = /^DISABLE_PROMPT_CACHING(?:_[A-Z0-9]+)?$/u;

/**
 * What Claude Code's settings.json and the environment set for the prompt cache, compaction and
 * transcript retention. A variable counts from the settings' `env` block, which Claude Code applies
 * over the environment it starts in, or else from `place.env`; only the names below are read, and
 * only what they mean is kept. Precedence for the cache's lifetime, as Claude Code documents it:
 * FORCE_PROMPT_CACHING_5M, then CLAUDE_CODE_PROMPT_CACHE_TTL, then `promptCacheTtl`, then
 * ENABLE_PROMPT_CACHING_1H; with none set the lifetime is the default and left out. Retention is
 * `cleanupPeriodDays`, or Claude Code's 30 days when that is unset.
 */
export const claudeSettings = async (files: Files, place: Place): Promise<Settings | undefined> => {
  const settingsPath = `${filesKey(claudeConfigDir(place), place.home)}/settings.json`;
  const present = files.paths.includes(settingsPath);
  const settings = present ? await readJson(files, settingsPath) : {};
  const block = isRecord(settings.env) ? settings.env : {};
  /** A variable's value and the knob it came from. */
  const variable = (name: string): { value: unknown; from: string } | undefined => {
    if (typeof block[name] === "string")
      return { value: block[name], from: `settings.env.${name}` };
    if (typeof place.env[name] === "string") return { value: place.env[name], from: `env.${name}` };
    return undefined;
  };
  const names = new Set([...Object.keys(block), ...Object.keys(place.env)]);
  const out: Settings = {};

  const lifetime = (envName: string, settingName: string) => {
    const force = variable("FORCE_PROMPT_CACHING_5M");
    if (force && truthy(force.value)) return { ttl: "5m" as const, from: force.from };
    const env = variable(envName);
    const fromEnv = env && ttl(env.value);
    if (env && fromEnv) return { ttl: fromEnv, from: env.from };
    const fromSettings = ttl(settings[settingName]);
    if (fromSettings) return { ttl: fromSettings, from: `settings.${settingName}` };
    const long = variable("ENABLE_PROMPT_CACHING_1H");
    if (long && truthy(long.value)) return { ttl: "1h" as const, from: long.from };
    return undefined;
  };
  const main = lifetime("CLAUDE_CODE_PROMPT_CACHE_TTL", "promptCacheTtl");
  if (main) {
    out.cacheTtl = main.ttl;
    out.cacheTtlFrom = main.from;
  }
  const subagent = lifetime("CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", "subagentPromptCacheTtl");
  if (subagent) out.subagentCacheTtl = subagent.ttl;
  const off = [...names]
    .sort()
    .find((name) => CACHING_OFF.test(name) && truthy(variable(name)?.value));
  if (off !== undefined) {
    out.caching = "off";
    out.cachingFrom = variable(off)!.from;
  }

  out.retentionDays = positive(settings.cleanupPeriodDays) ?? CLAUDE_CODE_RETENTION_DAYS;

  if (
    settings.autoCompactEnabled === false ||
    truthy(variable("DISABLE_AUTO_COMPACT")?.value) ||
    truthy(variable("DISABLE_COMPACT")?.value)
  ) {
    out.autoCompact = false;
  } else if (settings.autoCompactEnabled === true) {
    out.autoCompact = true;
  }
  const window =
    positive(variable("CLAUDE_CODE_AUTO_COMPACT_WINDOW")?.value) ??
    positive(settings.autoCompactWindow);
  if (window !== undefined) out.autoCompactWindow = window;

  return out;
};

/** `owner/repo` as GitHub spells it. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u;

/**
 * The repositories `~/.claude.json` remembers folders for, in `githubRepoPaths`: each folder,
 * keyed as the Files keys paths, belongs to its `owner/repo`, folders since deleted included.
 */
export const claudeProjects = async (files: Files, place: Place): Promise<ProjectHint[]> => {
  const { githubRepoPaths } = await readJson(files, filesKey(mcpConfigPath(place), place.home));
  if (!isRecord(githubRepoPaths)) return [];
  const hints: ProjectHint[] = [];
  for (const [project, paths] of Object.entries(githubRepoPaths)) {
    if (!REPO.test(project)) continue;
    for (const path of strings(paths)) {
      if (isAbsolute(path)) hints.push({ prefix: filesKey(path, place.home), project });
    }
  }
  return hints;
};

/**
 * Claude Code's context window: 1M tokens when settings.json's `model` asks for it with a `[1m]`
 * suffix, as in `opus[1m]`, and 200k otherwise. Undefined when there is no config directory.
 */
export const claudeContextWindow = async (files: Files): Promise<number | undefined> => {
  const config = findConfigDir(files.paths);
  if (config === undefined) return undefined;
  const { model } = await readJson(files, `${config}/settings.json`);
  return typeof model === "string" && /\[1m\]$/iu.test(model.trim()) ? 1_000_000 : 200_000;
};

// What the inventory-only adapters share: finding skill folders, naming them as the full adapters
// do, and building Items. Pure string work on the Files kit reads: nothing here touches the
// filesystem.
import { sha256, type Files, type Place } from "@loadsheet/kit";
import type { Grade, Item, Scope, Signal } from "@loadsheet/schema";
import { mcpToolName } from "./claude-code-machine.ts";
import { readManagers, type Manager } from "./managed.ts";
import { readSkillMd, SKILL_NAME, type SkillMd } from "./skill-md.ts";

/** The grades of a harness loadsheet reads no transcripts of: it can tell what is installed, not what is used. */
export const NO_USAGE: Record<Signal, Grade> = {
  listing: "none",
  modelUse: "none",
  userUse: "none",
  instructions: "none",
  mcp: "none",
  tokens: "none",
};

export const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, "") : path);
export const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
const singleLine = (text: string) => text.split(/\s+/u).filter(Boolean).join(" ");

/**
 * The Place an adapter's `inventory` works from. Without one, home is `~`, so the directories it
 * derives are the `~/...` keys kit gives them.
 */
export const placeOr = (place: Place | undefined): Place => place ?? { home: "~", env: {} };

/** An absolute path as kit keys it: `~/...` under home, absolute elsewhere. */
export const keyOf = (path: string, place: Place) => {
  const home = trimSlash(place.home);
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
};

/** A Files key as the absolute path the harness itself sees; the key itself when home is `~`. */
export const absoluteOf = (key: string, place: Place) =>
  key === "~" || key.startsWith("~/") ? `${trimSlash(place.home)}${key.slice(1)}` : key;

/**
 * A directory an environment variable names: `~` expanded, and a relative one taken under home,
 * as the Claude Code adapter reads `CLAUDE_CONFIG_DIR`. Undefined when the variable is unset.
 */
export const envDir = (place: Place, name: string): string | undefined => {
  const value = place.env[name]?.trim();
  if (!value) return undefined;
  const home = trimSlash(place.home);
  if (value === "~" || value.startsWith("~/")) return trimSlash(home + value.slice(1));
  return trimSlash(value.startsWith("/") ? value : `${home}/${value}`);
};

/** A boolean environment variable: true for `true` or `1`, false for `false` or `0`, else unset. */
export const envFlag = (place: Place, name: string): boolean | undefined => {
  const value = place.env[name]?.trim().toLowerCase();
  return value === "true" || value === "1"
    ? true
    : value === "false" || value === "0"
      ? false
      : undefined;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with `//` and `/* *\/` comments and trailing commas, as several harnesses accept it in config files. */
export const parseJsonc = (text: string): unknown => {
  let out = "";
  // Where in `out` the last comma outside a string sits, until a value or a closing bracket follows.
  let comma: number | undefined;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      at = end === -1 ? text.length : end + 1;
      out += " ";
      continue;
    }
    if (/\s/u.test(char)) {
      out += char;
      continue;
    }
    if (comma !== undefined && (char === "}" || char === "]")) {
      out = out.slice(0, comma) + out.slice(comma + 1);
    }
    comma = char === "," ? out.length : undefined;
    if (char === '"') {
      const start = at;
      for (at++; at < text.length && text[at] !== '"'; at++) if (text[at] === "\\") at++;
      out += text.slice(start, at + 1);
    } else out += char;
  }
  return JSON.parse(out) as unknown;
};

/** A JSON or JSONC file's top object; empty when it is missing or unreadable. */
export const readJsonc = async (files: Files, path: string): Promise<Record<string, unknown>> => {
  const text = await files.text(path);
  if (text === undefined) return {};
  try {
    const parsed = parseJsonc(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * What a harness's skill listing spends on one skill when loadsheet cannot establish its format:
 * the name and description in the plainest form, `- name: description` and a newline.
 */
export const plainListedChars = (name: string, description: string | undefined) =>
  (description ? `- ${name}: ${description}\n` : `- ${name}\n`).length;

const escapeXml = (text: string) =>
  text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");

/**
 * The `<skill>` entry Pi and Gemini CLI list for a skill, with the newline that joins it to the
 * next: its name, description and the absolute path of its SKILL.md. Pi escapes XML; Gemini does not.
 */
export const xmlListedChars = (
  name: string,
  description: string,
  location: string,
  escape: boolean,
) => {
  const text = escape ? escapeXml : (value: string) => value;
  return [
    "  <skill>",
    `    <name>${text(name)}</name>`,
    `    <description>${text(description)}</description>`,
    `    <location>${text(location)}</location>`,
    "  </skill>",
    "",
  ].join("\n").length;
};

/** A folder a harness finds skills in. */
export interface SkillRoot {
  /** The folder as Files keys it. */
  readonly dir: string;
  /** How many folders deep a SKILL.md may sit: 1 is `<dir>/<skill>/SKILL.md` only. */
  readonly depth: number;
  /** Whether `<dir>/SKILL.md` is a skill too (Gemini CLI). */
  readonly self?: boolean;
  /** Whether each `<dir>/*.md` is a skill too, named after its file (OpenCode). */
  readonly flat?: boolean;
}

/** One skill a harness found, before it decides what the skill costs. */
export interface FoundSkill {
  /** Its SKILL.md, or a flat skill's file, as Files keys it. */
  readonly file: string;
  /** Its Item path: its folder, or a flat skill's file. */
  readonly path: string;
  /** The folder or file name a harness names it by when the frontmatter gives none. */
  readonly folder: string;
  /** Its name in an Item id: the one Claude Code gives a folder in `~/.claude/skills` and Codex any other, so a folder two harnesses read is one Item. */
  readonly name: string;
  readonly source: string;
  readonly skill: SkillMd;
  readonly manager: Manager;
}

const hiddenSegment = (segment: string) => segment.startsWith(".") || segment === "node_modules";

/**
 * The skills in one folder, in path order. A folder with a SKILL.md is one skill: nothing below it
 * is another. Hidden folders and `node_modules` are skipped.
 */
export const findSkills = async (files: Files, root: SkillRoot): Promise<FoundSkill[]> => {
  const prefix = `${root.dir}/`;
  const candidates: { file: string; path: string; folder: string; top: string }[] = [];
  for (const file of files.paths) {
    if (!file.startsWith(prefix)) continue;
    const segments = file.slice(prefix.length).split("/");
    if (segments.some(hiddenSegment)) continue;
    const base = segments.at(-1)!;
    const depth = segments.length - 1;
    if (base === "SKILL.md" && depth >= (root.self ? 0 : 1) && depth <= root.depth) {
      const path = depth === 0 ? root.dir : dirOf(file);
      candidates.push({ file, path, folder: baseOf(path), top: segments[0]! });
    } else if (root.flat && depth === 0 && base.endsWith(".md") && base !== "SKILL.md") {
      candidates.push({ file, path: file, folder: base.slice(0, -3), top: base.slice(0, -3) });
    }
  }
  const skillDirs = new Set(candidates.filter((c) => c.path !== c.file).map((c) => c.path));
  const nested = (path: string) => {
    for (let dir = dirOf(path); dir.length > root.dir.length; dir = dirOf(dir)) {
      if (skillDirs.has(dir)) return true;
    }
    return false;
  };

  const managers = await readManagers(files, root.dir);
  const claude = root.dir.endsWith("/.claude/skills");
  const found: FoundSkill[] = [];
  for (const candidate of candidates) {
    if (nested(candidate.path)) continue;
    const source = await files.text(candidate.file);
    if (source === undefined) continue;
    const skill = readSkillMd(source);
    const declared = skill.name;
    const name = claude
      ? declared !== undefined && SKILL_NAME.test(declared)
        ? declared
        : candidate.folder
      : declared
        ? singleLine(declared)
        : candidate.folder;
    found.push({
      file: candidate.file,
      path: candidate.path,
      folder: candidate.folder,
      name,
      source,
      skill,
      manager: managers(candidate.top),
    });
  }
  return found;
};

/** One skill per key, in the order found: the first of a key wins, or the last when `wins` is `last`. */
export const oneByKey = <T>(
  entries: readonly T[],
  key: (entry: T) => string,
  wins: "first" | "last",
): T[] => {
  const kept = new Map<string, T>();
  for (const entry of entries) {
    const at = key(entry);
    if (wins === "last" || !kept.has(at)) kept.set(at, entry);
  }
  return [...kept.values()];
};

/** A found skill's Item. `listed` is 0 for one the harness keeps out of its listing. */
export const skillItem = async (
  harness: string,
  found: FoundSkill,
  chars: { listed: number; modelInvocable: boolean },
  owner?: { scope: Scope; pack: string },
): Promise<Item> => {
  const manager: Manager = owner ? { managedBy: "plugin", pack: owner.pack } : found.manager;
  return {
    id: `skill:${found.name}`,
    ref: { kind: "skill", name: found.name },
    harnesses: [harness],
    scope: owner?.scope ?? "user",
    ...(manager.pack === undefined ? {} : { pack: manager.pack }),
    managedBy: manager.managedBy,
    path: found.path,
    digest: await sha256(found.source),
    chars: { listed: chars.listed, body: found.skill.bodyChars },
    modelInvocable: chars.modelInvocable,
  };
};

/**
 * An instruction file's Item. By default every session pays its whole text; `chars` says otherwise
 * for a file that loads only on a match or on request.
 */
export const instructionItem = async (
  harness: string,
  entry: { name: string; path: string; source: string; scope?: Scope; pack?: string },
  chars: { listed: number; body: number } = { listed: entry.source.length, body: 0 },
  modelInvocable = true,
): Promise<Item> => ({
  id: `instructions:${entry.name}`,
  ref: { kind: "instructions", name: entry.name },
  harnesses: [harness],
  scope: entry.scope ?? "user",
  ...(entry.pack === undefined ? {} : { pack: entry.pack }),
  managedBy: entry.pack === undefined ? "hand" : "plugin",
  path: entry.path,
  digest: await sha256(entry.source),
  chars,
  modelInvocable,
});

/**
 * The name an instruction file under `~/.claude` has in the Claude Code adapter, relative to that
 * folder (`CLAUDE.md`, `rules/x.md`), so the file is one Item whichever harness loads it. A file
 * anywhere else is named by its key.
 */
export const instructionName = (key: string) =>
  key.startsWith("~/.claude/") ? key.slice("~/.claude/".length) : key;

/** A server's config without the values that carry secrets, so its digest says when it changed. */
export const mcpConfigDigest = (config: unknown) => {
  const {
    env: _env,
    headers: _headers,
    environment: _environment,
    ...rest
  } = isRecord(config) ? config : {};
  return sha256(JSON.stringify(rest));
};

/**
 * An MCP server's Item, named as Claude Code and Codex name it (`[A-Za-z0-9_-]`, anything else `_`).
 * Its tools and instructions come from the server when a session starts, which only a transcript
 * shows, so it lists nothing here.
 */
export const mcpItem = (
  harness: string,
  server: string,
  path: string,
  digest: string,
  owner?: { scope: Scope; pack: string },
): Item => {
  const name = mcpToolName(server);
  return {
    id: `mcp:${name}`,
    ref: { kind: "mcp", name },
    harnesses: [harness],
    scope: owner?.scope ?? "user",
    ...(owner ? { pack: owner.pack } : {}),
    managedBy: owner ? "plugin" : "hand",
    path,
    digest,
    chars: { listed: 0, body: 0 },
    modelInvocable: true,
  };
};

/** The servers of a JSON `mcpServers` object, each with its config's digest; `keep` filters them. */
export const jsonMcpItems = async (
  harness: string,
  servers: unknown,
  path: string,
  keep: (name: string, config: unknown) => boolean = () => true,
  owner?: { scope: Scope; pack: string },
): Promise<Item[]> => {
  if (!isRecord(servers)) return [];
  const items: Item[] = [];
  for (const [server, config] of Object.entries(servers)) {
    if (!keep(server, config)) continue;
    items.push(mcpItem(harness, server, path, await mcpConfigDigest(config), owner));
  }
  return items;
};

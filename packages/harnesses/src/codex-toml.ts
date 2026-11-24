/**
 * What loadsheet reads from Codex's `config.toml`: table names and their `enabled` switch, and the
 * selectors of `[[skills.config]]` entries; nothing else.
 */
export interface CodexConfig {
  /** MCP server name to whether it is enabled. */
  readonly mcpServers: ReadonlyMap<string, boolean>;
  /** Plugin id (`plugin@marketplace`) to whether it is enabled. */
  readonly plugins: ReadonlyMap<string, boolean>;
  /** `[[skills.config]]` entries in order, each selecting skills by name or by SKILL.md path; a later one wins. */
  readonly skills: readonly SkillRule[];
}

export interface SkillRule {
  readonly name?: string;
  readonly path?: string;
  readonly enabled: boolean;
}

const HEADER = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/u;
const ARRAY_HEADER = /^\s*\[\[([^[\]]+)\]\]\s*(?:#.*)?$/u;
const SELECTOR = /^\s*(name|path)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/u;
const INLINE_ENTRY = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=\s*\{(.*)$/u;
const ENABLED = /^\s*enabled\s*=\s*(true|false)\b/u;
const INLINE_DISABLED = /(?:^|[{,\s])enabled\s*=\s*false\b/u;

/** Splits a dotted TOML key such as `plugins."a@b".x` into its parts, unquoting each. */
const keyParts = (key: string): string[] => {
  const parts: string[] = [];
  const pattern = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^.\s"']+)\s*(?:\.|$)/guy;
  for (const match of key.matchAll(pattern)) {
    const part = match[1]!;
    if (part.startsWith('"')) {
      try {
        parts.push(JSON.parse(part) as string);
      } catch {
        parts.push(part.slice(1, -1));
      }
    } else if (part.startsWith("'")) parts.push(part.slice(1, -1));
    else parts.push(part);
  }
  return parts;
};

/**
 * Reads the tables of a Codex `config.toml` line by line. It keeps the names of `[mcp_servers.*]`
 * and `[plugins.*]` tables and whether each sets `enabled = false`, and each `[[skills.config]]`
 * entry's `name` or `path` and `enabled`; every other value, command, token and environment variable
 * is skipped without being kept.
 */
/**
 * The triple quote a line opens and does not close. Strings on the line are read past and a comment
 * ends it, so a quote inside either opens nothing.
 */
const leftOpen = (line: string): string | undefined => {
  for (let at = 0; at < line.length; at++) {
    const quote = line[at]!;
    if (quote === "#") return undefined;
    if (quote !== '"' && quote !== "'") continue;
    const triple = quote.repeat(3);
    if (line.startsWith(triple, at)) {
      const end = line.indexOf(triple, at + 3);
      if (end === -1) return triple;
      at = end + 2;
      continue;
    }
    at++;
    while (at < line.length && line[at] !== quote) at += quote === '"' && line[at] === "\\" ? 2 : 1;
  }
  return undefined;
};

export const readCodexConfig = (source: string): CodexConfig => {
  const mcpServers = new Map<string, boolean>();
  const plugins = new Map<string, boolean>();
  const rules: { name?: string; path?: string; enabled?: boolean }[] = [];
  let rule: (typeof rules)[number] | undefined;
  let table: string[] = [];
  let target: Map<string, boolean> | undefined;
  let name: string | undefined;
  let multiline: string | undefined;

  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    if (multiline !== undefined) {
      if (line.split(multiline).length % 2 === 0) multiline = undefined;
      continue;
    }
    if (/^\s*#/u.test(line)) continue;
    const array = ARRAY_HEADER.exec(line);
    if (array) {
      const [root, key, ...rest] = keyParts(array[1]!);
      rule = root === "skills" && key === "config" && rest.length === 0 ? {} : undefined;
      if (rule) rules.push(rule);
      table = [];
      target = undefined;
      continue;
    }
    if (rule) {
      if (HEADER.test(line)) rule = undefined;
      else {
        const selector = SELECTOR.exec(line);
        const enabled = ENABLED.exec(line);
        if (selector) rule[selector[1] as "name" | "path"] = keyParts(selector[2]!)[0];
        else if (enabled) rule.enabled = enabled[1] === "true";
        continue;
      }
    }
    multiline = leftOpen(line);
    if (multiline !== undefined) continue;
    const header = HEADER.exec(line);
    if (header) {
      table = keyParts(header[1]!);
      const [root, key, ...rest] = table;
      target = root === "mcp_servers" ? mcpServers : root === "plugins" ? plugins : undefined;
      name = target && key !== undefined && rest.length === 0 ? key : undefined;
      if (target && name !== undefined && !target.has(name)) target.set(name, true);
      continue;
    }
    if (!target) continue;
    if (name === undefined && table.length === 1) {
      // `[mcp_servers]` followed by `name = { ... }` lines.
      const entry = INLINE_ENTRY.exec(line);
      if (entry) target.set(keyParts(entry[1]!)[0]!, !INLINE_DISABLED.test(entry[2]!));
      continue;
    }
    if (name === undefined) continue;
    const enabled = ENABLED.exec(line);
    if (enabled) target.set(name, enabled[1] === "true");
  }
  // Codex ignores an entry with both selectors or neither; `enabled` is required.
  const skills = rules.flatMap((entry): SkillRule[] => {
    const name = entry.name?.trim();
    if (entry.enabled === undefined || (name ? entry.path !== undefined : !entry.path)) return [];
    return [
      name ? { name, enabled: entry.enabled } : { path: entry.path!, enabled: entry.enabled },
    ];
  });
  return { mcpServers, plugins, skills };
};

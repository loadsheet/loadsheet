/** What loadsheet reads from Codex's `config.toml`: table names and their `enabled` switch, nothing else. */
export interface CodexConfig {
  /** MCP server name to whether it is enabled. */
  readonly mcpServers: ReadonlyMap<string, boolean>;
  /** Plugin id (`plugin@marketplace`) to whether it is enabled. */
  readonly plugins: ReadonlyMap<string, boolean>;
}

const HEADER = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/u;
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
 * and `[plugins.*]` tables and whether each sets `enabled = false`; every value, command, token and
 * environment variable is skipped without being kept.
 */
export const readCodexConfig = (source: string): CodexConfig => {
  const mcpServers = new Map<string, boolean>();
  const plugins = new Map<string, boolean>();
  let table: string[] = [];
  let target: Map<string, boolean> | undefined;
  let name: string | undefined;
  let multiline: string | undefined;

  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    if (multiline !== undefined) {
      if (line.split(multiline).length % 2 === 0) multiline = undefined;
      continue;
    }
    const opens = /"""|'''/u.exec(line)?.[0];
    if (opens && line.split(opens).length % 2 === 0) {
      multiline = opens;
      continue;
    }
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
  return { mcpServers, plugins };
};

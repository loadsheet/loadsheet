import type { Fact, TranscriptFormat } from "@loadsheet/kit";

/** The user instruction file's item name: Codex loads `AGENTS.md` (or `AGENTS.override.md`) from its home. */
export const CODEX_INSTRUCTIONS = "~/.codex/AGENTS.md";

/** What the Codex reader remembers within one transcript: names, flags and hashes only. */
export interface CodexState {
  day?: string;
  via?: string;
  /** The first `session_meta` was read; later ones belong to the session a fork was copied from. */
  started: boolean;
  /** A fork or subagent whose copied history runs until its own first `task_started`. */
  copying: boolean;
  tokens: boolean;
  skills: boolean;
  instructions: boolean;
  mcp: boolean;
  /** Each listed skill: its name, a hash of its root, and its path in that root when not `<folder>/SKILL.md`. */
  listed: [name: string, root: string, rel?: string][];
  /** Listed MCP server names, as their namespace after `mcp__`. */
  servers: string[];
  /** Skills used in the current turn, by either side. */
  turn: string[];
}

const LOCATOR_KINDS = "file|executor package|cloud package|custom resource";
const SKILL_LINE = new RegExp(`^- (.+?): (?:(.*) )?\\((?:${LOCATOR_KINDS}): (.+)\\)$`, "u");
const ROOT_LINE = /^- `(r\d+)` = `(.+)`$/u;
const SKILL_REF = /[^\s"'`()<>;|&=\\]*SKILL\.md/gu;
const MCP_REF = /\bmcp__([A-Za-z0-9_-]+)/gu;
const USER_SKILL = /^<skill>\n<name>([^<\n]+)<\/name>/u;
const PROJECT_DOC = "\n\n--- project-doc ---\n\n";
const INSTRUCTIONS_OPEN = "<INSTRUCTIONS>\n";
const INSTRUCTIONS_CLOSE = "\n</INSTRUCTIONS>";

/** A short, non-reversible tag for a skill root, so State can match paths without holding one. */
const rootHash = (root: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < root.length; index += 1) {
    hash ^= root.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

const trimSlash = (path: string) => path.replace(/\/+$/u, "");
const baseOf = (name: string) => name.slice(name.lastIndexOf(":") + 1);

/** Expands the first `{a,b}` group of a path, recursively; a path without one is itself. */
const expandBraces = (path: string): string[] => {
  const match = /\{([^{}]*)\}/u.exec(path);
  if (!match) return [path];
  const head = path.slice(0, match.index);
  const tail = path.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((part) => expandBraces(head + part + tail));
};

const isoDay = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString().slice(0, 10);
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The texts of a `response_item` message's content parts. */
const texts = (payload: Record<string, unknown>): string[] =>
  Array.isArray(payload.content)
    ? payload.content.flatMap((part) => {
        const text = record(part)?.text;
        return typeof text === "string" ? [text] : [];
      })
    : [];

/**
 * The user's own part of an AGENTS.md fragment: all of it under a bare header, the text before
 * the project-doc separator under a `for <dir>` header, and nothing when a `for` header has no
 * separator (only project docs loaded).
 */
const userInstructions = (text: string, forDirectory: boolean): string => {
  if (!forDirectory) return text;
  const separator = text.indexOf(PROJECT_DOC);
  return separator === -1 ? "" : text.slice(0, separator);
};

const instructionsFromFragment = (fragment: string): string | undefined => {
  const header = /^# AGENTS\.md instructions( for [^\n]*)?\n\n/u.exec(fragment);
  if (!header) return undefined;
  const open = fragment.indexOf(INSTRUCTIONS_OPEN, header[0].length);
  const close = fragment.lastIndexOf(INSTRUCTIONS_CLOSE);
  if (open === -1 || close < open) return undefined;
  return userInstructions(fragment.slice(open + INSTRUCTIONS_OPEN.length, close), !!header[1]);
};

/** Reads the skills section's lines into State and returns one `listed` per skill. */
const readSkillListing = (body: string, state: CodexState, emit: (fact: ListedInput) => void) => {
  const lines = body.split("\n");
  const roots = new Map<string, string>();
  for (const line of lines) {
    const root = ROOT_LINE.exec(line);
    if (root) roots.set(root[1]!, trimSlash(root[2]!));
  }
  // A name in two roots (a repo's and the user's) is listed twice: one Fact carries both lines.
  const chars = new Map<string, { chars: number; bare: boolean }>();
  for (const line of lines) {
    const match = SKILL_LINE.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const known = chars.get(name);
    chars.set(name, {
      chars: (known?.chars ?? 0) + line.length + 1,
      bare: (known?.bare ?? true) && !match[2],
    });
    const locator = match[3]!;
    const slash = locator.indexOf("/");
    const alias = slash === -1 ? undefined : roots.get(locator.slice(0, slash));
    let root: string;
    let rel: string;
    if (alias !== undefined) {
      root = alias;
      rel = locator.slice(slash + 1);
    } else {
      // An unaliased locator is the whole path: its root is above the skill's folder.
      const parts = locator.split("/");
      root = parts.slice(0, -2).join("/");
      rel = parts.slice(-2).join("/");
    }
    const entry: CodexState["listed"][number] = [name, rootHash(root)];
    if (rel !== `${baseOf(name)}/SKILL.md`) entry.push(rel);
    state.listed.push(entry);
  }
  for (const [name, listed] of chars) emit({ item: `skill:${name}`, ...listed });
};

interface ListedInput {
  item: string;
  chars: number;
  bare: boolean;
}

/** The listed skill a `SKILL.md` path names, by its root's hash, else by a unique `<rel>` suffix. */
const skillAt = (path: string, state: CodexState): string | undefined => {
  const relOf = (entry: CodexState["listed"][number]) => entry[2] ?? `${baseOf(entry[0])}/SKILL.md`;
  for (let index = path.indexOf("/", 1); index !== -1; index = path.indexOf("/", index + 1)) {
    const hash = rootHash(path.slice(0, index));
    const rest = path.slice(index + 1);
    const found = state.listed.find((entry) => entry[1] === hash && relOf(entry) === rest);
    if (found) return found[0];
  }
  const candidates = new Set(
    state.listed
      .filter((entry) => path === relOf(entry) || path.endsWith(`/${relOf(entry)}`))
      .map((entry) => entry[0]),
  );
  return candidates.size === 1 ? [...candidates][0] : undefined;
};

/** The listed MCP server a `mcp__…` token names: the longest listed name it starts with. */
const serverOf = (token: string, state: CodexState): string | undefined => {
  let best: string | undefined;
  for (const server of state.servers) {
    if (
      (token === server || token.startsWith(`${server}__`)) &&
      server.length > (best?.length ?? -1)
    ) {
      best = server;
    }
  }
  return best;
};

const toolText = (payload: Record<string, unknown>): string | undefined => {
  const value = payload.type === "custom_tool_call" ? payload.input : payload.arguments;
  return typeof value === "string" ? value : undefined;
};

/**
 * Codex's rollout JSONL (`~/.codex/sessions/**`). Each session opens with `session_meta`; its
 * listing is a developer message, or a `world_state` line in newer versions; a skill the user
 * mentions with `$name` comes in as a `<skill>` message; the model opens a skill by reading its
 * `SKILL.md` through a tool, since Codex has no Skill tool.
 */
export const codexTranscripts: TranscriptFormat<CodexState> = {
  markers: [
    '"session_meta"',
    '"world_state"',
    "<skills_instructions>",
    "# AGENTS.md instructions",
    "<tools>",
    '"token_count"',
    '"task_started"',
    '"custom_tool_call"',
    '"function_call"',
    "<skill>",
    '"turn_context"',
  ],
  initial: () => ({
    started: false,
    copying: false,
    tokens: false,
    skills: false,
    instructions: false,
    mcp: false,
    listed: [],
    servers: [],
    turn: [],
  }),
  parse(line, state) {
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(line));
    } catch {
      return [];
    }
    const payload = record(value?.payload);
    if (!value || !payload) return [];
    const facts: Fact[] = [];

    if (value.type === "session_meta") {
      if (state.started) return [];
      const day = isoDay(payload.timestamp) ?? isoDay(value.timestamp);
      if (day === undefined) return [];
      const source = payload.source;
      const via =
        typeof payload.originator === "string" && payload.originator
          ? payload.originator
          : typeof source === "string" && source
            ? source
            : record(source)?.subagent !== undefined
              ? "subagent"
              : "unknown";
      state.started = true;
      state.day = day;
      state.via = via;
      state.copying =
        typeof payload.forked_from_id === "string" || record(source)?.subagent !== undefined;
      const version = payload.cli_version;
      return [
        {
          type: "session",
          day,
          via,
          ...(typeof version === "string" && version ? { version } : {}),
        },
      ];
    }
    if (state.day === undefined || state.via === undefined) return [];
    const { day, via } = state;
    const listed = (fact: ListedInput) => facts.push({ type: "listed", day, via, ...fact });

    const readSkills = (body: string) => {
      if (state.skills) return;
      state.skills = true;
      readSkillListing(body, state, listed);
    };
    const readInstructions = (text: string | undefined) => {
      if (state.instructions || text === undefined) return;
      state.instructions = true;
      if (text.length > 0) {
        listed({ item: `instructions:${CODEX_INSTRUCTIONS}`, chars: text.length, bare: false });
      }
    };
    const readServers = (servers: [name: string, chars: number][]) => {
      if (state.mcp) return;
      state.mcp = true;
      for (const [name, chars] of servers) {
        if (state.servers.includes(name)) continue;
        state.servers.push(name);
        listed({ item: `mcp:${name}`, chars, bare: false });
      }
    };

    if (value.type === "world_state") {
      const world = record(payload.state);
      const body = record(world?.host_skills)?.body;
      if (typeof body === "string") readSkills(body);
      const agents = record(world?.agents_md);
      if (typeof agents?.text === "string") {
        readInstructions(userInstructions(agents.text, !!agents.directory));
      }
      const tools = record(world?.tools);
      if (tools) {
        readServers(
          Object.entries(tools).flatMap(([namespace, description]) =>
            namespace.startsWith("mcp__")
              ? [
                  [
                    namespace.slice(5),
                    `- ${namespace}${typeof description === "string" && description ? `: ${description}` : ""}\n`
                      .length,
                  ] as [string, number],
                ]
              : [],
          ),
        );
      }
      return facts;
    }

    if (value.type === "turn_context") {
      state.turn = [];
      return [];
    }

    if (value.type === "event_msg") {
      if (payload.type === "task_started") state.copying = false;
      if (payload.type !== "token_count" || state.tokens || state.copying) return [];
      const usage = record(record(payload.info)?.last_token_usage);
      const tokens = usage?.input_tokens;
      if (typeof tokens === "number" && tokens > 0) {
        state.tokens = true;
        facts.push({ type: "tokens", day, via, tokens });
      }
      return facts;
    }

    if (value.type !== "response_item") return [];

    if (payload.type === "message") {
      for (const text of texts(payload)) {
        if (payload.role === "developer" && text.startsWith("<skills_instructions>")) {
          readSkills(text);
        } else if (payload.role === "developer" && text.startsWith("<tools>\n")) {
          readServers(
            text.split("\n").flatMap((entry) => {
              const match = /^- mcp__([^:\s]+)(?:: .*)?$/u.exec(entry);
              return match ? [[match[1]!, entry.length + 1] as [string, number]] : [];
            }),
          );
        } else if (payload.role === "user" && text.startsWith("# AGENTS.md instructions")) {
          readInstructions(instructionsFromFragment(text));
        } else if (payload.role === "user" && !state.copying) {
          const name = USER_SKILL.exec(text)?.[1];
          if (name !== undefined && !state.turn.includes(name)) {
            state.turn.push(name);
            facts.push({ type: "used", day, via, item: `skill:${name}`, by: "user" });
          }
        }
      }
      return facts;
    }

    if (payload.type !== "custom_tool_call" && payload.type !== "function_call") return [];
    if (state.copying || payload.name === "apply_patch") return [];
    const text = toolText(payload) ?? "";
    for (const reference of text.match(SKILL_REF) ?? []) {
      for (const path of expandBraces(reference)) {
        const name = skillAt(path, state);
        if (name === undefined || state.turn.includes(name)) continue;
        state.turn.push(name);
        facts.push({ type: "used", day, via, item: `skill:${name}`, by: "model" });
      }
    }
    const servers = new Set<string>();
    const namespace = payload.namespace;
    if (typeof namespace === "string" && namespace.startsWith("mcp__")) {
      const server = serverOf(namespace.slice(5), state);
      if (server !== undefined) servers.add(server);
    }
    const tokens = [text, typeof payload.name === "string" ? payload.name : ""];
    for (const source of tokens) {
      for (const match of source.matchAll(MCP_REF)) {
        const server = serverOf(match[1]!, state);
        if (server !== undefined) servers.add(server);
      }
    }
    for (const server of servers) {
      facts.push({ type: "used", day, via, item: `mcp:${server}`, by: "model" });
    }
    return facts;
  },
};

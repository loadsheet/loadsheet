import {
  repoOfRemote,
  type Fact,
  type LineBytes,
  type Place,
  type TranscriptFormat,
} from "@loadsheet/kit";
import { projectOfCwd } from "./path.ts";

/** The thread id in a rollout's name, `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl`. */
export const codexSessionId = (path: string): string | undefined =>
  /(?:^|\/)rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-([^/]+?)\.jsonl(?:\.zst)?$/u.exec(path)?.[1];

/** The user instruction file's item name: Codex loads `AGENTS.md` (or `AGENTS.override.md`) from its home. */
export const CODEX_INSTRUCTIONS = "~/.codex/AGENTS.md";

/** What the Codex reader remembers within one transcript: names, flags, counters and hashes only. */
export interface CodexState {
  day?: string;
  via?: string;
  /** The first `session_meta` was read; later ones belong to the session a fork was copied from. */
  started: boolean;
  /** A fork or subagent whose copied history runs until its own first `task_started`. */
  copying: boolean;
  /**
   * When the session began, in whole seconds since the epoch. A copied `task_started` started
   * before it; the session's own first one starts at or after it. One that does not say when it
   * started counts as copied, which leaves a fork unmeasured sooner than measured as its parent.
   */
  since?: number;
  tokens: boolean;
  skills: boolean;
  instructions: boolean;
  mcp: boolean;
  /** Each listed skill: its name, a hash of its root, and a hash of its path in that root when not `<folder>/SKILL.md`. */
  listed: [name: string, root: string, rel?: string][];
  /** Listed MCP server names, as their namespace after `mcp__`. */
  servers: string[];
  /** Skills used in the current turn, by either side. */
  turn: string[];
  /** Whether the session is a subagent's conversation. */
  thread?: "main" | "subagent";
  /** The project, as a usage Fact names it: `owner/repo`, `~/...`, an absolute path outside the home, or `unknown`. */
  project?: string;
  /** The model the latest `turn_context` named. */
  model?: string;
  /**
   * The thread's running token totals the latest `token_count` gave, as input, cached input, cache
   * write, output and reasoning: each request's tokens are the step from one to the next.
   */
  totals?: number[];
  /** The session compacted its context at least once. */
  compacted?: boolean;
}

const LOCATOR_KINDS = "file|executor package|cloud package|custom resource";
const SKILL_LINE = new RegExp(`^- (.+?): (?:(.*) )?\\((?:${LOCATOR_KINDS}): (.+)\\)$`, "u");
const ROOT_LINE = /^- `(r\d+)` = `(.+)`$/u;
// A match starts only where a path can: tried from inside a long word, the scan would run to the
// word's end from each of its characters.
const SKILL_REF = /(?<![^\s"'`()<>;|&=\\])[^\s"'`()<>;|&=\\]*SKILL\.md/gu;
const MCP_REF = /\bmcp__([A-Za-z0-9_-]+)/gu;
/** The whole fragment Codex injects for a `$skill` mention, tags and all. */
const USER_SKILL =
  /^<skill>\n<name>([^<\n]+)<\/name>\n<path>[^<\n]+<\/path>(?:\n<resource_access>[^\n]*<\/resource_access>)?\n[\s\S]*\n<\/skill>$/u;
/** A name Codex takes for a skill: words with single spaces between them, and no markup, path or invisible characters. */
const SKILL_NAME = /^(?=.{1,128}$)[^\s<>/\\\p{C}]+(?: [^\s<>/\\\p{C}]+)*$/u;
/** The tool whose input is code that can call MCP tools; shell tools are never scanned for `mcp__`. */
const CODE_TOOL = "exec";
/** An originator or source such as `codex_cli_rs` or `T3 Code`; anything else is not kept. */
const CLIENT = /^(?=.{1,64}$)[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*$/u;

const client = (text: unknown) =>
  typeof text === "string" && CLIENT.test(text) ? text : undefined;

/**
 * A Codex session's `via`: the client that started it (`originator`), else its source when that
 * is a plain name, else `subagent` for a spawned subagent, else `unknown`. The rollouts and the
 * state database read it the same way.
 */
export const codexVia = (originator: unknown, source: unknown, spawned: boolean): string =>
  client(originator) ?? client(source) ?? (spawned ? "subagent" : "unknown");
const VERSION = /^[A-Za-z0-9_.+-]{1,32}$/u;
/** A model name such as `gpt-6.1-sol`; anything else counts as `unknown`. */
const MODEL = /^[A-Za-z0-9_.:@+/-]{1,64}$/u;
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
 * The item name of every project `AGENTS.md` a session loads, root and nested together. No folder
 * or project name goes in it.
 */
const PROJECT_INSTRUCTIONS = "project/AGENTS.md";

interface Instructions {
  user: string;
  project: string;
}

/**
 * An AGENTS.md fragment's two parts. A bare header holds only the user's file. Under a
 * `for <dir>` header the user's file comes before the project-doc separator and the project's
 * files after it; with no separator, only project docs loaded.
 */
const splitInstructions = (text: string, forDirectory: boolean): Instructions => {
  if (!forDirectory) return { user: text, project: "" };
  const separator = text.indexOf(PROJECT_DOC);
  return separator === -1
    ? { user: "", project: text }
    : { user: text.slice(0, separator), project: text.slice(separator + PROJECT_DOC.length) };
};

const instructionsFromFragment = (fragment: string): Instructions | undefined => {
  const header = /^# AGENTS\.md instructions( for [^\n]*)?\n\n/u.exec(fragment);
  if (!header) return undefined;
  const open = fragment.indexOf(INSTRUCTIONS_OPEN, header[0].length);
  const close = fragment.lastIndexOf(INSTRUCTIONS_CLOSE);
  if (open === -1 || close < open) return undefined;
  return splitInstructions(fragment.slice(open + INSTRUCTIONS_OPEN.length, close), !!header[1]);
};

/** A section's text up to its first closing tag, or undefined when it has none. */
const section = (text: string, close: string): string | undefined => {
  const end = text.indexOf(close);
  return end === -1 ? undefined : text.slice(0, end);
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
    // Codex writes a skill's name and description on one line, so a line whose name is not a
    // skill's name is other text, such as a description's second line holding a path.
    if (!match || !SKILL_NAME.test(match[1]!)) continue;
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
    if (rel !== `${baseOf(name)}/SKILL.md`) entry.push(rootHash(rel));
    state.listed.push(entry);
  }
  for (const [name, listed] of chars) emit({ item: `skill:${name}`, ...listed });
};

interface ListedInput {
  item: string;
  chars: number;
  bare: boolean;
}

/**
 * The listed skill a `SKILL.md` path names, by its root's hash. A path that is not absolute (relative,
 * `~` or `$VAR`) may also name one by a unique `<rel>` suffix.
 */
const skillAt = (path: string, state: CodexState): string | undefined => {
  const relOf = (entry: CodexState["listed"][number]) =>
    entry[2] ?? rootHash(`${baseOf(entry[0])}/SKILL.md`);
  for (let index = path.indexOf("/", 1); index !== -1; index = path.indexOf("/", index + 1)) {
    const hash = rootHash(path.slice(0, index));
    const rest = rootHash(path.slice(index + 1));
    const found = state.listed.find((entry) => entry[1] === hash && relOf(entry) === rest);
    if (found) return found[0];
  }
  if (path.startsWith("/")) return undefined;
  const suffixes = new Set([rootHash(path)]);
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
    suffixes.add(rootHash(path.slice(index + 1)));
  }
  const candidates = new Set(
    state.listed.filter((entry) => suffixes.has(relOf(entry))).map((entry) => entry[0]),
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

/** The line types `parse` reads; it returns nothing for any other. */
const READ = new Set([
  "session_meta",
  "world_state",
  "turn_context",
  "event_msg",
  "response_item",
  "compacted",
]);
const HEAD_BYTES = 256;
const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN = 0x7b;
const CLOSE = 0x7d;
const isSpace = (code: number) => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
const skipSpace = (text: string, at: number) => {
  while (at < text.length && isSpace(text.charCodeAt(at))) at += 1;
  return at;
};
/** Where the string token at `at` closes, escapes and all; -1 when it is none or does not close. */
const stringEnd = (text: string, at: number) => {
  if (text.charCodeAt(at) !== QUOTE) return -1;
  for (let close = text.indexOf('"', at + 1); close !== -1; close = text.indexOf('"', close + 1)) {
    let escapes = 0;
    while (text.charCodeAt(close - 1 - escapes) === BACKSLASH) escapes += 1;
    if (escapes % 2 === 0) return close;
  }
  return -1;
};
/** The string token from `at` to `close`, when it holds no escapes. */
const plain = (text: string, at: number, close: number) => {
  const value = text.slice(at + 1, close);
  return value.includes("\\") ? undefined : value;
};

/**
 * Reads the object at `open` member by member, keeping the plain string values of the `wanted`
 * keys, until `enough` says so, a member it cannot read, or the first object or array member.
 * Returns that member's key and where its value starts.
 */
const leading = (
  text: string,
  open: number,
  wanted: ReadonlySet<string>,
  into: Map<string, string>,
  enough: (into: Map<string, string>) => boolean,
): { key: string; at: number } | undefined => {
  let at = open;
  for (;;) {
    at = skipSpace(text, at + 1);
    const keyEnd = stringEnd(text, at);
    const key = keyEnd === -1 ? undefined : plain(text, at, keyEnd);
    if (key === undefined) return undefined;
    at = skipSpace(text, keyEnd + 1);
    if (text.charCodeAt(at) !== COLON) return undefined;
    at = skipSpace(text, at + 1);
    const first = text.charCodeAt(at);
    if (first === OPEN || first === 0x5b) return { key, at };
    if (first === QUOTE) {
      const close = stringEnd(text, at);
      if (close === -1) return undefined;
      if (wanted.has(key)) {
        const value = plain(text, at, close);
        if (value !== undefined) into.set(key, value);
        if (enough(into)) return undefined;
      }
      at = close + 1;
    } else {
      while (at < text.length) {
        const code = text.charCodeAt(at);
        if (code === COMMA || code === CLOSE || isSpace(code)) break;
        at += 1;
      }
    }
    at = skipSpace(text, at);
    if (text.charCodeAt(at) !== COMMA) return undefined;
  }
};

interface Head {
  /** The line's `type`, when a plain string member before its first object. */
  type?: string;
  /** The payload's `type`, and its `role` or `name`, when plain string members before its first object. */
  payload: Map<string, string>;
}

const TOP = new Set(["type"]);
const PAYLOAD = new Set(["type", "role", "name"]);
const never = () => false;
/** Read until the payload's type, and a message's role or a call's name, are known. */
const known = (payload: Map<string, string>) => {
  const kind = payload.get("type");
  if (kind === "message") return payload.has("role");
  if (kind === "custom_tool_call" || kind === "function_call") return payload.has("name");
  return kind !== undefined;
};

/** What a line's first members say: Codex writes `type` before `payload`, and a payload's `type` first. */
const readHead = (text: string): Head => {
  const top = new Map<string, string>();
  const payload = new Map<string, string>();
  const start = skipSpace(text, 0);
  if (text.charCodeAt(start) !== OPEN) return { payload };
  const next = leading(text, start, TOP, top, never);
  if (next?.key === "payload" && text.charCodeAt(next.at) === OPEN) {
    leading(text, next.at, PAYLOAD, payload, known);
  }
  return { type: top.get("type"), payload };
};

/** A message does something only through these fragments, each until its part of State is set. */
const quietMessage = (line: LineBytes, state: CodexState, role: string | undefined) => {
  const developer =
    (state.skills || !line.includes("<skills_instructions>")) &&
    (state.mcp || !line.includes("<tools>"));
  if (role === "developer") return developer;
  const user =
    (state.instructions || !line.includes("# AGENTS.md instructions")) &&
    (state.copying || !line.includes("<skill>"));
  if (role === "user") return user;
  return role !== undefined || (developer && user);
};

/** A tool call does something only when it names a listed skill's `SKILL.md` or a listed server. */
const quietCall = (line: LineBytes, state: CodexState, name: string | undefined) =>
  state.copying ||
  name === "apply_patch" ||
  ((state.listed.length === 0 || !line.includes("SKILL.md")) &&
    (state.servers.length === 0 || !line.includes("mcp__")));

/**
 * True only when `parse` would return no Facts and leave `state` as it is. Reads the line's first
 * members, and searches the whole line only for strings whose absence settles it. It assumes, as
 * Codex's writer (serde_json) guarantees, no duplicate keys and no escaped printable ASCII; a line
 * that is not JSON is a no-op either way.
 */
const skip = (line: LineBytes, state: CodexState): boolean => {
  const head = readHead(line.slice(0, HEAD_BYTES));
  const { type } = head;
  if (type === undefined) return false;
  if (!READ.has(type)) return true;
  if (type === "session_meta") return state.started;
  if (state.day === undefined || state.via === undefined) return true;
  // A copied compaction is the parent's; a `turn_context` may name a new model.
  if (type === "compacted") return state.copying;
  if (type === "turn_context") return false;
  if (type === "world_state") {
    return (
      (state.skills || !line.includes('"host_skills"')) &&
      (state.instructions || !line.includes('"agents_md"')) &&
      (state.mcp || !line.includes('"tools"'))
    );
  }
  const kind = head.payload.get("type");
  const is = (name: string) => (kind === undefined ? line.includes(`"${name}"`) : kind === name);
  if (type === "event_msg") {
    // Every `token_count` moves the running totals, a copied one too.
    return (!state.copying || !is("task_started")) && !is("token_count");
  }
  const message = kind === undefined || kind === "message";
  const call = kind === undefined || kind === "custom_tool_call" || kind === "function_call";
  return (
    (!message || quietMessage(line, state, head.payload.get("role"))) &&
    (!call || quietCall(line, state, head.payload.get("name")))
  );
};

/**
 * The project a session ran in: the `owner/repo` of the git remote Codex recorded, else its
 * working directory keyed as the Files keys paths (`~/...` under the home, absolute elsewhere).
 */
const projectOf = (payload: Record<string, unknown>, place: Place | undefined): string => {
  const url = record(payload.git)?.repository_url;
  const repo = typeof url === "string" ? repoOfRemote(url) : undefined;
  return repo ?? projectOfCwd(payload.cwd, place);
};

/** A count Codex wrote: a whole number of 0 or more. */
const counted = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

/** A usage object as `totals` keeps it: input, cached input, cache write, output, reasoning. */
const usageOf = (value: unknown): number[] | undefined => {
  const usage = record(value);
  if (usage === undefined) return undefined;
  return [
    counted(usage.input_tokens),
    counted(usage.cached_input_tokens),
    counted(usage.cache_write_input_tokens),
    counted(usage.output_tokens),
    counted(usage.reasoning_output_tokens),
  ];
};

/**
 * The tokens of the requests since the last `token_count`: the step of the running totals. Totals
 * that went back (a thread that started counting again) count as they are, by the event's own
 * `last_token_usage` when it has one, as ccusage counts them. An event without totals counts its
 * `last_token_usage`; one whose totals did not move counts nothing.
 */
const stepOf = (info: Record<string, unknown>, state: CodexState): number[] | undefined => {
  const total = usageOf(info.total_token_usage);
  const last = usageOf(info.last_token_usage);
  if (total === undefined) return last;
  const previous = state.totals ?? [0, 0, 0, 0, 0];
  state.totals = total;
  if (total.every((count, index) => count === previous[index])) return undefined;
  if (total.some((count, index) => count < previous[index]!)) return last ?? total;
  return total.map((count, index) => count - previous[index]!);
};

/**
 * A `compacted` line: the session's own compaction, not one a fork copied from its parent. Codex
 * writes no trigger, and a `/compact` leaves the same line as an automatic compaction, so none
 * counts as the user's.
 */
const compaction = (state: CodexState): Fact[] => {
  const { day, via } = state;
  if (day === undefined || via === undefined || state.copying) return [];
  const first = !state.compacted;
  state.compacted = true;
  return [
    {
      type: "compaction",
      day,
      via,
      project: state.project ?? "unknown",
      thread: state.thread ?? "main",
      manual: false,
      first,
    },
  ];
};

/**
 * Codex's rollout JSONL (`~/.codex/sessions/**`). Each session opens with `session_meta`; its
 * listing is a developer message, or a `world_state` line in newer versions; a skill the user
 * mentions with `$name` comes in as a `<skill>` message; the model opens a skill by reading its
 * `SKILL.md` through a tool, since Codex has no Skill tool.
 *
 * Usage: each rollout is one conversation, a subagent's when its source says so. Its tokens are the
 * steps of `token_count`'s running totals, one Fact per step, by the model of the latest
 * `turn_context`. `token_usage_record` lines are not read: they repeat those steps, and are missing
 * from older rollouts. A fork or subagent first copies its parent's history, totals and
 * compactions included; none of the copy counts, only the steps after its own first task, as
 * ccusage skips a fork's replay.
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
    '"compacted"',
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
  skip,
  parse(line, state, place) {
    // A compaction's line holds the whole history it replaced, megabytes of it: only its type is read.
    if (readHead(line.slice(0, HEAD_BYTES)).type === "compacted") return compaction(state);
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(line));
    } catch {
      return [];
    }
    if (value?.type === "compacted") return compaction(state);
    const payload = record(value?.payload);
    if (!value || !payload) return [];
    const facts: Fact[] = [];

    if (value.type === "session_meta") {
      if (state.started) return [];
      const stamp = isoDay(payload.timestamp) ? payload.timestamp : value.timestamp;
      const day = isoDay(stamp);
      if (day === undefined) return [];
      const source = payload.source;
      const via = codexVia(payload.originator, source, record(source)?.subagent !== undefined);
      state.started = true;
      state.day = day;
      state.via = via;
      state.copying =
        typeof payload.forked_from_id === "string" || record(source)?.subagent !== undefined;
      state.since = Math.floor(Date.parse(stamp as string) / 1000);
      const thread =
        record(source)?.subagent !== undefined || payload.thread_source === "subagent"
          ? "subagent"
          : "main";
      const project = projectOf(payload, place);
      state.thread = thread;
      state.project = project;
      const version = payload.cli_version;
      return [
        {
          type: "session",
          day,
          via,
          ...(typeof version === "string" && VERSION.test(version) ? { version } : {}),
        },
        { type: "usage-session", day, via, project, thread },
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
    const readInstructions = (parts: Instructions | undefined) => {
      if (state.instructions || parts === undefined) return;
      state.instructions = true;
      if (parts.user.length > 0) {
        listed({
          item: `instructions:${CODEX_INSTRUCTIONS}`,
          chars: parts.user.length,
          bare: false,
        });
      }
      if (parts.project.length > 0) {
        listed({
          item: `instructions:${PROJECT_INSTRUCTIONS}`,
          chars: parts.project.length,
          bare: false,
        });
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
        readInstructions(splitInstructions(agents.text, !!agents.directory));
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
      const model = payload.model;
      if (typeof model === "string" && MODEL.test(model)) state.model = model;
      return [];
    }

    if (value.type === "event_msg") {
      // A fork's copy holds the parent's `task_started` events too, all started before the fork.
      if (
        payload.type === "task_started" &&
        typeof payload.started_at === "number" &&
        state.since !== undefined &&
        payload.started_at >= state.since
      ) {
        state.copying = false;
      }
      if (payload.type !== "token_count") return [];
      const info = record(payload.info);
      // A copy's totals are the parent's: the fork's own steps start from them.
      const step = info === undefined ? undefined : stepOf(info, state);
      const requestDay = isoDay(value.timestamp);
      if (step !== undefined && !state.copying && requestDay !== undefined) {
        const [input = 0, cached = 0, write = 0, output = 0, reasoning = 0] = step;
        const cacheRead = Math.min(cached, input);
        const cacheWrite = Math.min(write, input - cacheRead);
        if (input + output > 0) {
          facts.push({
            type: "usage-tokens",
            day: requestDay,
            via,
            project: state.project ?? "unknown",
            thread: state.thread ?? "main",
            model: state.model ?? "unknown",
            input: input - cacheRead - cacheWrite,
            output,
            reasoning: Math.min(reasoning, output),
            cacheRead,
            cacheWrite,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRewrite: 0,
          });
        }
      }
      if (state.tokens || state.copying) return facts;
      const tokens = record(info?.last_token_usage)?.input_tokens;
      if (typeof tokens === "number" && tokens > 0) {
        state.tokens = true;
        facts.push({ type: "tokens", day, via, tokens });
        // The model's context window rides on the same event.
        const window = info?.model_context_window;
        if (typeof window === "number" && Number.isSafeInteger(window) && window > 0)
          facts.push({ type: "window", day, via, tokens: window });
      }
      return facts;
    }

    if (value.type !== "response_item") return [];

    if (payload.type === "message") {
      for (const text of texts(payload)) {
        if (payload.role === "developer" && text.startsWith("<skills_instructions>")) {
          const body = section(text, "</skills_instructions>");
          if (body !== undefined) readSkills(body);
        } else if (payload.role === "developer" && text.startsWith("<tools>\n")) {
          const body = section(text, "</tools>");
          if (body === undefined) continue;
          readServers(
            body.split("\n").flatMap((entry) => {
              const match = /^- mcp__([A-Za-z0-9_-]+)(?:: .*)?$/u.exec(entry);
              return match ? [[match[1]!, entry.length + 1] as [string, number]] : [];
            }),
          );
        } else if (payload.role === "user" && text.startsWith("# AGENTS.md instructions")) {
          readInstructions(instructionsFromFragment(text));
        } else if (payload.role === "user" && !state.copying) {
          const name = USER_SKILL.exec(text)?.[1];
          if (name !== undefined && SKILL_NAME.test(name) && !state.turn.includes(name)) {
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
    for (const reference of text.includes("SKILL.md") ? (text.match(SKILL_REF) ?? []) : []) {
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
    const code = payload.type === "custom_tool_call" && payload.name === CODE_TOOL;
    const tokens = [code ? text : "", typeof payload.name === "string" ? payload.name : ""];
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

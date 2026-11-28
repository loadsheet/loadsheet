// How Claude Code's JSONL transcript lines become Facts. Line shapes were read from Claude Code
// 2.1 transcripts: `attachment` lines carry what a session listed, `assistant` lines the model's
// tool calls and usage, `user` lines slash commands, `system` lines compactions.
import {
  toolName,
  type Fact,
  type LineBytes,
  type TranscriptFormat,
  type TranscriptParent,
} from "@loadsheet/kit";
import type { Day, Id, Thread } from "@loadsheet/schema";
import { MCP_NAME, mcpToolName, NAME } from "./claude-code-machine.ts";
import { projectOfCwd } from "./path.ts";
import { SKILL_NAME } from "./skill-md.ts";

/**
 * What one transcript remembers between lines: the session's day, entrypoint and version, which
 * items it has listed, and names only. Plain JSON, saved in the cache.
 */
export interface ClaudeState {
  day?: Day;
  via?: string;
  version?: string;
  /** The session Fact was emitted. */
  started: boolean;
  /** The tokens Fact was emitted. */
  tokens: boolean;
  /** Ids already listed by this session. */
  listed: Record<Id, true>;
  /** Subagent types the session lists as built in. */
  builtIn: Record<string, true>;
  /** MCP servers seen in this turn's attachments, and their characters, until the turn starts. */
  mcp: Record<string, number>;
  knownMcp?: Partial<Record<Id, true>>;
  /** Project instruction ids seen in this turn's attachments, and their characters, likewise. */
  project: Record<Id, number>;
  /** A slash command whose expansion the next line should carry. */
  command?: string;
  /**
   * The folder the transcript started in, keyed as the Files keys paths (`~/...` under the home),
   * or `unknown`. Set with `day`.
   */
  folder?: string;
  /**
   * A hash of the message id of the last request counted. Claude Code writes one line per content
   * block, each with the message's usage, so a line with the same id repeats a request.
   */
  last?: string;
  /** The UTC minute, since the epoch, of the last request counted. */
  minute?: number;
  requestModel?: string;
  /** The conversation compacted at least once. */
  compacted?: boolean;
  /** Each thread's turn in progress, from its prompt on. */
  open?: Partial<Record<Thread, OpenTurn>>;
  /** A rate limit was hit and no request has gone through since. */
  limited?: boolean;
}

/** A turn in progress: what its later lines add to. */
interface OpenTurn {
  /** The UTC day the turn started, which its counters are keyed by. */
  day: Day;
  /** When its latest line counted was written, in ms since the epoch; absent when the prompt said no time. */
  end?: number;
  timed: boolean;
  subagents: boolean;
}

/**
 * Subagents every Claude Code ships; a subagent's own transcript has no listing to say so. `fork`
 * is the session forking itself, which no listing names.
 */
const BUILT_IN_AGENTS = [
  "general-purpose",
  "fork",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "output-style-setup",
];
/** Claude Code's placeholder model for messages that never reached the API. */
const SYNTHETIC_MODEL = "<synthetic>";
const COMMAND =
  /^\s*<command-message>[^<]*<\/command-message>\s*<command-name>\/?([^<]+)<\/command-name>/u;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * A message id's hash, two 32-bit FNV-1a hashes in hex: enough to tell a request from the one
 * before it, and nothing that names it. It hashes UTF-16 code units, which for the ASCII ids
 * Claude Code writes are the line's bytes, so `bytesHash` gives the same without decoding.
 */
const idHash = (text: string) => {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193);
  }
  return (a >>> 0).toString(16) + (b >>> 0).toString(16).padStart(8, "0");
};
/** `idHash` of the bytes from `start` to `end`. */
const bytesHash = (bytes: Uint8Array, start: number, end: number) => {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let index = start; index < end; index += 1) {
    const code = bytes[index]!;
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193);
  }
  return (a >>> 0).toString(16) + (b >>> 0).toString(16).padStart(8, "0");
};

const MINUTE_MS = 60_000;
/** A request this many minutes after the one before it found a 5-minute cache gone, and a 1-hour one not. */
const REWRITE_MINUTES = [5, 60] as const;

/** The server in a tool name `mcp__<server>__<tool>`. */
const mcpServer = (tool: string) => /^mcp__([A-Za-z0-9_-]{1,128}?)__./u.exec(tool)?.[1];

/** What Claude Code writes, as a user line, where the user stopped a turn. Only this prefix is read. */
const INTERRUPTED = "[Request interrupted by user";
const INTERRUPTED_TOKEN = '"interrupted"';
/** What a user line Claude Code writes for something other than a prompt starts with: no turn runs on through it. */
const NOT_PROMPTS = ["<task-notification>", "<bash-input>"];
const WRAPPERS = [
  ...NOT_PROMPTS,
  "<bash-stdout>",
  "<bash-stderr>",
  "<system-reminder>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
];
const PEER_MESSAGE = /^<teammate-message(?:\s|>)/u;
const BUILT_IN_TOOLS = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "ListMcpResourcesTool",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "SendMessage",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Write",
]);
const knownServer = (
  name: string,
  known: ClaudeState["knownMcp"],
  parent?: ReadonlySet<string>,
): string | undefined => {
  if (!name.startsWith("mcp__")) return undefined;
  for (let split = name.lastIndexOf("__"); split > 5; split = name.lastIndexOf("__", split - 1)) {
    const server = name.slice(5, split);
    if (split + 2 < name.length && (known?.[`mcp:${server}`] || parent?.has(server))) {
      return server;
    }
  }
  return undefined;
};

const instructionServer = (name: string): string | undefined => {
  const server = /[/\\]/u.test(name) ? "" : mcpToolName(name);
  return MCP_NAME.test(server) ? server : undefined;
};

const parent: TranscriptParent = {
  path: (child) => {
    const match = /^(.*)[/\\]subagents[/\\]agent-[^/\\]+\.jsonl(?:\.zst)?$/u.exec(child);
    return match ? `${match[1]}.jsonl` : undefined;
  },
  markers: ['"mcp_instructions_delta"', '"deferred_tools_delta"'],
  collect(line, names) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(record) || record.type !== "attachment" || !isRecord(record.attachment)) return;
    const { type, addedNames } = record.attachment;
    if (type === "mcp_instructions_delta" || type === "deferred_tools_delta") {
      for (const name of strings(addedNames)) {
        const server =
          type === "mcp_instructions_delta"
            ? instructionServer(name)
            : (knownServer(name, undefined, names) ?? mcpServer(name));
        if (server !== undefined) names.add(server);
      }
    }
  },
};
const TOOL_RESULT_TOKEN = '"tool_use_id"';
/** The system line Claude Code writes for each failed request it retries. */
const API_ERROR = "api_error";
const API_ERROR_TOKEN = '"api_error"';
/** The assistant line Claude Code writes for a request that failed for good. */
const API_ERROR_MESSAGE = '"isApiErrorMessage":true';
const RATE_LIMITED = 429;

/**
 * Whether a user line is a prompt the user wrote: not a tool's result, not a line Claude Code
 * wrote itself (meta, a compaction's summary, a notification, a peer's message), and not wrapped
 * in a tag such as `<system-reminder>` or `<command-message>`.
 */
const isPrompt = (record: Json) => {
  if (record.isMeta === true || record.isCompactSummary === true) return false;
  if (record.origin !== undefined || record.toolUseResult !== undefined) return false;
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  if (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && block.type === "tool_result")
  )
    return false;
  const text = userText(message);
  if (text === undefined) return Array.isArray(content) && content.length > 0;
  const start = text.trimStart();
  return (
    start.length > 0 &&
    !WRAPPERS.some((tag) => start.startsWith(tag)) &&
    !PEER_MESSAGE.test(start) &&
    !start.startsWith(INTERRUPTED)
  );
};

/** A line's UTC day and hour; undefined when it says no time. */
const momentOf = (time: number) => {
  if (Number.isNaN(time)) return undefined;
  const date = new Date(time);
  return { day: date.toISOString().slice(0, 10) as Day, hour: date.getUTCHours() };
};

/** Where an instruction id names a project's file. */
const PROJECT = "project/";

/**
 * An instruction file's name: `CLAUDE.md` and `rules/...` for the user's own, as the machine
 * inventory names them; the same under `managed/` for a managed policy's; `memory/MEMORY.md` for every project's auto memory; and for any project's
 * file, the home directory's included, `project/` and its file name, or `project/rules/` and its
 * file name for a rule under `.claude/rules`. No folder gets in: every worktree would be an id of
 * its own, and its name is the user's.
 */
export const instructionName = (path: string, type: string): string | undefined => {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const file = parts.at(-1);
  if (!file) return undefined;
  if (type === "AutoMem") return `memory/${file}`;
  if (type === "User" || type === "Managed") {
    const rules = parts.lastIndexOf("rules");
    const name = rules !== -1 && rules < parts.length - 1 ? parts.slice(rules).join("/") : file;
    return type === "Managed" ? `managed/${name}` : name;
  }
  const dot = parts.lastIndexOf(".claude");
  if (dot !== -1 && parts[dot + 1] === "rules" && dot + 2 < parts.length) {
    return `${PROJECT}rules/${file}`;
  }
  return PROJECT + file;
};

/**
 * Each skill the listing names and the entry it got: `- name: description` or, past the
 * listing's budget, the bare `- name`. Entries follow `names`, one per line.
 */
const skillEntries = (names: readonly string[], content: string) => {
  const starts: { name: string; at: number }[] = [];
  let cursor = 0;
  for (const name of names) {
    const needle = `- ${name}`;
    let at = content.startsWith(needle, cursor) ? cursor : content.indexOf(`\n${needle}`, cursor);
    if (at === -1) continue;
    if (at !== cursor || !content.startsWith(needle, at)) at += 1;
    const after = content[at + needle.length];
    if (after !== undefined && after !== ":" && after !== "\n") continue;
    starts.push({ name, at });
    cursor = at + needle.length;
  }
  return starts.map(({ name, at }, index) => {
    const next = starts[index + 1];
    const entry = content
      .slice(at, next === undefined ? content.length : next.at - 1)
      .replace(/\n+$/u, "");
    return { name, chars: entry.length + 1, bare: entry === `- ${name}` };
  });
};

/** The text a user line starts with: its string content, or its first text block. */
const userText = (message: unknown) => {
  if (!isRecord(message)) return undefined;
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const first = content.find((block) => isRecord(block) && block.type === "text");
  return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
};

/** The line types `parse` reads; it returns nothing for any other. */
const READ = ["user", "assistant", "attachment", "system"];
/** The attachment types `parse` reads; any other attachment is a no-op. */
const LISTINGS = [
  "skill_listing",
  "agent_listing_delta",
  "mcp_instructions_delta",
  "deferred_tools_delta",
  "instructions",
];
const quoted = (name: string) => `"${name}"`;
const READ_TOKENS = new Map(READ.map((type) => [type, quoted(type)]));
const LISTING_TOKENS = LISTINGS.map(quoted);
/**
 * A string a line is searched for, and a part of it that starts with a byte JSON lines hold less
 * often. A search skips ahead to its needle's first byte, so the part's search runs several times
 * faster, and the whole string is searched for only in lines that hold the part.
 */
type Needle = readonly [whole: string, part: string];
const holds = (line: LineBytes, [whole, part]: Needle) =>
  line.includes(part) && line.includes(whole);
/** A tool_use block's type. */
const TOOL_USE: Needle = ['"tool_use"', '_use"'];
/** What a slash command's text starts with. It starts with `<`, a byte JSON lines seldom hold. */
const COMMAND_MESSAGE = "<command-message>";
/** The subtype of the system line Claude Code writes where it compacted the conversation. */
const COMPACT_BOUNDARY = "compact_boundary";
const COMPACT_TOKEN = quoted(COMPACT_BOUNDARY);
const USAGE = '"usage"';
const HEAD_BYTES = 512;
const TAIL_BYTES = 1024;

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN = 0x7b;
const CLOSE = 0x7d;
const isSpace = (code: number | undefined) =>
  code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
/** The first index from `at` on that is not JSON whitespace. */
const skipSpace = (bytes: Uint8Array, at: number) => {
  while (at < bytes.length && isSpace(bytes[at])) at += 1;
  return at;
};
/** Whether the bytes from `at` on are `ascii`'s. */
const holdsAt = (bytes: Uint8Array, at: number, ascii: string) => {
  if (at < 0 || at + ascii.length > bytes.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[at + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
};
/** Where the string token at `at` closes when it has no escapes; -1 when it has or does not close. */
const plainEnd = (bytes: Uint8Array, at: number) => {
  if (bytes[at] !== QUOTE) return -1;
  for (let index = at + 1; index < bytes.length; index += 1) {
    const code = bytes[index];
    if (code === QUOTE) return index;
    if (code === BACKSLASH) return -1;
  }
  return -1;
};
/** Whether the plain string token from `at` to `close` is `name`. */
const isToken = (bytes: Uint8Array, at: number, close: number, name: string) =>
  close - at - 1 === name.length && holdsAt(bytes, at + 1, name);
/** A string token that is none of the names it was compared with. */
const OTHER = "";
/** Which of `names` the plain string token from `at` to `close` is, else OTHER. */
const tokenIn = (bytes: Uint8Array, at: number, close: number, names: readonly string[]) => {
  for (const name of names) if (isToken(bytes, at, close, name)) return name;
  return OTHER;
};
/**
 * Where the string token at `at` closes, escapes and all; -1 when it does not in `bytes`. Loops
 * here and below read bytes one by one: a search method call costs more than the few bytes it
 * would pass over.
 */
const stringEnd = (bytes: Uint8Array, at: number) => {
  for (let close = at + 1; close < bytes.length; close += 1) {
    const code = bytes[close];
    if (code === BACKSLASH) close += 1;
    else if (code === QUOTE) return close;
  }
  return -1;
};
/** Where the number or literal at `at` ends: at whitespace, `,` or `}`. */
const scalarEnd = (bytes: Uint8Array, at: number) => {
  for (; at < bytes.length; at += 1) {
    const code = bytes[at];
    if (code === COMMA || code === CLOSE || isSpace(code)) break;
  }
  return at;
};

interface Head {
  /** The top-level `type`, when a string: one of READ, or OTHER. */
  type?: string;
  /** Whether `isSidechain` is `true`. */
  side?: boolean;
  /** The attachment's `type`, when the attachment starts with it: one of LISTINGS, or OTHER. */
  attachment?: string;
  /** Where the message's `id` string sits, its quotes left out, when the message starts with it. */
  id?: readonly [start: number, end: number];
}

/** How many of a message's first members are read for its id: Claude Code writes `model`, then `id`. */
const MESSAGE_MEMBERS = 4;

/**
 * Where the `id` of the object that opens at `at` sits, when it is among its first plain string
 * members; undefined otherwise.
 */
const readId = (bytes: Uint8Array, at: number): Head["id"] => {
  for (let member = 0; member < MESSAGE_MEMBERS; member += 1) {
    at = skipSpace(bytes, at + 1);
    const keyEnd = plainEnd(bytes, at);
    if (keyEnd === -1) return undefined;
    const key = at;
    at = skipSpace(bytes, keyEnd + 1);
    if (bytes[at] !== COLON) return undefined;
    at = skipSpace(bytes, at + 1);
    const close = plainEnd(bytes, at);
    if (close === -1) return undefined;
    if (isToken(bytes, key, keyEnd, "id")) return [at + 1, close];
    at = skipSpace(bytes, close + 1);
    if (bytes[at] !== COMMA) return undefined;
  }
  return undefined;
};

/**
 * What the top-level members at the start of a line say, read up to the first object or array
 * member, or the end of `bytes`. Anything it cannot read for sure stays undefined.
 */
const readHead = (bytes: Uint8Array): Head => {
  const head: Head = {};
  let at = skipSpace(bytes, 0);
  if (bytes[at] !== OPEN) return head;
  for (;;) {
    at = skipSpace(bytes, at + 1);
    const keyEnd = plainEnd(bytes, at);
    if (keyEnd === -1) return head;
    const key = at;
    at = skipSpace(bytes, keyEnd + 1);
    if (bytes[at] !== COLON) return head;
    at = skipSpace(bytes, at + 1);
    const first = bytes[at];
    if (first === OPEN) {
      if (isToken(bytes, key, keyEnd, "message")) {
        const id = readId(bytes, at);
        if (id !== undefined) head.id = id;
        return head;
      }
      if (!isToken(bytes, key, keyEnd, "attachment")) return head;
      at = skipSpace(bytes, at + 1);
      const typeEnd = plainEnd(bytes, at);
      if (typeEnd === -1 || !isToken(bytes, at, typeEnd, "type")) return head;
      at = skipSpace(bytes, typeEnd + 1);
      if (bytes[at] !== COLON) return head;
      at = skipSpace(bytes, at + 1);
      const close = plainEnd(bytes, at);
      if (close !== -1) head.attachment = tokenIn(bytes, at, close, LISTINGS);
      return head;
    }
    if (first === QUOTE) {
      if (isToken(bytes, key, keyEnd, "type")) {
        const close = plainEnd(bytes, at);
        if (close === -1) return head;
        head.type = tokenIn(bytes, at, close, READ);
        at = close + 1;
      } else {
        const close = stringEnd(bytes, at);
        if (close === -1) return head;
        at = close + 1;
      }
    } else {
      // An array, or the end of `bytes`.
      if (first === 0x5b || at >= bytes.length) return head;
      const start = at;
      at = scalarEnd(bytes, at);
      if (at === bytes.length) return head;
      if (isToken(bytes, key, keyEnd, "isSidechain")) {
        head.side = at - start === 4 && holdsAt(bytes, start, "true");
      }
    }
    at = skipSpace(bytes, at);
    if (bytes[at] !== COMMA) return head;
  }
};

const TYPE_KEY = '"type"';

/**
 * The type a `"type"` key at `key` gives when no object or array follows it before the brace that
 * ends `bytes`. A quote after `{` or `,` cannot be an escaped one, so the key is a member of an
 * object; with no brace or bracket after it but the last, that object is the line's own.
 */
const lastMembersType = (bytes: Uint8Array, key: number) => {
  let before = key - 1;
  while (before >= 0 && isSpace(bytes[before])) before -= 1;
  const opener = bytes[before];
  if (opener !== COMMA && opener !== OPEN) return undefined;
  const colon = skipSpace(bytes, key + TYPE_KEY.length);
  if (bytes[colon] !== COLON) return undefined;
  const value = skipSpace(bytes, colon + 1);
  const valueEnd = plainEnd(bytes, value);
  if (valueEnd === -1) return undefined;
  const after = valueEnd + 1;
  let close = bytes.length - 1;
  while (close >= after && isSpace(bytes[close])) close -= 1;
  if (close < after || bytes[close] !== CLOSE) return undefined;
  for (let at = after; at < close; at += 1) {
    const code = bytes[at];
    if (code === OPEN || code === CLOSE || code === 0x5b) return undefined;
  }
  return tokenIn(bytes, value, valueEnd, READ);
};

/** The last `"type"` that starts at or before `from`; -1 when none does. */
const lastTypeKey = (bytes: Uint8Array, from: number) => {
  for (let at = Math.min(from, bytes.length - TYPE_KEY.length); at >= 0; at -= 1) {
    if (bytes[at] === QUOTE && holdsAt(bytes, at, TYPE_KEY)) return at;
  }
  return -1;
};

/** The top-level `type` read from a line's last bytes, when only scalar members follow it. */
const tailType = (bytes: Uint8Array) => {
  for (let key = lastTypeKey(bytes, bytes.length); key !== -1; key = lastTypeKey(bytes, key - 1)) {
    const type = lastMembersType(bytes, key);
    if (type !== undefined) return type;
    if (key === 0) break;
  }
  return undefined;
};

const isEmpty = (record: Record<string, unknown>) => Object.keys(record).length === 0;

/**
 * True only when `parse` would return no Facts and leave `state` as it is. Reads the line's head and
 * tail, and searches the whole line only for strings whose absence settles it. It assumes, as
 * Claude Code's writer (`JSON.stringify`) guarantees, no duplicate keys and no escaped printable
 * ASCII; a line that is not JSON is a no-op either way.
 */
const skip = (line: LineBytes, state: ClaudeState): boolean => {
  const { bytes } = line;
  const head = readHead(bytes.subarray(0, HEAD_BYTES));
  const type = head.type ?? tailType(bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)));
  if (type !== undefined && !READ.includes(type)) return true;
  if (state.day === undefined) return false;
  // Unknown counts as the main chain: every line that is a no-op there is one in a subagent's too.
  const side = head.side === true;
  if (!side && !state.started) return false;
  const quiet = state.command === undefined && isEmpty(state.mcp) && isEmpty(state.project);
  const repeats =
    head.id !== undefined &&
    state.last !== undefined &&
    bytesHash(bytes, head.id[0], head.id[1]) === state.last;
  const noop = (as: string) => {
    if (as === "attachment") {
      if (side && head.attachment !== undefined) {
        return (
          head.attachment !== "mcp_instructions_delta" && head.attachment !== "deferred_tools_delta"
        );
      }
      return head.attachment === undefined
        ? !LISTING_TOKENS.some((listing) => line.includes(listing))
        : !LISTINGS.includes(head.attachment);
    }
    if (!quiet) return false;
    if (as === "user") {
      // A tool's result does nothing, unless the user stopped the turn there; any other user
      // line may be a prompt.
      return (
        line.includes(TOOL_RESULT_TOKEN) &&
        !line.includes(INTERRUPTED_TOKEN) &&
        !line.includes(INTERRUPTED) &&
        !line.includes(COMMAND_MESSAGE)
      );
    }
    if (as === "assistant") {
      if (!state.tokens && !side) return false;
      // A request is counted once, at its first line; a line with its id repeats it.
      if (!repeats && line.includes(USAGE)) return false;
      // Every line of a turn in progress moves its end; every tool call counts.
      if (state.open !== undefined && !isEmpty(state.open)) return false;
      if (line.includes(API_ERROR_MESSAGE)) return false;
      return !holds(line, TOOL_USE);
    }
    return !line.includes(COMPACT_TOKEN) && !line.includes(API_ERROR_TOKEN);
  };
  // A type the line's ends do not show must be a no-op as each one its bytes could hold.
  return type === undefined
    ? READ.every((as) => noop(as) || !line.includes(READ_TOKENS.get(as)!))
    : noop(type);
};

/**
 * One request's tokens, from an assistant message's usage, dated by its line's time. Moves the
 * state's last request minute to it.
 */
const usageTokens = (
  usage: Json,
  model: unknown,
  time: number,
  state: ClaudeState,
  thread: Thread,
): Fact => {
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : {};
  const cacheWrite5m = count(split.ephemeral_5m_input_tokens);
  const modelName = typeof model === "string" && NAME.test(model) ? model : undefined;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  let day = state.day!;
  let cacheRewrite = 0;
  if (!Number.isNaN(time)) {
    day = new Date(time).toISOString().slice(0, 10);
    const minute = Math.floor(time / MINUTE_MS);
    if (state.minute !== undefined && modelName !== undefined && modelName === state.requestModel) {
      const gap = minute - state.minute;
      if (gap >= REWRITE_MINUTES[0] && gap < REWRITE_MINUTES[1]) cacheRewrite = cacheWrite5m;
    }
    state.minute = minute;
  } else {
    delete state.minute;
  }
  state.requestModel = modelName;
  return {
    type: "usage-tokens",
    day,
    via: state.via ?? "unknown",
    project: state.folder ?? "unknown",
    thread,
    model: modelName ?? "unknown",
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    reasoning: count(details.thinking_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h: count(split.ephemeral_1h_input_tokens),
    cacheRewrite,
  };
};

/** The counters of a turn Fact. */
type UsageTurnCounts = Omit<
  Extract<Fact, { type: "usage-turn" }>,
  "day" | "via" | "project" | "thread"
>;

/**
 * Claude Code's JSONL transcripts. A turn starts at a prompt the user wrote, or at the expansion
 * of a skill or command run as `/name`, and runs to its thread's last assistant line before the
 * next one, so the time a turn waited on the user after its last reply is not in it. A turn is
 * interrupted where Claude Code marks the user's stop. Each tool_use block is a tool call; an
 * Agent or Task call starts a subagent. A rate limit is reached at a run of 429 retries or a
 * request that failed on one: Claude Code says no window, so it counts under window 0.
 */
export const claudeTranscripts: TranscriptFormat<ClaudeState> = {
  // Every line loadsheet reads carries its entrypoint; request logs and titles do not.
  markers: ['"entrypoint"'],
  initial: () => ({ started: false, tokens: false, listed: {}, builtIn: {}, mcp: {}, project: {} }),
  parent,
  skip,
  parse(line, state, place, parentNames) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isRecord(record)) return [];
    const { type } = record;
    if (type !== "user" && type !== "assistant" && type !== "attachment" && type !== "system") {
      return [];
    }

    const time = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    const facts: Fact[] = [];
    // A subagent's lines, in its own transcript or (in older versions) its parent's.
    const side = record.isSidechain === true;
    const thread: Thread = side ? "subagent" : "main";
    if (state.day === undefined) {
      if (Number.isNaN(time)) return [];
      state.day = new Date(time).toISOString().slice(0, 10);
      state.via =
        typeof record.entrypoint === "string" && NAME.test(record.entrypoint)
          ? record.entrypoint
          : "unknown";
      if (typeof record.version === "string" && NAME.test(record.version))
        state.version = record.version;
      state.folder = projectOfCwd(record.cwd, place);
      // Each file is one conversation: a session's main one, or one subagent's in a file of its own.
      facts.push({
        type: "usage-session",
        day: state.day,
        via: state.via,
        project: state.folder,
        thread,
      });
    }
    const day = state.day;
    const via = state.via ?? "unknown";
    const project = state.folder ?? "unknown";

    if (!side && !state.started) {
      state.started = true;
      facts.push({
        type: "session",
        day,
        via,
        ...(state.version ? { version: state.version } : {}),
      });
    }
    const listed = (item: Id, chars: number, bare: boolean) => {
      if (side || state.listed[item]) return;
      state.listed[item] = true;
      facts.push({ type: "listed", day, via, item, chars, bare });
    };
    const used = (item: Id, by: "model" | "user") =>
      facts.push({ type: "used", day, via, item, by });
    // The model or the user wrote this name, so one with a space counts only when the session
    // listed that skill.
    const skillNamed = (name: string) =>
      NAME.test(name) || (SKILL_NAME.test(name) && state.listed[`skill:${name}`] === true);

    if (type === "attachment") {
      // A subagent's listing is its parent's to count, and the parent counts it.
      const attachment = isRecord(record.attachment) ? record.attachment : {};
      if (
        side &&
        attachment.type !== "mcp_instructions_delta" &&
        attachment.type !== "deferred_tools_delta"
      )
        return facts;
      switch (attachment.type) {
        case "skill_listing": {
          const content = typeof attachment.content === "string" ? attachment.content : "";
          for (const { name, chars, bare } of skillEntries(strings(attachment.names), content)) {
            if (SKILL_NAME.test(name)) listed(`skill:${name}`, chars, bare);
          }
          break;
        }
        case "agent_listing_delta": {
          for (const name of [
            ...strings(attachment.builtInTypes),
            ...strings(attachment.builtInPluginTypes),
          ]) {
            if (NAME.test(name)) state.builtIn[name] = true;
          }
          const lines = strings(attachment.addedLines);
          for (const name of strings(attachment.addedTypes)) {
            if (!NAME.test(name) || state.builtIn[name]) continue;
            const entry = lines.find(
              (text) =>
                text === `- ${name}` ||
                text.startsWith(`- ${name}: `) ||
                text.startsWith(`- ${name} (`),
            );
            listed(`subagent:${name}`, (entry ?? `- ${name}`).length + 1, entry === undefined);
          }
          break;
        }
        case "mcp_instructions_delta": {
          const blocks = Array.isArray(attachment.addedBlocks) ? attachment.addedBlocks : [];
          strings(attachment.addedNames).forEach((name, index) => {
            const server = instructionServer(name);
            if (server === undefined) return;
            (state.knownMcp ??= {})[`mcp:${server}`] = true;
            if (side) return;
            const block = blocks[index];
            state.mcp[server] =
              (state.mcp[server] ?? 0) + (typeof block === "string" ? block.length : 0);
          });
          break;
        }
        case "deferred_tools_delta": {
          const lines = Array.isArray(attachment.addedLines) ? attachment.addedLines : [];
          strings(attachment.addedNames).forEach((tool, index) => {
            const server = knownServer(tool, state.knownMcp, parentNames) ?? mcpServer(tool);
            if (server === undefined) return;
            (state.knownMcp ??= {})[`mcp:${server}`] = true;
            if (side) return;
            const text = lines[index];
            state.mcp[server] =
              (state.mcp[server] ?? 0) + (typeof text === "string" ? text.length + 1 : 0);
          });
          break;
        }
        case "instructions": {
          // Project files share ids, so one id's files add up until the turn starts, as MCP
          // servers do. A file that loads later for an id the session listed, such as one
          // reloaded after /compact, is not counted again.
          for (const file of Array.isArray(attachment.files) ? attachment.files : []) {
            if (!isRecord(file) || typeof file.path !== "string") continue;
            const name = instructionName(file.path, typeof file.type === "string" ? file.type : "");
            if (name === undefined) continue;
            const item = `instructions:${name}`;
            const chars = typeof file.content === "string" ? file.content.length : 0;
            if (!name.startsWith(PROJECT)) listed(item, chars, false);
            else if (!state.listed[item]) state.project[item] = (state.project[item] ?? 0) + chars;
          }
          break;
        }
      }
      return facts;
    }

    // A turn's attachments arrive one line each; its MCP servers and project instruction files are
    // counted once they are all in.
    for (const [server, chars] of Object.entries(state.mcp)) listed(`mcp:${server}`, chars, false);
    state.mcp = {};
    for (const [item, chars] of Object.entries(state.project)) listed(item, chars, false);
    state.project = {};

    const moment = momentOf(time);
    const turnFact = (turn: OpenTurn, counts: Omit<UsageTurnCounts, "type">) =>
      facts.push({ type: "usage-turn", day: turn.day, via, project, thread, ...counts });
    // A line of the turn in progress: the turn now runs until it.
    const extend = (turn: OpenTurn) => {
      if (Number.isNaN(time) || turn.end === undefined || time <= turn.end) return;
      turnFact(turn, { durationMs: time - turn.end, ...(turn.timed ? {} : { timed: 1 }) });
      turn.timed = true;
      turn.end = time;
    };
    const reached = () =>
      facts.push({ type: "usage-limit", day: moment?.day ?? day, windowMinutes: 0, reached: 1 });

    if (type === "user") {
      const command = state.command;
      delete state.command;
      // A skill or custom command run as `/name` expands into the next line, marked meta; a
      // built-in command such as /compact does not.
      const expansion = command !== undefined && record.isMeta === true;
      if (expansion) used(`skill:${command}`, "user");
      const text = userText(record.message);
      const match = COMMAND.exec(text ?? "");
      const name = match?.[1]?.trim();
      if (name !== undefined && skillNamed(name)) state.command = name;
      const open = state.open?.[thread];
      const result = isRecord(record.toolUseResult) ? record.toolUseResult : undefined;
      if (open && (text?.trimStart().startsWith(INTERRUPTED) || result?.interrupted === true)) {
        extend(open);
        turnFact(open, { interrupted: 1 });
        delete state.open![thread];
      } else if (expansion || (match === null && isPrompt(record))) {
        const turn: OpenTurn = {
          day: moment?.day ?? day,
          ...(Number.isNaN(time) ? {} : { end: time }),
          timed: false,
          subagents: false,
        };
        state.open = { ...state.open, [thread]: turn };
        turnFact(turn, { turns: 1 });
        if (moment) facts.push({ type: "usage-hour", ...moment, thread, turns: 1 });
      } else if (
        open &&
        (record.origin !== undefined ||
          match !== null ||
          NOT_PROMPTS.some((tag) => text?.trimStart().startsWith(tag)) ||
          PEER_MESSAGE.test(text?.trimStart() ?? ""))
      ) {
        // A notification, a peer's message or a built-in command came in after the turn's last
        // reply: what answers it is no part of that turn.
        delete state.open![thread];
      }
      return facts;
    }
    delete state.command;

    if (type === "system") {
      const error = isRecord(record.error) ? record.error : undefined;
      if (record.subtype === API_ERROR && error?.status === RATE_LIMITED) {
        // Each retry writes a line; a run of them is one limit hit.
        if (record.retryAttempt === 1 || !state.limited) reached();
        state.limited = true;
      }
      if (record.subtype === COMPACT_BOUNDARY) {
        const metadata = isRecord(record.compactMetadata) ? record.compactMetadata : {};
        facts.push({
          type: "compaction",
          day,
          via,
          project,
          thread,
          manual: metadata.trigger === "manual",
          first: state.compacted !== true,
        });
        state.compacted = true;
      }
      return facts;
    }

    if (type === "assistant" && isRecord(record.message)) {
      const { message } = record;
      const open = state.open?.[thread];
      if (open) extend(open);
      if (
        record.isApiErrorMessage === true &&
        (record.error === "rate_limit" || record.apiErrorStatus === RATE_LIMITED)
      ) {
        if (!state.limited) reached();
        state.limited = true;
      }
      if (!side && !state.tokens && isRecord(message.usage) && message.model !== SYNTHETIC_MODEL) {
        state.tokens = true;
        const usage = message.usage;
        const tokens =
          count(usage.input_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens);
        facts.push({ type: "tokens", day, via, tokens });
      }
      if (isRecord(message.usage) && message.model !== SYNTHETIC_MODEL) {
        const id = typeof message.id === "string" ? idHash(message.id) : undefined;
        // Claude Code writes a message once per content block, each line with the same usage.
        if (id === undefined || id !== state.last) {
          if (id === undefined) delete state.last;
          else state.last = id;
          delete state.limited;
          facts.push(usageTokens(message.usage, message.model, time, state, thread));
          if (moment) facts.push({ type: "usage-hour", ...moment, thread, requests: 1 });
        }
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string")
          continue;
        const input = isRecord(block.input) ? block.input : {};
        const server = knownServer(block.name, state.knownMcp, side ? parentNames : undefined);
        facts.push({
          type: "usage-tool",
          day: moment?.day ?? day,
          thread,
          tool: toolName(
            server !== undefined
              ? `mcp:${server}`
              : BUILT_IN_TOOLS.has(block.name)
                ? block.name
                : undefined,
          ),
        });
        if (open) {
          const spawns = (block.name === "Agent" || block.name === "Task") && !open.subagents;
          if (spawns) open.subagents = true;
          turnFact(open, { toolCalls: 1, ...(spawns ? { withSubagents: 1 } : {}) });
        }
        if (block.name === "Skill") {
          const name =
            typeof input.skill === "string" ? input.skill.trim().replace(/^\//u, "") : "";
          if (skillNamed(name)) used(`skill:${name}`, "model");
        } else if (block.name === "Agent" || block.name === "Task") {
          const name =
            typeof input.subagent_type === "string"
              ? input.subagent_type.trim()
              : "general-purpose";
          if (NAME.test(name) && !state.builtIn[name] && !BUILT_IN_AGENTS.includes(name)) {
            used(`subagent:${name}`, "model");
          }
        } else if (server !== undefined) {
          used(`mcp:${server}`, "model");
        }
      }
    }
    return facts;
  },
};

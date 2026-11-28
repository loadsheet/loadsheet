// What a harness adapter is written against. This entry is isomorphic: the Node readers live in `@loadsheet/kit/node`.
import type { Day, Grade, Id, Item, Settings, Signal, Thread } from "@loadsheet/schema";

/** A read-only set of text files, keyed by POSIX path relative to their root. */
export interface Files {
  /** What the files are called: `owner/repo` for a GitHub pack, the directory's name for a folder. */
  readonly name?: string;
  /** Every file's path, sorted. */
  readonly paths: readonly string[];
  /** A file's text; undefined when it is not in the set or is too large to read. */
  text(path: string): Promise<string | undefined>;
}

/** Files held in memory, for tests and for files already downloaded. */
export const memoryFiles = (record: Record<string, string>, name?: string): Files => {
  const files = new Map(Object.entries(record));
  return {
    ...(name === undefined ? {} : { name }),
    paths: [...files.keys()].sort(),
    text: async (path) => files.get(path),
  };
};

/** The sha256 of a text's UTF-8 bytes, as lowercase hex. */
export const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** What every Fact carries: the session it is about, the way a Scan's cells are keyed. */
interface FactOfSession {
  /** The UTC day the session started. */
  readonly day: Day;
  /** The entrypoint or originator that started the session, such as `cli`. */
  readonly via: string;
}

/** A session started. Once per session. */
export interface SessionFact extends FactOfSession {
  readonly type: "session";
  /** The harness version that ran it, when the transcript says. */
  readonly version?: string;
}

/** The input tokens of the session's first request: what it started with. At most once per session. */
export interface TokensFact extends FactOfSession {
  readonly type: "tokens";
  readonly tokens: number;
}

/** The context window, in tokens, of the model the session ran. At most once per session. */
export interface WindowFact extends FactOfSession {
  readonly type: "window";
  readonly tokens: number;
}

/** The session listed an item (skill, mcp, subagent) or loaded it (instructions). At most once per session and item. */
export interface ListedFact extends FactOfSession {
  readonly type: "listed";
  readonly item: Id;
  /** Characters it put in the session's context. */
  readonly chars: number;
  /** Whether it was listed without its description. */
  readonly bare: boolean;
}

/** The session invoked an item. Once per invocation. */
export interface UsedFact extends FactOfSession {
  readonly type: "used";
  readonly item: Id;
  readonly by: "model" | "user";
}

/** What a usage Fact carries besides its session: the project and the conversation it is about. */
interface FactOfThread extends FactOfSession {
  /**
   * The project: `owner/repo` when the transcript says, else the working directory as the Files
   * keys paths (`~/...` under the home directory, absolute elsewhere), or `unknown`. kit resolves a
   * folder to its repository when it builds the Scan.
   */
  readonly project: string;
  /** Whether the main conversation or a subagent's said it. */
  readonly thread: Thread;
}

/** A conversation started: a session's main one, or one subagent's. Once per conversation. */
export interface UsageSessionFact extends FactOfThread {
  readonly type: "usage-session";
}

/**
 * A conversation compacted its context. Once per compaction, keyed by the day its session
 * started; `first` is true on the conversation's first compaction only.
 */
export interface CompactionFact extends FactOfThread {
  readonly type: "compaction";
  /** Whether the user asked for it. */
  readonly manual: boolean;
  readonly first: boolean;
}

/**
 * Tokens of model requests. `day` is the UTC day of the requests, not of the session's start. Once
 * per request, or once per several requests summed (`requests`, default 1). The splits are parts:
 * `reasoning` of `output`, `cacheWrite5m`, `cacheWrite1h` and `cacheRewrite` of `cacheWrite`.
 */
export interface UsageTokensFact extends FactOfThread {
  readonly type: "usage-tokens";
  /** The model, as the harness names it. */
  readonly model: string;
  readonly requests?: number;
  /** Input tokens neither read from nor written to the prompt cache. */
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  /** Cache-write tokens of a request 5 to 60 minutes after the previous one of its conversation. */
  readonly cacheRewrite: number;
}

/**
 * Turns of a conversation, keyed by the UTC day each turn started, not of the session's start. A turn is one prompt and the work
 * the agent did for it. Each counter defaults to 0, so a parser can say a turn started, then add
 * its duration or tool calls as it reads them: `timed` and `durationMs` once the turn's length is
 * known, `interrupted` when the user stopped it, `withSubagents` the first time it starts one.
 */
export interface UsageTurnFact extends FactOfThread {
  readonly type: "usage-turn";
  readonly turns?: number;
  readonly interrupted?: number;
  readonly timed?: number;
  readonly durationMs?: number;
  readonly toolCalls?: number;
  readonly withSubagents?: number;
}

/** Activity in one UTC hour: model requests made and turns started in it. Counters default to 0. */
export interface UsageHourFact {
  readonly type: "usage-hour";
  /** The UTC day of the activity, not of the session's start. */
  readonly day: Day;
  /** The UTC hour, 0 to 23. */
  readonly hour: number;
  readonly thread: Thread;
  readonly requests?: number;
  readonly turns?: number;
}

/** Calls of one tool (`calls`, default 1), on the UTC day they were made. `tool` is a `toolName`. */
export interface UsageToolFact {
  readonly type: "usage-tool";
  readonly day: Day;
  readonly thread: Thread;
  readonly tool: string;
  readonly calls?: number;
}

/**
 * A reading of a rate-limit window, or the limit being reached (`reached`, default 0), on the UTC
 * day it was read. `windowMinutes` is 0 when the harness does not say the window's length. It is a
 * gauge: the reading with the later `at` wins.
 */
export interface UsageLimitFact {
  readonly type: "usage-limit";
  readonly day: Day;
  readonly windowMinutes: number;
  /** The share of the window used, in percent. */
  readonly usedPercent?: number;
  /** When it was read, in seconds since the epoch; given with `usedPercent`. */
  readonly at?: number;
  /** When the window resets, in seconds since the epoch. */
  readonly resetsAt?: number;
  readonly reached?: number;
}

/** A tool's name as usage keeps it: letters, digits, `_`, `.`, `:` and `-`, at most 64. */
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/u;

/**
 * The name a tool call is counted under: `mcp:<server>` for an MCP server's tool, else the tool's
 * own name, and `other` for a name usage does not keep, so no free text becomes a key.
 */
export const toolName = (name: string, server?: string): string => {
  const tool = server === undefined ? name : `mcp:${server}`;
  return TOOL.test(tool) ? tool : "other";
};

/**
 * What one transcript line says, in names, days and counters only: no text, no session id, no
 * path. A Scan is a sum over Facts: `session` and `tokens` fill a SessionCell and the Coverage,
 * `window` the Coverage's context window, `listed` and `used` fill the Cell of their item, and the
 * `usage-*` and `compaction` Facts fill the Scan's usage. Every one is counted where it is read, so
 * a transcript read in two parts sums to the same as one read whole; `usage-limit` is the one
 * gauge, and merges by its reading's time instead.
 */
export type Fact =
  | SessionFact
  | TokensFact
  | WindowFact
  | ListedFact
  | UsedFact
  | UsageSessionFact
  | CompactionFact
  | UsageTokensFact
  | UsageTurnFact
  | UsageHourFact
  | UsageToolFact
  | UsageLimitFact;

/**
 * One transcript line's bytes, before they are decoded: a view the reader points at each line in
 * turn, so it is valid only during the call it is passed to.
 */
export interface LineBytes {
  /** Bytes in the line, without its newline or carriage return. */
  readonly length: number;
  /** The bytes themselves, to read a few of them without making a string. */
  readonly bytes: Uint8Array;
  /** Whether the line's bytes contain the UTF-8 bytes of `ascii`. */
  includes(ascii: string): boolean;
  /** Bytes `start` to `end` (default the line's end) as latin1: one character per byte. */
  slice(start: number, end?: number): string;
}

/**
 * How a harness's transcript lines become Facts. `readTranscript` in `@loadsheet/kit/node` takes
 * it as its line format.
 */
export interface TranscriptFormat<State> {
  /** A line that contains none of these byte strings is skipped before it is decoded. */
  readonly markers: readonly [string, ...string[]];
  /**
   * What `parse` remembers within one transcript, such as the session's day and whether its
   * listing was counted. It is saved in the cache between runs, so it is plain JSON data and
   * holds nothing a Scan may not hold.
   */
  initial(): State;
  /**
   * True only when `parse` would return no Facts and leave `state` unchanged. Called before the
   * marker test and before the line is decoded, so it saves both on lines that cannot matter.
   */
  skip?(line: LineBytes, state: State): boolean;
  /**
   * May mutate `state`. A throw fails the whole read, so catch malformed lines inside. `place` is
   * the machine's, for writing a working directory the way the Files keys paths; nothing of it
   * goes into `state`. kit's readers always pass it; a test may leave it out.
   */
  parse(line: string, state: State, place?: Place): readonly Fact[];
}

/** Where things are on one machine. A harness derives its own paths from it and reads nothing. */
export interface Place {
  /** The user's home directory, absolute. */
  readonly home: string;
  /** The environment, for variables that move a harness's home, such as `CLAUDE_CONFIG_DIR`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The working directory, absolute, for a harness that takes a relative variable under it; home when absent. */
  readonly cwd?: string;
}

/**
 * A usage Fact a session store read. It is about the store's harness, or, with `harness`, about
 * another one, as when T3 Code's database holds the sessions of an agent it drives. A store says
 * only usage: its sessions never count as a harness's SessionCells.
 */
export type StoreFact = (
  | UsageSessionFact
  | CompactionFact
  | UsageTokensFact
  | UsageTurnFact
  | UsageHourFact
) & {
  readonly harness?: string;
};

/** One row of a store's SELECT, by column name. */
export type StoreRow = Readonly<Record<string, number | bigint | string | null | Uint8Array>>;

/**
 * A SQLite database a harness keeps its sessions in. kit opens it read-only, creating no file
 * beside it, runs `query` once and passes the rows to `facts`. A database it cannot open or
 * query is listed in the Coverage's `unread`; one that does not exist is not.
 */
export interface SqliteStore {
  readonly kind: "sqlite";
  /** Its name in `Coverage.unread`, such as `opencode.db`: never a path. */
  readonly name: string;
  /** The database file, absolute. */
  path(place: Place): string;
  /**
   * One SELECT. `$since` is bound to the window's first instant, as epoch milliseconds or as an ISO
   * 8601 timestamp (`since`). It selects numbers, model names and folders only: a title, message
   * or payload stays in SQLite, so `json_extract` the one field needed.
   */
  readonly query: string;
  readonly since: "ms" | "iso";
  /** The rows as Facts; a project is keyed as the Files keys paths, through `place`. */
  facts(rows: readonly StoreRow[], place: Place): StoreFact[];
}

/** One session's folder in a FolderStore: the JSON files kit read from it. */
export interface StoreFolder {
  /** The folder's path below the store's root, as it is spelled on the disk. */
  readonly folder: string;
  /** Each of the store's `files` by name; undefined when missing, unreadable or too large. */
  readonly files: Readonly<Record<string, string | undefined>>;
}

/**
 * A folder holding one folder per session, of small JSON files. kit reads the `files` of each
 * session folder whose first file changed in the window and passes them to `facts`.
 */
export interface FolderStore {
  readonly kind: "folder";
  /** Its name in `Coverage.unread`, such as `grok-sessions`: never a path. */
  readonly name: string;
  /** The folder the session folders are under, absolute. */
  root(place: Place): string;
  /** How many folders below the root a session's folder is: 1 for `<root>/<id>`. */
  readonly depth: number;
  /** The files to read in each session folder; the first one's mtime says whether it changed. */
  readonly files: readonly [string, ...string[]];
  facts(session: StoreFolder, place: Place): StoreFact[];
}

/** Where a harness keeps sessions other than JSONL transcripts. */
export type SessionStore = SqliteStore | FolderStore;

/**
 * A folder's repository as a harness remembers it: a project under `prefix`, a path keyed as the
 * Files keys paths, is `project`, an `owner/repo`. The longest matching prefix wins.
 */
export interface ProjectHint {
  readonly prefix: string;
  readonly project: string;
}

/** What a harness keeps on a machine. Paths are absolute and joined with `/`. */
export interface MachineReader<State> {
  /** The harness's home directory; the harness counts as installed when it exists. */
  home(place: Place): string;
  /**
   * The directories and files that hold what is installed for the user. kit reads them into one
   * Files, keyed `~/...` under the home directory and by absolute path elsewhere.
   */
  sources(place: Place): string[];
  /**
   * The pieces of context in those files, with paths as the Files keys them. `place` is for telling
   * which key an absolute path in a config file names; nothing of it goes into an Item.
   */
  inventory(files: Files, place?: Place): Promise<Item[]>;
  /**
   * The model's context window in tokens as the harness's settings in those files give it, for
   * when no session in the window reported one; undefined when they do not say.
   */
  contextWindow?(files: Files): Promise<number | undefined>;
  /**
   * What the harness's settings in those files and `place.env` set, as derived values: never a
   * setting's text or a variable's value. Undefined when it reads none.
   */
  settings?(files: Files, place: Place): Promise<Settings | undefined>;
  /**
   * Which repository a project folder belongs to, as the harness's own files remember it, for a
   * folder that is gone from the disk, such as a deleted worktree.
   */
  projects?(files: Files, place: Place): Promise<ProjectHint[]>;
  /**
   * The directories its session transcripts are under; absent, with `transcripts`, for a harness
   * loadsheet reads the inventory of only. Such a harness has no sessions in a Scan.
   */
  roots?(place: Place): string[];
  /** How its transcript lines become Facts; absent, with `roots`, for an inventory-only harness. */
  readonly transcripts?: TranscriptFormat<State>;
  /** Its session stores that are not JSONL transcripts, read for usage only. */
  stores?(place: Place): SessionStore[];
}

/** One coding agent loadsheet can read. */
export interface Harness<State = unknown> {
  /** Its id, such as `claude-code`. */
  readonly id: string;
  /** How well its transcripts provide each signal. */
  readonly signals: Record<Signal, Grade>;
  /** The pieces of context in a pack's files. */
  inventory(files: Files): Promise<Item[]>;
  /** How to read it on a machine; absent while only its packs can be read. */
  readonly machine?: MachineReader<State>;
}

/** Declares a harness; it only checks the shape. */
export const defineHarness = <H extends Harness>(harness: H): H => harness;

export * from "./fold.ts";
export * from "./project.ts";

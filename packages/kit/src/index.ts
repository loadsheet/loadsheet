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
 * What one transcript line says, in names, days and counters only: no text, no session id, no
 * path. A Scan is a sum over Facts: `session` and `tokens` fill a SessionCell and the Coverage,
 * `window` the Coverage's context window, `listed` and `used` fill the Cell of their item, and
 * `usage-session`, `compaction` and `usage-tokens` fill the Scan's usage. Every one is counted
 * where it is read, so a transcript read in two parts sums to the same as one read whole.
 */
export type Fact =
  | SessionFact
  | TokensFact
  | WindowFact
  | ListedFact
  | UsedFact
  | UsageSessionFact
  | CompactionFact
  | UsageTokensFact;

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

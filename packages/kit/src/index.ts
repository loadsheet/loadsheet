// What a harness adapter is written against. This entry is isomorphic: the Node readers live in `@loadsheet/kit/node`.
import type { Day, Grade, Id, Item, Signal } from "@loadsheet/schema";

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

/**
 * What one transcript line says, in names, days and counters only: no text, no session id, no
 * path. A Scan is a sum over Facts: `session` and `tokens` fill a SessionCell and the Coverage,
 * `listed` and `used` fill the Cell of their item.
 */
export type Fact = SessionFact | TokensFact | ListedFact | UsedFact;

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
  /** May mutate `state`. A throw fails the whole read, so catch malformed lines inside. */
  parse(line: string, state: State): readonly Fact[];
}

/** Where things are on one machine. A harness derives its own paths from it and reads nothing. */
export interface Place {
  /** The user's home directory, absolute. */
  readonly home: string;
  /** The environment, for variables that move a harness's home, such as `CLAUDE_CONFIG_DIR`. */
  readonly env: Readonly<Record<string, string | undefined>>;
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
  /** The directories its session transcripts are under. */
  roots(place: Place): string[];
  /** How its transcript lines become Facts. */
  readonly transcripts: TranscriptFormat<State>;
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

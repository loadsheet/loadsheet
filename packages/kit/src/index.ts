// What a harness adapter is written against. This entry is isomorphic: the Node readers live in `@loadsheet/kit/node`.
import type { Grade, Item, Signal } from "@loadsheet/schema";

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

/** One coding agent loadsheet can read. */
export interface Harness {
  /** Its id, such as `claude-code`. */
  readonly id: string;
  /** How well its transcripts provide each signal. */
  readonly signals: Record<Signal, Grade>;
  /** The pieces of context installed in a set of files. */
  inventory(files: Files): Promise<Item[]>;
}

/** Declares a harness; it only checks the shape. */
export const defineHarness = <H extends Harness>(harness: H): H => harness;

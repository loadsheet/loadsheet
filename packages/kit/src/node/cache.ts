// The scan cache: the only thing loadsheet writes. Per transcript file it keeps where reading
// stopped and the counters the committed lines gave, so a warm run reads only new bytes. It holds
// no transcript text, session id, file name or path: files are keyed by a salted hash.
//
// On disk every string is an index into one table per cache file, and counters are flat tuples
// grouped by day, harness and entrypoint, because thousands of transcripts repeat the same names.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cell, SessionCell } from "@loadsheet/schema";
import type { Tally, TranscriptFormat, VersionSeen } from "../index.ts";
import type { ReadPosition } from "./reader.ts";

/** The layout of a cache file; a change here starts every cache cold. */
const CACHE_LAYOUT = 1;

/** What the cache keeps for one transcript file. */
export interface CachedFile {
  /** The file's size and mtime when it was read, to skip a file that has not changed. */
  readonly size: number;
  readonly mtimeMs: number;
  /** Whether it ended in an unterminated line, which is read again every run. */
  readonly hasTail: boolean;
  /** Where reading stopped, after the last complete line. */
  readonly position: ReadPosition;
  /** The counters of the lines before `position`. */
  readonly tally: Tally;
}

/** One harness's cache: its files by key, valid for one tool version and transcript format. */
export interface HarnessCache {
  /** Hashes a transcript's absolute path into its key. */
  key(path: string): string;
  get(key: string): CachedFile | undefined;
  /**
   * Writes `files` as the whole cache, atomically; files it leaves out are forgotten. Writes
   * nothing when `files` holds exactly the entries `get` returned from the file on disk.
   */
  save(files: ReadonlyMap<string, CachedFile>): Promise<void>;
}

/** Where the cache lives by default: `$XDG_CACHE_HOME/loadsheet`, else `~/.cache/loadsheet`. */
export const defaultCacheDir = (place: {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}): string => join(place.env.XDG_CACHE_HOME || join(place.home, ".cache"), "loadsheet");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Changes when the harness's parser does, so a new format starts cold. */
const formatFingerprint = (format: TranscriptFormat<unknown>) =>
  sha256(JSON.stringify([format.markers, format.initial(), format.parse.toString()]));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** Thrown while decoding a malformed entry, which then opens as a miss. */
class Malformed extends Error {}

/** A cache file's strings, each stored once and referred to by index. */
class StringTable {
  readonly strings: string[] = [];
  readonly #index = new Map<string, number>();

  ref(text: string): number {
    let index = this.#index.get(text);
    if (index === undefined) {
      index = this.strings.push(text) - 1;
      this.#index.set(text, index);
    }
    return index;
  }
}

/** Reads encoded counters and string references, throwing Malformed on anything else. */
class Decoder {
  readonly strings: readonly string[];

  constructor(strings: readonly string[]) {
    this.strings = strings;
  }

  isRef(value: unknown): value is number {
    return (
      Number.isInteger(value) && (value as number) >= 0 && (value as number) < this.strings.length
    );
  }

  text(value: unknown): string {
    if (!this.isRef(value)) throw new Malformed();
    return this.strings[value]!;
  }

  /** A `YYYY-MM-DD` day, which the window filter compares as a string. */
  day(value: unknown): string {
    const text = this.text(value);
    if (!DAY.test(text)) throw new Malformed();
    return text;
  }

  count(value: unknown): number {
    if (!isCount(value)) throw new Malformed();
    return value;
  }

  /** `value` as an array whose length is a multiple of `stride`. */
  tuples(value: unknown, stride: number): unknown[] {
    if (!Array.isArray(value) || value.length % stride !== 0) throw new Malformed();
    return value;
  }
}

// The adapter's state is any JSON value, opaque to kit. Encoded, each JSON type stands for
// another so no tags are needed: a string is its table index, a number its decimal string, an
// object a flat [key, value, ...] array with keys as indices, and an array `{ a: items }`. true,
// false and null stay as they are.

const isJsonMember = (value: unknown) =>
  value !== undefined && typeof value !== "function" && typeof value !== "symbol";

const encodeValue = (value: unknown, table: StringTable): unknown => {
  if (typeof value === "string") return table.ref(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return { a: value.map((item) => (isJsonMember(item) ? encodeValue(item, table) : null)) };
  }
  if (typeof value === "object") {
    const flat: unknown[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (isJsonMember(item)) flat.push(table.ref(key), encodeValue(item, table));
    }
    return flat;
  }
  return null;
};

const checkValue = (raw: unknown, decoder: Decoder): void => {
  if (typeof raw === "number") {
    decoder.text(raw);
  } else if (typeof raw === "string") {
    const number = Number(raw);
    if (!Number.isFinite(number) || String(number) !== raw) throw new Malformed();
  } else if (Array.isArray(raw)) {
    decoder.tuples(raw, 2);
    for (let index = 0; index < raw.length; index += 2) {
      decoder.text(raw[index]);
      checkValue(raw[index + 1], decoder);
    }
  } else if (isRecord(raw)) {
    if (!Array.isArray(raw.a) || Object.keys(raw).length !== 1) throw new Malformed();
    for (const item of raw.a) checkValue(item, decoder);
  } else if (typeof raw !== "boolean" && raw !== null) {
    throw new Malformed();
  }
};

/** Decodes a value `checkValue` accepted. */
const decodeValue = (raw: unknown, strings: readonly string[]): unknown => {
  if (typeof raw === "number") return strings[raw];
  if (typeof raw === "string") return Number(raw);
  if (Array.isArray(raw)) {
    const entries: [string, unknown][] = [];
    for (let index = 0; index < raw.length; index += 2) {
      entries.push([strings[raw[index] as number]!, decodeValue(raw[index + 1], strings)]);
    }
    // fromEntries defines own properties, so a "__proto__" key stays data.
    return Object.fromEntries(entries);
  }
  if (isRecord(raw)) return (raw.a as unknown[]).map((item) => decodeValue(item, strings));
  return raw;
};

/** An encoded value moved from one table to another, without decoding it. */
const retable = (raw: unknown, from: readonly string[], to: StringTable): unknown => {
  if (typeof raw === "number") return to.ref(from[raw]!);
  if (Array.isArray(raw)) return raw.map((item) => retable(item, from, to));
  if (isRecord(raw)) return { a: (raw.a as unknown[]).map((item) => retable(item, from, to)) };
  return raw;
};

// A Tally encodes as [sessions, cells, versions]:
//   sessions: day, harness, via, sessions, fixedTokens, measured, ...
//   cells:    day, harness, via, [item, sessions, bare, chars, byModel, byUser, ...], ...
//   versions: harness, day, version, ...

const encodeTally = (tally: Tally, table: StringTable): unknown => {
  const sessions: number[] = [];
  for (const cell of tally.sessions) {
    sessions.push(table.ref(cell.day), table.ref(cell.harness), table.ref(cell.via));
    sessions.push(cell.sessions, cell.fixedTokens, cell.measured);
  }
  const cells: unknown[] = [];
  let group: number[] = [];
  let last: Cell | undefined;
  for (const cell of tally.cells) {
    if (last?.day !== cell.day || last.harness !== cell.harness || last.via !== cell.via) {
      group = [];
      cells.push(table.ref(cell.day), table.ref(cell.harness), table.ref(cell.via), group);
    }
    group.push(
      table.ref(cell.item),
      cell.sessions,
      cell.bare,
      cell.chars,
      cell.byModel,
      cell.byUser,
    );
    last = cell;
  }
  const versions: number[] = [];
  for (const seen of tally.versions) {
    versions.push(table.ref(seen.harness), table.ref(seen.day), table.ref(seen.version));
  }
  return [sessions, cells, versions];
};

const decodeTally = (raw: unknown, decoder: Decoder): Tally => {
  const parts = decoder.tuples(raw, 3);
  if (parts.length !== 3) throw new Malformed();
  const [rawSessions, rawCells, rawVersions] = parts;

  const sessions: SessionCell[] = [];
  const flatSessions = decoder.tuples(rawSessions, 6);
  for (let index = 0; index < flatSessions.length; index += 6) {
    sessions.push({
      day: decoder.day(flatSessions[index]),
      harness: decoder.text(flatSessions[index + 1]),
      via: decoder.text(flatSessions[index + 2]),
      sessions: decoder.count(flatSessions[index + 3]),
      fixedTokens: decoder.count(flatSessions[index + 4]),
      measured: decoder.count(flatSessions[index + 5]),
    });
  }

  const cells: Cell[] = [];
  const groups = decoder.tuples(rawCells, 4);
  for (let index = 0; index < groups.length; index += 4) {
    const day = decoder.day(groups[index]);
    const harness = decoder.text(groups[index + 1]);
    const via = decoder.text(groups[index + 2]);
    const items = decoder.tuples(groups[index + 3], 6);
    for (let at = 0; at < items.length; at += 6) {
      cells.push({
        day,
        harness,
        via,
        item: decoder.text(items[at]),
        sessions: decoder.count(items[at + 1]),
        bare: decoder.count(items[at + 2]),
        chars: decoder.count(items[at + 3]),
        byModel: decoder.count(items[at + 4]),
        byUser: decoder.count(items[at + 5]),
      });
    }
  }

  const versions: VersionSeen[] = [];
  const flatVersions = decoder.tuples(rawVersions, 3);
  for (let index = 0; index < flatVersions.length; index += 3) {
    versions.push({
      harness: decoder.text(flatVersions[index]),
      day: decoder.day(flatVersions[index + 1]),
      version: decoder.text(flatVersions[index + 2]),
    });
  }
  return { sessions, cells, versions };
};

// A CachedFile encodes as [size, mtimeMs, hasTail (0 or 1), offset, guardLength, guardHash, state, tally].

const encodeFile = (file: CachedFile, state: unknown, table: StringTable): unknown[] => {
  const { position } = file;
  return [
    file.size,
    file.mtimeMs,
    file.hasTail ? 1 : 0,
    position.offset,
    position.guardLength,
    position.guardHash,
    state,
    encodeTally(file.tally, table),
  ];
};

/** The entry and its encoded state, which is decoded only when a read resumes from it. */
const decodeFile = (raw: unknown, decoder: Decoder): { file: CachedFile; state: unknown } => {
  if (!Array.isArray(raw) || raw.length !== 8) throw new Malformed();
  const [size, mtimeMs, hasTail, offset, guardLength, guardHash, state, tally] = raw;
  if (typeof mtimeMs !== "number" || (hasTail !== 0 && hasTail !== 1)) throw new Malformed();
  checkValue(state, decoder);
  let decoded: { value: unknown } | undefined;
  const strings = decoder.strings;
  const file: CachedFile = {
    size: decoder.count(size),
    mtimeMs,
    hasTail: hasTail === 1,
    position: {
      offset: decoder.count(offset),
      guardLength: decoder.count(guardLength),
      guardHash: decoder.count(guardHash),
      get state() {
        decoded ??= { value: decodeValue(state, strings) };
        return decoded.value;
      },
    },
    tally: decodeTally(tally, decoder),
  };
  return { file, state };
};

/**
 * Opens one harness's cache in `dir`. A missing, corrupt or stale cache (another tool version
 * or transcript format) opens empty, so the run starts cold; a malformed entry opens as a miss.
 */
export const openCache = async (
  dir: string,
  harness: string,
  tool: string,
  format: TranscriptFormat<unknown>,
): Promise<HarnessCache> => {
  const file = join(dir, `${harness.replace(/[^\w.-]/gu, "_")}.json`);
  const fingerprint = formatFingerprint(format);
  let entries = new Map<string, unknown>();
  let decoder = new Decoder([]);
  let salt: string | undefined;

  const stored: unknown = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (
    isRecord(stored) &&
    stored.layout === CACHE_LAYOUT &&
    stored.tool === tool &&
    stored.format === fingerprint &&
    typeof stored.salt === "string" &&
    Array.isArray(stored.strings) &&
    stored.strings.every((text) => typeof text === "string") &&
    isRecord(stored.files)
  ) {
    salt = stored.salt;
    entries = new Map(Object.entries(stored.files));
    decoder = new Decoder(stored.strings as string[]);
  }
  // A fresh salt per cold cache, so keys cannot be matched against a guessed path's hash.
  const keySalt = salt ?? randomBytes(16).toString("hex");

  /** Entries decoded by `get`, null when malformed. */
  const opened = new Map<string, CachedFile | null>();
  /** The encoded state of each CachedFile `get` returned, to save it without decoding. */
  const states = new WeakMap<CachedFile, unknown>();

  const unchanged = (next: ReadonlyMap<string, CachedFile>) => {
    if (salt === undefined || next.size !== entries.size) return false;
    for (const [key, entry] of next) if (opened.get(key) !== entry) return false;
    return true;
  };

  return {
    key: (path) => sha256(`${keySalt}\u0000${path}`),
    get(key) {
      let entry = opened.get(key);
      if (entry === undefined && entries.has(key)) {
        try {
          const { file, state } = decodeFile(entries.get(key), decoder);
          states.set(file, state);
          entry = file;
        } catch {
          // Malformed: read the transcript again, as if it were not cached.
          entry = null;
        }
        opened.set(key, entry);
      }
      return entry ?? undefined;
    },
    async save(next) {
      if (unchanged(next)) return;
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        const table = new StringTable();
        const files: Record<string, unknown> = {};
        for (const [key, entry] of next) {
          const state = states.has(entry)
            ? retable(states.get(entry), decoder.strings, table)
            : encodeValue(entry.position.state, table);
          files[key] = encodeFile(entry, state, table);
        }
        const document = {
          layout: CACHE_LAYOUT,
          tool,
          format: fingerprint,
          salt: keySalt,
          strings: table.strings,
          files,
        };
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(document), { mode: 0o600 });
        await rename(temporary, file);
      } catch {
        // The cache only saves time: a run that cannot write it still returns its Scan.
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
};

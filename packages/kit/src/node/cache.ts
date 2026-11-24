// The scan cache: the only thing loadsheet writes. Per transcript file it keeps where reading
// stopped and the counters the committed lines gave, so a warm run reads only new bytes. It holds
// no transcript text, session id, file name or path: files are keyed by a salted hash.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tally, TranscriptFormat } from "../index.ts";
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
  /** Writes `files` as the whole cache, atomically; files it leaves out are forgotten. */
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
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

const isCachedFile = (value: unknown): value is CachedFile => {
  if (!isRecord(value) || !isRecord(value.position) || !isRecord(value.tally)) return false;
  const { position, tally } = value;
  return (
    isCount(value.size) &&
    typeof value.mtimeMs === "number" &&
    typeof value.hasTail === "boolean" &&
    isCount(position.offset) &&
    isCount(position.guardLength) &&
    isCount(position.guardHash) &&
    Array.isArray(tally.sessions) &&
    Array.isArray(tally.cells) &&
    Array.isArray(tally.versions)
  );
};

/**
 * Opens one harness's cache in `dir`. A missing, corrupt or stale cache (another tool version
 * or transcript format) opens empty, so the run starts cold.
 */
export const openCache = async (
  dir: string,
  harness: string,
  tool: string,
  format: TranscriptFormat<unknown>,
): Promise<HarnessCache> => {
  const file = join(dir, `${harness.replace(/[^\w.-]/gu, "_")}.json`);
  const fingerprint = formatFingerprint(format);
  const files = new Map<string, CachedFile>();
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
    isRecord(stored.files)
  ) {
    salt = stored.salt;
    for (const [key, entry] of Object.entries(stored.files)) {
      if (isCachedFile(entry)) files.set(key, entry);
    }
  }
  // A fresh salt per cold cache, so keys cannot be matched against a guessed path's hash.
  const keySalt = salt ?? randomBytes(16).toString("hex");

  return {
    key: (path) => sha256(`${keySalt}\u0000${path}`),
    get: (key) => files.get(key),
    async save(next) {
      const document = {
        layout: CACHE_LAYOUT,
        tool,
        format: fingerprint,
        salt: keySalt,
        files: Object.fromEntries(next),
      };
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
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

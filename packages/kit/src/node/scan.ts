import { readFile, stat } from "node:fs/promises";
import { availableParallelism, homedir, hostname } from "node:os";
import { posix } from "node:path";
import type { Day, Scan } from "@loadsheet/schema";
import {
  buildScan,
  sumTallies,
  type Files,
  type Harness,
  type HarnessScan,
  type MachineReader,
  type Place,
  type Tally,
} from "../index.ts";
import { defaultCacheDir, openCache, type CachedFile } from "./cache.ts";
import { dirFiles } from "./files.ts";
import { reachesOf, withReach } from "./reach.ts";
import { listTranscriptFiles, type TranscriptFile } from "./reader.ts";
import {
  openTranscriptPool,
  readTranscriptTally,
  type TranscriptJob,
  type TranscriptPool,
  type TranscriptRead,
} from "./workers.ts";

export interface ScanMachineOptions {
  /** The harnesses to read; those without a `machine` reader are skipped. */
  readonly harnesses: readonly Harness[];
  /** Days of history, today included. */
  readonly days: number;
  /** The tool and version writing the Scan, such as `loadsheet@0.0.1`; a new one starts the cache cold. */
  readonly tool: string;
  /** The machine's name; default the hostname. */
  readonly machine?: string;
  /** The scan time, which sets the window's last day; default now. */
  readonly now?: Date;
  /** Where things are; default this user's home and environment. */
  readonly place?: Place;
  /**
   * The cache directory, or false to read every transcript in full and write nothing; default
   * `defaultCacheDir(place)`. It is loadsheet's own: loadsheet makes it readable by this user
   * only, and writes no cache in a directory it cannot make so.
   */
  readonly cacheDir?: string | false;
  /** Transcript files read at once; default 16, or two per worker when that is more. */
  readonly concurrency?: number;
  /**
   * A module that calls `serveTranscripts` with the harnesses' formats. When given, transcripts
   * the cache does not hold are read on worker threads running it, so a first run uses more than
   * one core; without it they are read on this thread.
   */
  readonly worker?: URL | string;
  /** The most worker threads to start; default one fewer than the cores, at most 8. */
  readonly workers?: number;
  /** Called as each harness's transcript files are read: how many of how many are done. */
  readonly onProgress?: (progress: ScanProgress) => void;
}

/** How far a scan has got through one harness's transcript files. */
export interface ScanProgress {
  readonly harness: string;
  /** Files read, from the cache or in full. */
  readonly done: number;
  /** Files to read for this harness. */
  readonly total: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms: number): Day => new Date(ms).toISOString().slice(0, 10);

/** The window of `days` days ending on `now`'s UTC day, and the instant it starts. */
export const scanWindow = (now: Date, days: number): { window: [Day, Day]; sinceMs: number } => {
  if (!Number.isSafeInteger(days) || days < 1)
    throw new Error("days must be a whole number of 1 or more");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMs = today - (days - 1) * DAY_MS;
  return { window: [dayOf(sinceMs), dayOf(today)], sinceMs };
};

/** `path` by its spelling alone, without a trailing `/`, as the adapters' `normalPath` spells it. */
const normal = (path: string) => posix.normalize(path).replace(/(?<=.)\/+$/u, "");

/** `path` keyed `~/...` under `home`, and absolute elsewhere. */
const homeKey = (path: string, home: string) => {
  const root = normal(home);
  const at = normal(path);
  if (at === root) return "~";
  return at.startsWith(`${root}/`) ? `~/${at.slice(root.length + 1)}` : at;
};

/** A source file a harness names, such as `~/.claude.json`, which grows with use past MAX_FILE_BYTES. */
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;

/** A harness's sources as one Files; a source that is missing or unreadable is left out. */
const sourceFiles = async (sources: readonly string[], home: string): Promise<Files> => {
  const readers = new Map<string, () => Promise<string | undefined>>();
  for (const source of sources) {
    const info = await stat(source).catch(() => undefined);
    const key = homeKey(source, home);
    if (info?.isDirectory()) {
      const files = await dirFiles(source).catch(() => undefined);
      for (const path of files?.paths ?? []) {
        readers.set(`${key}/${path}`, () => files!.text(path).catch(() => undefined));
      }
    } else if (info?.isFile()) {
      readers.set(key, async () =>
        info.size > MAX_SOURCE_FILE_BYTES
          ? undefined
          : readFile(source, "utf8").catch(() => undefined),
      );
    }
  }
  return { paths: [...readers.keys()].sort(), text: async (path) => readers.get(path)?.() };
};

/** Runs `task` on every item, at most `limit` at a time. */
const eachLimited = async <T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> => {
  const queue = items.values();
  const worker = async () => {
    for (const item of queue) await task(item);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Every transcript file under `roots` changed since `sinceMs`, each once. */
const transcriptFiles = async (roots: readonly string[], sinceMs: number) => {
  const files = new Map<string, TranscriptFile>();
  for (const root of roots) {
    for (const file of (await listTranscriptFiles(root, sinceMs)).files) files.set(file.path, file);
  }
  return [...files.values()];
};

/** Fewer files than this are read on this thread: starting workers would cost more than it saves. */
const MIN_POOLED_FILES = 8;
/** Files each worker reads at once, so one waits on the disk while another parses. */
const READS_PER_WORKER = 2;

/** One harness's counters from its transcripts, reading from the cache what has not changed. */
const readTranscripts = async (
  machine: MachineReader<unknown>,
  harness: string,
  place: Place,
  sinceMs: number,
  options: {
    tool: string;
    cacheDir: string | false;
    concurrency: number;
    pool: (files: number) => TranscriptPool | undefined;
    onProgress?: (progress: ScanProgress) => void;
  },
): Promise<Tally[]> => {
  const format = machine.transcripts;
  // An inventory-only harness: no transcripts to read, and no cache to open for it.
  if (!format || !machine.roots) return [];
  const cache =
    options.cacheDir === false
      ? undefined
      : await openCache(options.cacheDir, harness, options.tool, format);
  const files = await transcriptFiles(machine.roots(place), sinceMs);
  const kept = new Map<string, CachedFile>();
  const tallies: Tally[] = [];
  const toRead: { file: TranscriptFile; key?: string; resume?: CachedFile }[] = [];
  for (const file of files) {
    const key = cache?.key(file.path);
    const cached = key === undefined ? undefined : cache?.get(key);
    const unchanged =
      cached?.size === file.size &&
      cached.mtimeMs === file.mtimeMs &&
      cached.ctimeMs === file.ctimeMs;
    if (cached && unchanged && !cached.hasTail) {
      kept.set(key!, cached);
      tallies.push(cached.tally);
      continue;
    }
    // A file that changed without growing may have been rewritten before the cached position.
    const resume = cached && (unchanged || file.size > cached.size) ? cached : undefined;
    toRead.push({ file, ...(key === undefined ? {} : { key }), ...(resume ? { resume } : {}) });
  }

  let done = files.length - toRead.length;
  options.onProgress?.({ harness, done, total: files.length });

  const pool = options.pool(toRead.length);
  const read = (job: TranscriptJob): Promise<TranscriptRead | null> =>
    pool ? pool.read(job) : readTranscriptTally(format, job);
  const atOnce = Math.max(options.concurrency, pool ? pool.size * READS_PER_WORKER : 0);
  await eachLimited(toRead, atOnce, async ({ file, key, resume }) => {
    try {
      const result = await read({
        harness,
        path: file.path,
        ...(resume ? { position: resume.position } : {}),
      });
      if (result === null) return;
      const committed =
        result.resumed && resume ? sumTallies([resume.tally, result.fresh]) : result.fresh;
      tallies.push(committed, result.tail);
      if (key !== undefined) {
        kept.set(key, {
          size: file.size,
          mtimeMs: file.mtimeMs,
          ctimeMs: file.ctimeMs,
          // A compressed file is read in full, so only its tail Facts make it worth reading again.
          hasTail: file.path.endsWith(".zst")
            ? result.tailFacts
            : result.position.offset < file.size,
          position: result.position,
          tally: committed,
        });
      }
    } finally {
      done += 1;
      options.onProgress?.({ harness, done, total: files.length });
    }
  });

  // Files no longer listed, deleted or older than the window, leave the cache with their counters.
  await cache?.save(kept);
  return tallies;
};

/**
 * Scans this machine: for each harness with a `machine` reader, whether it is installed, what is
 * installed for it, and the counters of its sessions that started in the last `days` days.
 * Only the cache directory is written.
 */
export const scanMachine = async (options: ScanMachineOptions): Promise<Scan> => {
  const now = options.now ?? new Date();
  const place: Place = options.place ?? {
    home: homedir(),
    env: process.env,
    cwd: process.cwd(),
  };
  const cacheDir = options.cacheDir ?? defaultCacheDir(place);
  const maxWorkers = options.workers ?? Math.min(8, availableParallelism() - 1);
  const { window, sinceMs } = scanWindow(now, options.days);

  // Started for the first harness with enough files to read, and kept for the others.
  let pool: TranscriptPool | undefined;
  const poolFor = (files: number) => {
    if (pool || !options.worker || maxWorkers < 1 || files < MIN_POOLED_FILES) return pool;
    pool = openTranscriptPool(options.worker, Math.min(maxWorkers, Math.ceil(files / 4)));
    return pool;
  };

  const parts: HarnessScan[] = [];
  try {
    for (const harness of options.harnesses) {
      const machine = harness.machine;
      if (!machine) continue;
      const installed = await exists(machine.home(place));
      // An inventory-only harness that is not installed claims nothing, though it would find
      // skills in a folder it shares with others, such as `~/.agents/skills`.
      const files =
        installed || machine.transcripts
          ? await sourceFiles(machine.sources(place), place.home)
          : undefined;
      const items = files ? await machine.inventory(files, place) : [];
      const contextWindow = files ? await machine.contextWindow?.(files) : undefined;
      const tallies = await readTranscripts(machine, harness.id, place, sinceMs, {
        tool: options.tool,
        cacheDir,
        concurrency: options.concurrency ?? 16,
        pool: poolFor,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
      parts.push({
        harness: harness.id,
        installed,
        signals: harness.signals,
        items,
        tally: sumTallies(tallies, window),
        ...(contextWindow === undefined ? {} : { contextWindow }),
      });
    }
  } finally {
    await pool?.close();
  }

  // What removing each Item reaches, across every harness's Items, since one harness's folder can
  // hold or lead through another's.
  const reaches = reachesOf(
    parts.flatMap((part) => part.items.map((item) => item.path)),
    place.home,
  );

  return buildScan({
    tool: options.tool,
    machine: options.machine ?? hostname(),
    scannedAt: now.toISOString(),
    window,
    harnesses: parts.map((part) => ({
      ...part,
      items: part.items.map((item) => withReach(item, reaches)),
    })),
  });
};

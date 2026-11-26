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
  type TranscriptFormat,
} from "../index.ts";
import { defaultCacheDir, openCache, type CachedFile, type HarnessCache } from "./cache.ts";
import { dirFiles } from "./files.ts";
import { reachesOf, withReach } from "./reach.ts";
import { listTranscriptFiles, type TranscriptFile } from "./reader.ts";
import {
  openTranscriptPool,
  readTranscriptTally,
  type TranscriptJob,
  type TranscriptPool,
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
  /** Transcript files read at once on this thread, when no worker reads them; default 16. */
  readonly concurrency?: number;
  /**
   * A module that calls `serveTranscripts` with the harnesses' formats. When given, and there is
   * enough to read, transcripts the cache does not hold are read on worker threads running it,
   * so a first run uses more than one core; else they are read on this thread.
   */
  readonly worker?: URL | string;
  /** The most worker threads to start; default one fewer than the cores. */
  readonly workers?: number;
  /** Bytes to read below which no worker thread starts; default MIN_POOLED_BYTES. */
  readonly minPooledBytes?: number;
  /** Called as transcript files are read: how many files and bytes of how many are done. */
  readonly onProgress?: (progress: ScanProgress) => void;
}

/** How far a scan has got through every harness's transcript files. */
export interface ScanProgress {
  /** Files read, from the cache or in full. */
  readonly done: number;
  /** Files to read. */
  readonly total: number;
  /** Bytes read, counting those the cache holds as read at once. */
  readonly doneBytes: number;
  /** Bytes of every file to read. */
  readonly totalBytes: number;
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

/** Less than this to read is read on this thread: starting a worker would cost more than it saves. */
export const MIN_POOLED_BYTES = 32 * 1024 * 1024;

/**
 * The worker threads worth starting for `files` files holding `bytes` bytes, at most `max`. Each
 * thread costs a start and a share of the cores and memory it runs beside, so the best count grows
 * far slower than the bytes: measured on 100 MB, 300 MB, 1.35 GB, 2.6 GB and 8 GB of transcripts
 * it was about 4, 6, 7, 6 to 11 and 11 to 15 threads, the fourth root of the MB, times 1.25. One
 * thread per 32 MB ran 10 to 20% slower from 300 MB up, using up to 30% more CPU.
 */
export const workersFor = (
  files: number,
  bytes: number,
  max: number,
  minPooledBytes = MIN_POOLED_BYTES,
): number => {
  if (bytes < minPooledBytes || files < 1 || max < 1) return 0;
  const best = Math.floor(1.25 * (bytes / (1024 * 1024)) ** 0.25);
  return Math.max(1, Math.min(max, files, best));
};

/** A transcript file the cache does not hold as it is, and the bytes of it to read. */
interface ToRead {
  readonly file: TranscriptFile;
  readonly key?: string;
  readonly resume?: CachedFile;
  readonly bytes: number;
}

/** One harness's transcript files: the cache, what it holds unchanged, and what to read. */
interface TranscriptPlan {
  readonly harness: string;
  readonly format: TranscriptFormat<unknown>;
  readonly cache: HarnessCache | undefined;
  readonly kept: Map<string, CachedFile>;
  readonly fromCache: CachedFile[];
  readonly toRead: ToRead[];
  /** Bytes of the files the cache holds unchanged, and of the parts of others it holds. */
  readonly cachedBytes: number;
  readonly tallies: Tally[];
}

/** Lists one harness's transcript files and sorts them into those the cache holds and those to read. */
const planTranscripts = async (
  machine: MachineReader<unknown>,
  harness: string,
  place: Place,
  sinceMs: number,
  options: { tool: string; cacheDir: string | false },
): Promise<TranscriptPlan | undefined> => {
  const format = machine.transcripts;
  // An inventory-only harness: no transcripts to read, and no cache to open for it.
  if (!format || !machine.roots) return undefined;
  const cache =
    options.cacheDir === false
      ? undefined
      : await openCache(options.cacheDir, harness, options.tool, format);
  const files = await transcriptFiles(machine.roots(place), sinceMs);
  const kept = new Map<string, CachedFile>();
  const fromCache: CachedFile[] = [];
  const toRead: ToRead[] = [];
  let cachedBytes = 0;
  for (const file of files) {
    const key = cache?.key(file.path);
    const cached = key === undefined ? undefined : cache?.get(key);
    const unchanged =
      cached?.size === file.size &&
      cached.mtimeMs === file.mtimeMs &&
      cached.ctimeMs === file.ctimeMs;
    if (cached && unchanged && !cached.hasTail) {
      kept.set(key!, cached);
      fromCache.push(cached);
      cachedBytes += file.size;
      continue;
    }
    // A file that changed without growing may have been rewritten before the cached position.
    const resume = cached && (unchanged || file.size > cached.size) ? cached : undefined;
    const from = resume ? Math.min(resume.position.offset, file.size) : 0;
    cachedBytes += from;
    toRead.push({
      file,
      bytes: file.size - from,
      ...(key === undefined ? {} : { key }),
      ...(resume ? { resume } : {}),
    });
  }
  return { harness, format, cache, kept, fromCache, toRead, cachedBytes, tallies: [] };
};

/**
 * Reads every plan's files that the cache does not hold, largest first across harnesses, so the
 * last reads of a run are small ones. Each plan's tallies and kept entries are filled in.
 */
const readPlans = async (
  plans: readonly TranscriptPlan[],
  options: {
    concurrency: number;
    pool: TranscriptPool | undefined;
    onProgress?: (progress: ScanProgress) => void;
  },
): Promise<void> => {
  const reads = plans
    .flatMap((plan) => plan.toRead.map((read) => ({ plan, ...read })))
    .sort((a, b) => b.bytes - a.bytes);
  const toReadBytes = reads.reduce((sum, read) => sum + read.bytes, 0);
  const progress = {
    done: plans.reduce((sum, plan) => sum + plan.fromCache.length, 0),
    total: plans.reduce((sum, plan) => sum + plan.fromCache.length + plan.toRead.length, 0),
    doneBytes: plans.reduce((sum, plan) => sum + plan.cachedBytes, 0),
    totalBytes: 0,
  };
  progress.totalBytes = progress.doneBytes + toReadBytes;
  options.onProgress?.({ ...progress });

  const { pool } = options;
  const readOne = async ({ plan, file, key, resume, bytes }: (typeof reads)[number]) => {
    try {
      const job: TranscriptJob = {
        harness: plan.harness,
        path: file.path,
        ...(resume ? { position: resume.position } : {}),
      };
      const result = await (pool ? pool.read(job, bytes) : readTranscriptTally(plan.format, job));
      if (result === null) return;
      const committed =
        result.resumed && resume ? sumTallies([resume.tally, result.fresh]) : result.fresh;
      plan.tallies.push(committed, result.tail);
      if (key !== undefined) {
        plan.kept.set(key, {
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
      progress.done += 1;
      progress.doneBytes += bytes;
      options.onProgress?.({ ...progress });
    }
  };
  // The pool queues every read and starts each when a thread is free; this thread reads a few at once.
  if (pool) await Promise.all(reads.map(readOne));
  else await eachLimited(reads, options.concurrency, readOne);
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
  const maxWorkers = options.workers ?? availableParallelism() - 1;
  const { window, sinceMs } = scanWindow(now, options.days);

  // Started once a listing shows enough to read, and grown by the next, so threads start while
  // the next harness is listed. Starting them before any listing costs a small first run more
  // than it saves a large one.
  let pool: TranscriptPool | undefined;
  let plannedFiles = 0;
  let plannedBytes = 0;
  const growPool = (plan: TranscriptPlan) => {
    plannedFiles += plan.toRead.length;
    plannedBytes += plan.toRead.reduce((sum, read) => sum + read.bytes, 0);
    const size = workersFor(plannedFiles, plannedBytes, maxWorkers, options.minPooledBytes);
    if (!options.worker || size < 1) return;
    pool ??= openTranscriptPool(options.worker);
    pool.grow(size);
  };

  const machines = options.harnesses.flatMap((harness) =>
    harness.machine ? [{ harness, machine: harness.machine }] : [],
  );
  const parts: HarnessScan[] = [];
  try {
    const plans = new Map<string, TranscriptPlan>();
    for (const { harness, machine } of machines) {
      const plan = await planTranscripts(machine, harness.id, place, sinceMs, {
        tool: options.tool,
        cacheDir,
      });
      if (!plan) continue;
      plans.set(harness.id, plan);
      growPool(plan);
    }
    // Every harness's transcripts are read at once, while this thread reads what is installed.
    const reading = readPlans([...plans.values()], {
      concurrency: options.concurrency ?? 16,
      pool,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    reading.catch(() => {});

    const inventories = [];
    for (const { harness, machine } of machines) {
      const installed = await exists(machine.home(place));
      // An inventory-only harness that is not installed claims nothing, though it would find
      // skills in a folder it shares with others, such as `~/.agents/skills`.
      const files =
        installed || machine.transcripts
          ? await sourceFiles(machine.sources(place), place.home)
          : undefined;
      const items = files ? await machine.inventory(files, place) : [];
      const contextWindow = files ? await machine.contextWindow?.(files) : undefined;
      inventories.push({ harness, installed, items, contextWindow });
    }

    await reading;
    // Nothing is left to read, so the threads go before the caches are written.
    await pool?.close();
    for (const { harness, installed, items, contextWindow } of inventories) {
      const plan = plans.get(harness.id);
      const tallies = plan ? plan.tallies : [];
      if (plan?.cache && plan.fromCache.length)
        tallies.push(plan.cache.sum(plan.fromCache, window));
      // Files no longer listed, deleted or older than the window, leave the cache with their counters.
      await plan?.cache?.save(plan.kept);
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

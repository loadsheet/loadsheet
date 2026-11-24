import { readFile, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import type { Day, Scan } from "@loadsheet/schema";
import {
  buildScan,
  foldFacts,
  sumTallies,
  type Fact,
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
import { listTranscriptFiles, readTranscript, type TranscriptFile } from "./reader.ts";

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
  /** Transcript files read at once; default 16. */
  readonly concurrency?: number;
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

/** `path` keyed `~/...` under `home`, and absolute elsewhere. */
const homeKey = (path: string, home: string) => {
  const root = home.replace(/\/+$/u, "");
  if (path === root) return "~";
  return path.startsWith(`${root}/`) ? `~/${path.slice(root.length + 1)}` : path;
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

/** One harness's counters from its transcripts, reading from the cache what has not changed. */
const readTranscripts = async (
  machine: MachineReader<unknown>,
  harness: string,
  place: Place,
  sinceMs: number,
  options: { tool: string; cacheDir: string | false; concurrency: number },
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

  await eachLimited(files, options.concurrency, async (file) => {
    const key = cache?.key(file.path);
    const cached = key === undefined ? undefined : cache?.get(key);
    const unchanged =
      cached?.size === file.size &&
      cached.mtimeMs === file.mtimeMs &&
      cached.ctimeMs === file.ctimeMs;
    if (cached && unchanged && !cached.hasTail) {
      kept.set(key!, cached);
      tallies.push(cached.tally);
      return;
    }
    // A file that changed without growing may have been rewritten before the cached position.
    const resume = cached && (unchanged || file.size > cached.size) ? cached : undefined;
    let read = await readTranscript<unknown, Fact>(file.path, format, resume?.position);
    if (read === null && resume) read = await readTranscript<unknown, Fact>(file.path, format);
    if (read === null) return;
    const fresh = foldFacts(harness, read.records);
    const committed = read.resumed && resume ? sumTallies([resume.tally, fresh]) : fresh;
    tallies.push(committed, foldFacts(harness, read.tail));
    if (key !== undefined) {
      kept.set(key, {
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        // A compressed file is read in full, so only its tail Facts make it worth reading again.
        hasTail: file.path.endsWith(".zst")
          ? read.tail.length > 0
          : read.position.offset < file.size,
        position: read.position,
        tally: committed,
      });
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
  const place: Place = options.place ?? { home: homedir(), env: process.env };
  const cacheDir = options.cacheDir ?? defaultCacheDir(place);
  const concurrency = options.concurrency ?? 16;
  const { window, sinceMs } = scanWindow(now, options.days);

  const parts: HarnessScan[] = [];
  for (const harness of options.harnesses) {
    const machine = harness.machine;
    if (!machine) continue;
    const installed = await exists(machine.home(place));
    // An inventory-only harness that is not installed claims nothing, though it would find
    // skills in a folder it shares with others, such as `~/.agents/skills`.
    const items =
      installed || machine.transcripts
        ? await machine.inventory(await sourceFiles(machine.sources(place), place.home), place)
        : [];
    const tallies = await readTranscripts(machine, harness.id, place, sinceMs, {
      tool: options.tool,
      cacheDir,
      concurrency,
    });
    parts.push({
      harness: harness.id,
      installed,
      signals: harness.signals,
      items,
      tally: sumTallies(tallies, window),
    });
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

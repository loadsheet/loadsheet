// Decoding and merging adapted from T3 Code (vite-hub/t3code, apps/server/src/usage/
// usageScanCache.ts and usageAggregation.ts), MIT License, Copyright (c) 2026 T3 Tools Inc.
//
// T3 Code's usage cache, `~/.t3/userdata/usage-scan-cache-v<N>.json`: T3's own reading of each
// transcript file it scanned, one entry per file, kept after the file is deleted. Its root is
// `{ files: { <absolute path>: { p, r, t, ... } }, version, models, sessions }`; `p` is the
// provider, and `r` and `t` (the unterminated tail, which T3 counts too) are records:
//
//   [timestampMs, modelIndex, sessionIndex, uncachedInput, cachedInput, cacheCreation, output,
//    reasoning, dedupeKey, reportedCostUsd, speed, rateModelIndex?, unresolvedServiceTierTurnId?,
//    cacheCreation1h?, modelCalls?]
//
// `reduceScanCache` keeps the files of one provider whose session no listed transcript counts,
// and sums their records per session, file kind, UTC day and model. T3 counts a dedupe key once
// across every file, since Claude copies a session's requests into the transcript that resumes
// it: copies keep each counter's maximum, in the first copy's file. A key a listed transcript
// also holds counts there, so its copies here are dropped. The rows hold session ids and the
// project folder's name, so they are bound into a store's query and never reach a Fact.
import type { Day } from "@loadsheet/schema";

/** One file's sums for a day and model, or (with `start`) that the file is a conversation. */
export interface ScanCacheRow {
  /** The session id: the main transcript's name, which `$native` holds when it is listed. */
  readonly s: string;
  /** 1 for a subagent's file. */
  readonly sub: 0 | 1;
  /** The project folder the harness filed the transcript under, such as Claude's `-home-me-app`. */
  readonly dir: string;
  readonly day: Day;
  /** Only on the row that says a file is a conversation: its first request's day is `day`. */
  readonly start?: 1;
  readonly model?: string;
  /** Uncached input. */
  readonly u?: number;
  /** Read from the cache. */
  readonly c?: number;
  /** Written to the cache, of which `w1h` for an hour and `rw` again within the hour. */
  readonly w?: number;
  readonly w1h?: number;
  readonly rw?: number;
  /** Output, reasoning included. */
  readonly o?: number;
  readonly r?: number;
  /** Requests. */
  readonly n?: number;
}

/** Where a file's records go: its session, whether it is a subagent's, and its project folder. */
export interface CacheFile {
  readonly session: string;
  readonly subagent: boolean;
  readonly dir: string;
}

export interface ScanCacheOptions {
  /** T3's provider id, such as `claude`. */
  readonly provider: string;
  /** A file's session, or undefined to leave it out. */
  readonly file: (path: string) => CacheFile | undefined;
  /** The sessions a listed transcript counts. */
  readonly native: ReadonlySet<string>;
  /**
   * Whether a request's 5-minute cache write is counted again as `rw` when it comes 5 to 60
   * minutes after the file's previous request on the same model, as Claude Code's reader does.
   */
  readonly rewrites?: boolean;
}

interface Usage {
  at: number;
  model: string;
  key: string | undefined;
  u: number;
  c: number;
  w: number;
  w1h: number;
  o: number;
  r: number;
  n: number;
  rw: number;
  file: CacheFile;
}

const COUNTERS = ["u", "c", "w", "w1h", "rw", "o", "r", "n"] as const;
type Counter = (typeof COUNTERS)[number];
const zero = () => ({ u: 0, c: 0, w: 0, w1h: 0, rw: 0, o: 0, r: 0, n: 0 });
type Sum = Pick<ScanCacheRow, "s" | "sub" | "dir" | "day" | "model"> & Record<Counter, number>;

const REWRITE_MINUTES = [5, 60] as const;
const MINUTE_MS = 60_000;
/** Claude Code's model for local placeholders that never reached the API; T3 drops them. */
const SYNTHETIC = "<synthetic>";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tokens = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** A record as T3 decodes it, or undefined for one it would reject. */
const decode = (
  row: unknown,
  models: readonly unknown[],
  file: CacheFile,
  provider: string,
): Usage | undefined => {
  if (!Array.isArray(row) || row.length < 11) return undefined;
  const [at, modelIndex, , u, c, w, o, r, key, , , , , w1h, calls] = row as unknown[];
  const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
  if (typeof at !== "number" || !Number.isFinite(at) || typeof model !== "string") return undefined;
  if (provider === "claude" && model === SYNTHETIC) return undefined;
  return {
    at,
    model,
    key: typeof key === "string" ? key : undefined,
    u: tokens(u),
    c: tokens(c),
    w: tokens(w),
    w1h: tokens(w1h),
    o: tokens(o),
    r: tokens(r),
    n: calls === undefined ? 1 : Math.trunc(tokens(calls)),
    rw: 0,
    file,
  };
};

/** T3's `mergeUsageCopies`: each counter's maximum, in the held copy's place. */
const merge = (held: Usage, copy: Usage) => {
  held.u = Math.max(held.u, copy.u);
  held.c = Math.max(held.c, copy.c);
  held.w = Math.max(held.w, copy.w);
  held.w1h = Math.max(held.w1h, copy.w1h);
  held.o = Math.max(held.o, copy.o);
  held.r = Math.max(held.r, copy.r);
  held.n = Math.max(held.n, copy.n);
};

const utcDay = (ms: number): Day => new Date(ms).toISOString().slice(0, 10);

/**
 * The provider's files in T3 Code's usage cache whose session no listed transcript counts, as
 * rows per session, file kind, day and model, plus one `start` row per file. Anything it cannot
 * read gives no rows.
 */
export const reduceScanCache = (document: unknown, options: ScanCacheOptions): ScanCacheRow[] => {
  if (!isRecord(document) || !isRecord(document.files) || !Array.isArray(document.models)) {
    return [];
  }
  const { models } = document;
  const gone: Usage[][] = [];
  const listed: unknown[][] = [];
  for (const [path, entry] of Object.entries(document.files)) {
    if (!isRecord(entry) || entry.p !== options.provider) continue;
    const file = options.file(path);
    if (!file) continue;
    const rows = [
      ...(Array.isArray(entry.r) ? entry.r : []),
      ...(Array.isArray(entry.t) ? entry.t : []),
    ];
    if (options.native.has(file.session)) {
      listed.push(rows);
      continue;
    }
    const records = rows.flatMap((row) => decode(row, models, file, options.provider) ?? []);
    if (records.length === 0) continue;
    records.sort((a, b) => a.at - b.at);
    if (options.rewrites) {
      let minute: number | undefined;
      let model: string | undefined;
      for (const record of records) {
        const now = Math.floor(record.at / MINUTE_MS);
        const gap = minute === undefined ? -1 : now - minute;
        if (record.model === model && gap >= REWRITE_MINUTES[0] && gap < REWRITE_MINUTES[1]) {
          record.rw = Math.max(0, record.w - record.w1h);
        }
        minute = now;
        model = record.model;
      }
    }
    gone.push(records);
  }

  // The first copy of a key holds it, so the earliest file is where a copied request counts.
  gone.sort((a, b) => a[0]!.at - b[0]!.at);
  const held = new Map<string, Usage>();
  const kept: Usage[] = [];
  const starts = new Map<CacheFile, number>();
  for (const records of gone) {
    starts.set(records[0]!.file, records[0]!.at);
    for (const record of records) {
      if (record.key === undefined) {
        kept.push(record);
        continue;
      }
      const first = held.get(record.key);
      if (first) merge(first, record);
      else held.set(record.key, record);
    }
  }
  for (const rows of listed) {
    for (const row of rows) {
      const key = Array.isArray(row) ? row[8] : undefined;
      if (typeof key === "string") held.delete(key);
    }
  }

  const sums = new Map<string, Sum>();
  for (const record of [...kept, ...held.values()]) {
    const { session, subagent, dir } = record.file;
    const day = utcDay(record.at);
    const id = JSON.stringify([session, subagent, dir, day, record.model]);
    let sum = sums.get(id);
    if (!sum) {
      sum = { s: session, sub: subagent ? 1 : 0, dir, day, model: record.model, ...zero() };
      sums.set(id, sum);
    }
    for (const counter of COUNTERS) sum[counter] += record[counter];
  }
  const rows: ScanCacheRow[] = [...sums.values()];
  for (const [file, at] of starts) {
    rows.push({
      s: file.session,
      sub: file.subagent ? 1 : 0,
      dir: file.dir,
      day: utcDay(at),
      start: 1,
    });
  }
  return rows;
};

const CLAUDE_MAIN = /^.*\/projects\/([^/]+)\/([^/]+)\.jsonl$/u;
const CLAUDE_SUBAGENT = /^.*\/projects\/([^/]+)\/([^/]+)\/subagents\/.+\.jsonl$/u;

/**
 * A Claude Code transcript's session: `projects/<folder>/<session>.jsonl` is its main
 * conversation, and every file under `projects/<folder>/<session>/subagents/` one of its subagents'.
 */
export const claudeCacheFile = (path: string): CacheFile | undefined => {
  const main = CLAUDE_MAIN.exec(path);
  if (main) return { session: main[2]!, subagent: false, dir: main[1]! };
  const subagent = CLAUDE_SUBAGENT.exec(path);
  return subagent ? { session: subagent[2]!, subagent: true, dir: subagent[1]! } : undefined;
};

/** T3 Code's usage cache, the newest version in its data folder. */
export const t3ScanCachePath = (home: string) => ({
  dir: `${home}/.t3/userdata`,
  pattern: /^usage-scan-cache-v(\d+)\.json$/u,
});

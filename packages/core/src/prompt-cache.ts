// How long Claude Code's prompt cache lived, day by day, from the 5-minute and 1-hour cache writes
// of its main conversations. The cache-ttl rule judges the last days; a view prints the trend.
import type { Day, Usage } from "@loadsheet/schema";

/** Cache writes a day needs, over its main conversations, before its lifetime is judged. */
export const CACHE_DAY_WRITES = 1_000_000;
/** Days judged: the last ones that hold CACHE_DAY_WRITES. */
export const CACHE_DAYS = 3;
/** The share of a day's cache writes that makes it a 5-minute day, at least. */
export const CACHE_5M_SHARE = 0.5;

/** One day of an entrypoint's main conversations that wrote CACHE_DAY_WRITES or more. */
export interface PromptCacheDay {
  day: Day;
  /** Tokens written to the cache for 5 minutes. */
  cacheWrite5m: number;
  /** Tokens written to the cache for 1 hour. */
  cacheWrite1h: number;
  /** Cache-write tokens of requests 5 to 60 minutes after the one before in their conversation. */
  cacheRewrite: number;
  /** Whether at least CACHE_5M_SHARE of its writes were for 5 minutes. */
  fiveMinute: boolean;
}

/** One entrypoint's cache lifetime over the window. */
export interface PromptCache {
  /** The entrypoint, or `all` when entrypoints are summed. */
  via: string;
  /** Its days that wrote CACHE_DAY_WRITES or more, oldest first. */
  days: PromptCacheDay[];
  /** The lifetime of the last CACHE_DAYS days, when all of them agree; undefined with fewer days or a mix. */
  recent?: "5m" | "1h";
  /** The first of the recent 1-hour days, when an earlier day was a 5-minute one. */
  stopped?: Day;
}

/**
 * Each entrypoint's prompt cache lifetime, day by day, over the main conversations of `harness`
 * in `usage`; with `byVia` false, one entry for all of them. Sorted by entrypoint.
 */
export const promptCacheDays = (
  usage: Usage | undefined,
  { harness = "claude-code", byVia = true }: { harness?: string; byVia?: boolean } = {},
): PromptCache[] => {
  const vias = new Map<string, Map<Day, PromptCacheDay>>();
  for (const cell of usage?.tokens ?? []) {
    if (cell.harness !== harness || cell.thread !== "main") continue;
    const via = byVia ? cell.via : "all";
    const days = vias.get(via) ?? new Map<Day, PromptCacheDay>();
    vias.set(via, days);
    const known = days.get(cell.day) ?? {
      day: cell.day,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRewrite: 0,
      fiveMinute: false,
    };
    known.cacheWrite5m += cell.cacheWrite5m;
    known.cacheWrite1h += cell.cacheWrite1h;
    known.cacheRewrite += cell.cacheRewrite;
    days.set(cell.day, known);
  }
  return [...vias]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([via, byDay]) => {
      const days = [...byDay.values()]
        .filter((day) => day.cacheWrite5m + day.cacheWrite1h >= CACHE_DAY_WRITES)
        .sort((a, b) => (a.day < b.day ? -1 : 1))
        .map((day) => ({
          ...day,
          fiveMinute: day.cacheWrite5m >= CACHE_5M_SHARE * (day.cacheWrite5m + day.cacheWrite1h),
        }));
      const out: PromptCache = { via, days };
      const recent = days.slice(-CACHE_DAYS);
      if (recent.length === CACHE_DAYS) {
        if (recent.every((day) => day.fiveMinute)) out.recent = "5m";
        else if (recent.every((day) => !day.fiveMinute)) out.recent = "1h";
      }
      const last5m = days.findLastIndex((day) => day.fiveMinute);
      if (out.recent === "1h" && last5m >= 0) out.stopped = days[last5m + 1]!.day;
      return out;
    });
};

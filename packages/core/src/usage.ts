// Usage counters summed over machines. core cannot import kit's Accumulator, so this sums the
// cells a Scan already holds; the cells are additive, so summing them is all a Report needs, but
// for the limits, a gauge that keeps the latest reading.
import { mergeUsageLimit } from "@loadsheet/schema";
import type {
  Usage,
  UsageHourCell,
  UsageLimitCell,
  UsageSessionCell,
  UsageTokenCell,
  UsageToolCell,
  UsageTurnCell,
} from "@loadsheet/schema";

const SEP = "\u0000";
const sessionKey = (cell: UsageSessionCell) =>
  [cell.day, cell.harness, cell.via, cell.project, cell.thread].join(SEP);
const tokenKey = (cell: UsageTokenCell) =>
  [cell.day, cell.harness, cell.via, cell.project, cell.thread, cell.model].join(SEP);
const turnKey = (cell: UsageTurnCell) =>
  [cell.day, cell.harness, cell.via, cell.project, cell.thread].join(SEP);
const hourKey = (cell: UsageHourCell) =>
  [cell.day, cell.harness, cell.thread, String(cell.hour).padStart(2, "0")].join(SEP);
const toolKey = (cell: UsageToolCell) => [cell.day, cell.harness, cell.thread, cell.tool].join(SEP);
const limitKey = (cell: UsageLimitCell) =>
  [cell.day, cell.harness, String(cell.windowMinutes).padStart(9, "0")].join(SEP);

const SESSION_COUNTS = ["sessions", "compacted", "compactions", "manualCompactions"] as const;
const TOKEN_COUNTS = [
  "requests",
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRewrite",
] as const;
const TURN_COUNTS = [
  "turns",
  "interrupted",
  "timed",
  "durationMs",
  "toolCalls",
  "withSubagents",
] as const;
const HOUR_COUNTS = ["requests", "turns"] as const;
const TOOL_COUNTS = ["calls"] as const;

const sorted = <T>(cells: Map<string, T>): T[] =>
  [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, cell]) => cell);

/** Adds `cells` that `keep` keeps into `into`, summing `counts` of cells with the same key. */
const sumInto = <T extends object, C extends keyof T>(
  into: Map<string, T>,
  cells: readonly T[] | undefined,
  key: (cell: T) => string,
  counts: readonly C[],
  keep: (cell: T) => boolean,
): void => {
  for (const cell of cells ?? []) {
    if (!keep(cell)) continue;
    const id = key(cell);
    const known = into.get(id);
    if (!known) into.set(id, { ...cell });
    else for (const count of counts) (known[count] as number) += cell[count] as number;
  }
};

/**
 * The usage cells of `usages` that `keep` keeps, summed by key and sorted; undefined when none
 * is left. Hour, tool and limit cells have no `via`, so `keep` sees them without one.
 */
export const sumUsage = (
  usages: Iterable<Usage | undefined>,
  keep: (cell: { day: string; harness: string; via?: string }) => boolean = () => true,
): Usage | undefined => {
  const sessions = new Map<string, UsageSessionCell>();
  const tokens = new Map<string, UsageTokenCell>();
  const turns = new Map<string, UsageTurnCell>();
  const hours = new Map<string, UsageHourCell>();
  const tools = new Map<string, UsageToolCell>();
  const limits = new Map<string, UsageLimitCell>();
  for (const usage of usages) {
    if (!usage) continue;
    sumInto(sessions, usage.sessions, sessionKey, SESSION_COUNTS, keep);
    sumInto(tokens, usage.tokens, tokenKey, TOKEN_COUNTS, keep);
    sumInto(turns, usage.turns, turnKey, TURN_COUNTS, keep);
    sumInto(hours, usage.hours, hourKey, HOUR_COUNTS, keep);
    sumInto(tools, usage.tools, toolKey, TOOL_COUNTS, keep);
    for (const cell of usage.limits ?? []) {
      if (!keep(cell)) continue;
      const id = limitKey(cell);
      const known = limits.get(id);
      if (known) mergeUsageLimit(known, cell);
      else limits.set(id, { ...cell });
    }
  }
  const parts = [sessions, tokens, turns, hours, tools, limits];
  if (parts.every((part) => part.size === 0)) return undefined;
  return {
    sessions: sorted(sessions),
    tokens: sorted(tokens),
    ...(turns.size ? { turns: sorted(turns) } : {}),
    ...(hours.size ? { hours: sorted(hours) } : {}),
    ...(tools.size ? { tools: sorted(tools) } : {}),
    ...(limits.size ? { limits: sorted(limits) } : {}),
  };
};

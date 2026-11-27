// Usage counters summed over machines. core cannot import kit's Accumulator, so this sums the
// cells a Scan already holds; the cells are additive, so summing them is all a Report needs.
import type { Usage, UsageSessionCell, UsageTokenCell } from "@loadsheet/schema";

const SEP = "\u0000";
const sessionKey = (cell: UsageSessionCell) =>
  [cell.day, cell.harness, cell.via, cell.project, cell.thread].join(SEP);
const tokenKey = (cell: UsageTokenCell) =>
  [cell.day, cell.harness, cell.via, cell.project, cell.thread, cell.model].join(SEP);

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

const sorted = <T>(cells: Map<string, T>): T[] =>
  [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, cell]) => cell);

/**
 * The usage cells of `usages` that `keep` keeps, summed by key and sorted; undefined when none
 * is left.
 */
export const sumUsage = (
  usages: Iterable<Usage | undefined>,
  keep: (cell: { day: string; harness: string; via: string }) => boolean = () => true,
): Usage | undefined => {
  const sessions = new Map<string, UsageSessionCell>();
  const tokens = new Map<string, UsageTokenCell>();
  for (const usage of usages) {
    if (!usage) continue;
    for (const cell of usage.sessions) {
      if (!keep(cell)) continue;
      const key = sessionKey(cell);
      const known = sessions.get(key);
      if (!known) sessions.set(key, { ...cell });
      else for (const count of SESSION_COUNTS) known[count] += cell[count];
    }
    for (const cell of usage.tokens) {
      if (!keep(cell)) continue;
      const key = tokenKey(cell);
      const known = tokens.get(key);
      if (!known) tokens.set(key, { ...cell });
      else for (const count of TOKEN_COUNTS) known[count] += cell[count];
    }
  }
  if (sessions.size === 0 && tokens.size === 0) return undefined;
  return { sessions: sorted(sessions), tokens: sorted(tokens) };
};

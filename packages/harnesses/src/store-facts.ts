// What the session stores share: reading a row's counters and days, and naming a project.
import type { UsageTokensFact } from "@loadsheet/kit";
import type { Day } from "@loadsheet/schema";
export { projectOfCwd } from "./path.ts";

/** A column as a count: a whole number of 0 or more, else 0. */
export const count = (value: unknown): number => {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : 0;
};

/**
 * The UTC day of an instant: epoch milliseconds, or an ISO 8601 timestamp with any number of
 * fraction digits and a `Z` or an offset. Undefined when it is neither.
 */
export const utcDay = (value: unknown): Day | undefined => {
  let ms: number | undefined;
  if (typeof value === "number" || typeof value === "bigint") ms = Number(value);
  else if (typeof value === "string") {
    // Date.parse takes three fraction digits at most; Grok writes nine.
    ms = Date.parse(value.replace(/(\.\d{3})\d+/u, "$1"));
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};

/** A model's name for a Fact: the harness's spelling, or `unknown`. */
export const modelName = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : "unknown";

/** Token counters as a Fact's, from totals whose input includes what was read from and written to the cache. */
export const tokensOf = (totals: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}): Pick<
  UsageTokensFact,
  | "input"
  | "output"
  | "reasoning"
  | "cacheRead"
  | "cacheWrite"
  | "cacheWrite5m"
  | "cacheWrite1h"
  | "cacheRewrite"
> => ({
  input: Math.max(0, totals.input - totals.cacheRead - totals.cacheWrite),
  output: totals.output,
  reasoning: Math.min(totals.reasoning, totals.output),
  cacheRead: totals.cacheRead,
  cacheWrite: totals.cacheWrite,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRewrite: 0,
});

/** Whether a Fact's counters are all zero, so that it says nothing. */
export const noTokens = (tokens: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0;

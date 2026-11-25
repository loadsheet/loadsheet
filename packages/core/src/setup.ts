import type { Sheet } from "@loadsheet/schema";

/**
 * Tokens the user's setup adds to every session of a harness: the tokens of every line still
 * installed (one with a `scope`). The text output and the web page both show this figure.
 */
export const setupTokens = (sheet: Sheet): number =>
  sheet.lines.reduce((sum, line) => sum + (line.scope === undefined ? 0 : line.tokens.value), 0);

/**
 * Tokens of a session's start that are the harness's own, such as its system prompt and tools:
 * what a session starts with less the user's setup, never below 0; undefined when no session
 * reported what it started with.
 */
export const harnessTokens = (sheet: Sheet): number | undefined =>
  sheet.fixedTokens === undefined
    ? undefined
    : Math.max(0, sheet.fixedTokens.value - setupTokens(sheet));

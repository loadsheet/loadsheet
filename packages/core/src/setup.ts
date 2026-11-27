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

/** The context window a budget is drawn against when a sheet doesn't record one. */
export const DEFAULT_WINDOW = 200_000;

/**
 * The most a setup should add to every session, as a share of the context window: 5%, or 10,000
 * tokens of a 200k window. Past SETUP_LIMIT (10%, 20,000 tokens) a setup is too heavy: that is
 * where Claude Code stops loading MCP tools up front, and near where its /doctor warns about a
 * large CLAUDE.md (40k characters, about 10k tokens).
 */
export const SETUP_BUDGET = 0.05;
/** The share of the context window past which a setup is too heavy. */
export const SETUP_LIMIT = 0.1;

/** The setup budget and limit in tokens, for a context window. */
export const setupBudget = (window: number = DEFAULT_WINDOW) => ({
  budget: Math.round(window * SETUP_BUDGET),
  limit: Math.round(window * SETUP_LIMIT),
});

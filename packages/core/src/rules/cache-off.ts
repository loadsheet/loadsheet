import type { Finding } from "@loadsheet/schema";
import { cachingOnFixes } from "../fixes.ts";
import { defineRule } from "./rule.ts";

/** Main-conversation sessions a machine needs in the window before its caching is judged. */
export const CACHE_OFF_SESSIONS = 10;
/** Input and cache-write tokens a machine needs in the window before its caching is judged. */
export const CACHE_OFF_TOKENS = 1_000_000;

/**
 * A harness whose requests on a machine never read the prompt cache, over enough sessions and
 * tokens that some would have: every request pays for its whole prompt. The fix turns caching back
 * on where a variable the harness reads turned it off; otherwise something between the harness and
 * the API, such as a gateway, drops the cache, and there is no setting to change.
 */
export const cacheOff = defineRule({
  id: "cache-off",
  needs: ["usage", "cacheTtl"],
  run: ({ sheets }) =>
    sheets.flatMap((sheet): Finding[] => {
      const where = [];
      const fixes = [];
      let sessions = 0;
      let tokens = 0;
      for (const machine of sheet.machines) {
        const usage = sheet.usageOn(machine);
        if (!usage) continue;
        const main = usage.sessions
          .filter((cell) => cell.thread === "main")
          .reduce((total, cell) => total + cell.sessions, 0);
        let sent = 0;
        let read = 0;
        for (const cell of usage.tokens) {
          sent += cell.input + cell.cacheWrite;
          read += cell.cacheRead;
        }
        if (main < CACHE_OFF_SESSIONS || sent < CACHE_OFF_TOKENS || read > 0) continue;
        where.push({ machine, harness: sheet.harness });
        fixes.push(...cachingOnFixes(sheet, machine, sheet.settingsOn(machine) ?? {}));
        sessions += main;
        tokens += sent;
      }
      if (!where.length) return [];
      return [
        {
          id: `cache-off:${sheet.harness}`,
          rule: "cache-off",
          level: "fix",
          where,
          evidence: { sessions, tokens },
          fixes,
        },
      ];
    }),
});

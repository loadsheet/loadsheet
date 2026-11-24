import { defineRule } from "./rule.ts";

/**
 * A harness with sessions whose history, from its first session to the window's end, is shorter
 * than minDays (or the window, when that is shorter), so the rules that judge use cannot. There is no fix: raising how long a harness
 * keeps transcripts is a setting loadsheet does not read, and a value under the user's own would
 * delete transcripts.
 */
export const shortHistory = defineRule({
  id: "short-history",
  needs: ["listing"],
  run: ({ sheets, options, config }) =>
    sheets
      .filter(
        (sheet) => sheet.sessions > 0 && sheet.history < Math.min(options.minDays, config.window),
      )
      .map((sheet) => ({
        id: `short-history:${sheet.harness}`,
        rule: "short-history",
        level: "info" as const,
        where: sheet.machines
          .filter((machine) => sheet.sessionsOn(machine) > 0)
          .map((machine) => ({ machine, harness: sheet.harness })),
        evidence: { days: sheet.history, sessions: sheet.sessions, minDays: options.minDays },
        fixes: [],
      })),
});

import { retentionFixes } from "../fixes.ts";
import { defineRule } from "./rule.ts";

/**
 * A harness with sessions whose history, from its first session to the window's end, is shorter
 * than minDays (or the window, when that is shorter), so the rules that judge use cannot. It also
 * fires where Claude Code's own retention is no longer than the window and the history has reached
 * it: Claude Code deletes the older transcripts, so the history can never grow, and the fix keeps
 * them a year. Elsewhere the history is simply young, and there is nothing to change.
 */
export const shortHistory = defineRule({
  id: "short-history",
  needs: ["listing"],
  run: ({ sheets, options, config }) =>
    sheets
      .filter((sheet) => sheet.sessions > 0)
      .flatMap((sheet) => {
        const machines = sheet.machines.filter((machine) => sheet.sessionsOn(machine) > 0);
        const capped = machines.filter((machine) => {
          const days = sheet.settingsOn(machine)?.retentionDays;
          return days !== undefined && days <= config.window && sheet.historyOn(machine) >= days;
        });
        const short = sheet.history < Math.min(options.minDays, config.window);
        if (!short && capped.length === 0) return [];
        const fixes = capped.flatMap((machine) => retentionFixes(sheet, machine, config.window));
        const retention = capped.map((machine) => sheet.settingsOn(machine)!.retentionDays!);
        return [
          {
            id: `short-history:${sheet.harness}`,
            rule: "short-history",
            level: fixes.length ? ("fix" as const) : ("info" as const),
            where: (short ? machines : capped).map((machine) => ({
              machine,
              harness: sheet.harness,
            })),
            evidence: {
              days: sheet.history,
              sessions: sheet.sessions,
              minDays: options.minDays,
              ...(retention.length ? { retentionDays: Math.min(...retention) } : {}),
            },
            fixes,
          },
        ];
      }),
});

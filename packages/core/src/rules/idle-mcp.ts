import type { Finding } from "@loadsheet/schema";
import { byWaste, defineRule, hitsByItem, sum, tokensOf, whereOf } from "./rule.ts";

/**
 * An MCP server listed in at least minSessions sessions of a harness and never called there. Its
 * server may be wanted for the rare day it is, so it is for the user to know, with no fix.
 * Claude Code's `other` bucket may contain calls to servers whose listings could not be verified.
 */
export const idleMcp = defineRule({
  id: "idle-mcp",
  needs: ["mcp"],
  blind: (sheet) =>
    sheet.harness === "claude-code" &&
    sheet.signals.mcp !== "none" &&
    sheet.machines.some((machine) =>
      sheet.usageOn(machine)?.tools?.some((cell) => cell.tool === "other" && cell.calls > 0),
    )
      ? ["mcp"]
      : [],
  enough: (sheet, options) => sheet.sessions >= options.minSessions,
  run: ({ sheets, options }) => {
    const hits = hitsByItem(
      sheets,
      (line) =>
        line.ref.kind === "mcp" &&
        line.exposure.sessions >= options.minSessions &&
        line.use.byModel + line.use.byUser === 0,
    );
    const findings: Finding[] = [];
    for (const [item, group] of hits) {
      findings.push({
        id: `idle-mcp:${item}`,
        rule: "idle-mcp",
        level: "info",
        item,
        where: whereOf(group),
        evidence: { sessions: sum(group, ({ line }) => line.exposure.sessions), calls: 0 },
        savesTokens: tokensOf(group),
        fixes: [],
      });
    }
    return findings.sort(byWaste);
  },
});

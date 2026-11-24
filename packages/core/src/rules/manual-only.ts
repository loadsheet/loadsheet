import type { Finding } from "@loadsheet/schema";
import { hideFixes, uniqueFixes } from "../fixes.ts";
import { byWaste, defineRule, hitsByItem, sum, tokensOf, whereOf } from "./rule.ts";

/**
 * A skill the model may invoke, invoked by the user at least minUserUses times and never by the
 * model: hiding it from the model keeps `/name` and saves its listing in every session. A skill
 * installed nowhere is not judged, since only an install says whether the model may invoke it.
 */
export const manualOnly = defineRule({
  id: "manual-only",
  needs: ["modelUse", "userUse"],
  enough: (sheet) => sheet.sessions > 0,
  run: ({ sheets, options }) => {
    const hits = hitsByItem(sheets, (line, sheet) => {
      if (line.ref.kind !== "skill" || line.use.byModel > 0) return false;
      if (line.use.byUser < options.minUserUses) return false;
      return sheet.installs(line.item).some(({ item }) => item.modelInvocable);
    });
    const findings: Finding[] = [];
    for (const [item, group] of hits) {
      findings.push({
        id: `manual-only:${item}`,
        rule: "manual-only",
        level: "fix",
        item,
        where: whereOf(group),
        evidence: {
          sessions: sum(group, ({ line }) => line.exposure.sessions),
          byModel: 0,
          byUser: sum(group, ({ line }) => line.use.byUser),
        },
        savesTokens: tokensOf(group),
        fixes: uniqueFixes(group.flatMap(({ sheet, line }) => hideFixes(sheet, line))),
      });
    }
    return findings.sort(byWaste);
  },
});

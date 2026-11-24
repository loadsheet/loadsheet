import type { Finding } from "@loadsheet/schema";
import { removeFixes, uniqueFixes } from "../fixes.ts";
import { byWaste, defineRule, hitsByItem, sum, tokensOf, whereOf } from "./rule.ts";

/** A skill listed in at least minSessions sessions over at least minDays days, and never invoked by the model or the user. */
export const deadSkill = defineRule({
  id: "dead-skill",
  needs: ["listing", "modelUse", "userUse"],
  enough: (sheet, options) => sheet.days >= options.minDays,
  run: ({ sheets, options, unfiltered }) => {
    const hits = hitsByItem(
      sheets,
      (line) =>
        line.ref.kind === "skill" &&
        line.exposure.sessions >= options.minSessions &&
        line.use.byModel + line.use.byUser === 0,
    );
    const findings: Finding[] = [];
    for (const [item, group] of hits) {
      findings.push({
        id: `dead-skill:${item}`,
        rule: "dead-skill",
        level: "cut",
        item,
        where: whereOf(group),
        evidence: {
          sessions: sum(group, ({ line }) => line.exposure.sessions),
          days: Math.min(...group.map(({ sheet }) => sheet.days)),
          byModel: 0,
          byUser: 0,
        },
        savesTokens: tokensOf(group),
        fixes: uniqueFixes(
          group.flatMap(({ sheet, line }) => removeFixes(sheet, line, unfiltered)),
        ),
      });
    }
    return findings.sort(byWaste);
  },
});

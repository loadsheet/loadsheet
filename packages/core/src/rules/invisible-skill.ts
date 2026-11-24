import type { Finding } from "@loadsheet/schema";
import { bareByChoice, listingBudgetFixes, uniqueFixes } from "../fixes.ts";
import { byWaste, defineRule, hitsByItem, sum, whereOf } from "./rule.ts";

/**
 * A skill listed without its description in at least bareShare of at least minSessions sessions:
 * the model sees its name only, so it cannot tell when to invoke it. A skill the user set to be
 * listed by name only is left alone.
 */
export const invisibleSkill = defineRule({
  id: "invisible-skill",
  needs: ["listing"],
  enough: (sheet, options) => sheet.sessions >= options.minSessions,
  run: ({ sheets, options, unfiltered }) => {
    const hits = hitsByItem(sheets, (line, sheet) => {
      const { sessions, bare } = line.exposure;
      return (
        line.ref.kind === "skill" &&
        sessions >= options.minSessions &&
        bare / sessions >= options.bareShare &&
        !bareByChoice(sheet, line)
      );
    });
    const findings: Finding[] = [];
    for (const [item, group] of hits) {
      const sessions = sum(group, ({ line }) => line.exposure.sessions);
      const bare = sum(group, ({ line }) => line.exposure.bare);
      findings.push({
        id: `invisible-skill:${item}`,
        rule: "invisible-skill",
        level: "fix",
        item,
        where: whereOf(group),
        evidence: {
          sessions,
          bare,
          bareShare: Math.round((bare / sessions) * 1000) / 1000,
          byModel: sum(group, ({ line }) => line.use.byModel),
          byUser: sum(group, ({ line }) => line.use.byUser),
        },
        fixes: uniqueFixes(
          group.flatMap(({ sheet, line }) => listingBudgetFixes(sheet, line, unfiltered)),
        ),
      });
    }
    return findings.sort(byWaste);
  },
});

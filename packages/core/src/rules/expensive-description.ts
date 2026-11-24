import type { Finding } from "@loadsheet/schema";
import { shortenFixes, uniqueFixes } from "../fixes.ts";
import { defineRule, estimateTokens, hitsByItem, sum, whereOf, type Hit } from "./rule.ts";

const usesOf = (hits: Hit[]) => sum(hits, ({ line }) => line.use.byModel + line.use.byUser);

/**
 * Listing tokens paid per use: what every session that listed it paid, over the times it was
 * invoked (at least one), so a long description nobody invokes comes first.
 */
const tokensPerUse = (hits: Hit[]) =>
  Math.round(
    sum(hits, ({ line }) => line.tokens.value * line.exposure.sessions) / Math.max(1, usesOf(hits)),
  );

/** A skill whose listing entry is longer than maxChars; shortening it saves the excess in every session. */
export const expensiveDescription = defineRule({
  id: "expensive-description",
  needs: [],
  run: ({ mode, sheets, options }) => {
    const hits = hitsByItem(
      sheets,
      (line) => line.ref.kind === "skill" && line.chars.listed > options.maxChars,
    );
    const found: { finding: Finding; cost: number }[] = [];
    for (const [item, group] of hits) {
      const listedChars = Math.max(...group.map(({ line }) => line.chars.listed));
      const finding: Finding = {
        id: `expensive-description:${item}`,
        rule: "expensive-description",
        level: "fix",
        item,
        where: [],
        evidence: { listedChars, maxChars: options.maxChars },
        savesTokens: { value: estimateTokens(listedChars - options.maxChars), basis: "estimated" },
        fixes: [],
      };
      if (mode === "pack") {
        // In pack mode the change goes to the pack's source, so it names no machine.
        const path = group[0]!.line.path;
        if (path) {
          finding.fixes = [
            { action: "shorten", path: path.endsWith(".md") ? path : `${path}/SKILL.md` },
          ];
        }
      } else {
        finding.where = whereOf(group);
        finding.evidence.sessions = sum(group, ({ line }) => line.exposure.sessions);
        finding.evidence.uses = usesOf(group);
        finding.evidence.tokensPerUse = tokensPerUse(group);
        finding.fixes = uniqueFixes(group.flatMap(({ sheet, line }) => shortenFixes(sheet, line)));
      }
      found.push({ finding, cost: mode === "pack" ? 0 : tokensPerUse(group) });
    }
    // Sorting is stable, so pack mode keeps the sheet's order, heaviest first.
    return found.sort((a, b) => b.cost - a.cost).map(({ finding }) => finding);
  },
});

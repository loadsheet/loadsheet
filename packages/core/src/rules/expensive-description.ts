import type { Finding, Id } from "@loadsheet/schema";
import { installsOf, shortenFixes, uniqueFixes } from "../fixes.ts";
import { defineRule, estimateTokens, sum, type Hit, type Install } from "./rule.ts";

const usesOf = (hits: Hit[]) => sum(hits, ({ line }) => line.use.byModel + line.use.byUser);

/**
 * Listing tokens paid per use: what every session that listed it paid, over the times it was
 * invoked (at least one), so a long description nobody invokes comes first.
 */
const tokensPerUse = (hits: Hit[]) =>
  Math.round(
    sum(hits, ({ line }) => line.tokens.value * line.exposure.sessions) / Math.max(1, usesOf(hits)),
  );

/**
 * A line of a sheet over maxChars: its installs over it, and the largest of their listing entries.
 * A line with no install, such as one in pack mode, is judged by the line's own characters.
 */
interface Over extends Hit {
  installs: Install[];
  listed: number;
}

/** A skill whose listing entry is longer than maxChars; shortening it saves the excess in every session. */
export const expensiveDescription = defineRule({
  id: "expensive-description",
  needs: [],
  run: ({ mode, sheets, options }) => {
    const hits = new Map<Id, Over[]>();
    for (const sheet of sheets) {
      for (const line of sheet.lines) {
        if (line.ref.kind !== "skill") continue;
        const all = installsOf(sheet, line);
        const installs = all.filter(({ item }) => item.chars.listed > options.maxChars);
        const listed = all.length
          ? Math.max(0, ...installs.map(({ item }) => item.chars.listed))
          : line.chars.listed;
        if (listed <= options.maxChars) continue;
        hits.set(line.item, [...(hits.get(line.item) ?? []), { sheet, line, installs, listed }]);
      }
    }
    const found: { finding: Finding; cost: number }[] = [];
    for (const [item, group] of hits) {
      const listedChars = Math.max(...group.map(({ listed }) => listed));
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
        // Only the installs over maxChars are where it applies; a line with none holds everywhere.
        finding.where = group.flatMap(({ sheet, line, installs }) =>
          (installs.length
            ? [...new Set(installs.map(({ machine }) => machine))]
            : line.machines
          ).map((machine) => ({ machine, harness: sheet.harness })),
        );
        finding.evidence.sessions = sum(group, ({ line }) => line.exposure.sessions);
        finding.evidence.uses = usesOf(group);
        finding.evidence.tokensPerUse = tokensPerUse(group);
        finding.fixes = uniqueFixes(group.flatMap(({ installs }) => shortenFixes(installs)));
      }
      found.push({ finding, cost: mode === "pack" ? 0 : tokensPerUse(group) });
    }
    // Sorting is stable, so pack mode keeps the sheet's order, heaviest first.
    return found.sort((a, b) => b.cost - a.cost).map(({ finding }) => finding);
  },
});

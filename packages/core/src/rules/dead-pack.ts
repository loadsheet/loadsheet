import type { Finding, Line } from "@loadsheet/schema";
import { removeFixes, uniqueFixes } from "../fixes.ts";
import { byWaste, defineRule, type RuleSheet } from "./rule.ts";

interface Hit {
  sheet: RuleSheet;
  lines: Line[];
}

/**
 * A pack none of whose skills on a harness's sheet is invoked, with at least minSkills of them dead
 * skills: listed in at least dead-skill's minSessions sessions over its minDays days. One finding
 * per pack, for all its skills; the engine drops their own findings. Each skill is removed through the dead skill's
 * guard, which offers nothing for a plugin's: turning a plugin off also turns off its hooks and
 * commands, which loadsheet does not read, so that is left to the user.
 */
export const deadPack = defineRule({
  id: "dead-pack",
  needs: ["listing", "modelUse", "userUse"],
  enough: (sheet, _options, config) => sheet.days >= config.rules["dead-skill"].minDays,
  run: ({ sheets, options, config, unfiltered }) => {
    const { minSessions } = config.rules["dead-skill"];
    const hits = new Map<string, Hit[]>();
    for (const sheet of sheets) {
      const byPack = new Map<string, Line[]>();
      for (const line of sheet.lines) {
        if (line.ref.kind !== "skill" || line.pack === undefined) continue;
        byPack.set(line.pack, [...(byPack.get(line.pack) ?? []), line]);
      }
      for (const [pack, lines] of byPack) {
        if (lines.some((line) => line.use.byModel + line.use.byUser > 0)) continue;
        const listed = lines.filter((line) => line.exposure.sessions >= minSessions);
        if (listed.length < options.minSkills) continue;
        hits.set(pack, [...(hits.get(pack) ?? []), { sheet, lines }]);
      }
    }
    const findings: Finding[] = [];
    for (const [pack, group] of hits) {
      const sessions = (lines: Line[]) => Math.max(...lines.map((line) => line.exposure.sessions));
      const tokens = (lines: Line[]) => lines.reduce((total, line) => total + line.tokens.value, 0);
      findings.push({
        id: `dead-pack:${pack}`,
        rule: "dead-pack",
        level: "cut",
        pack,
        where: group.flatMap(({ sheet, lines }) =>
          [...new Set(lines.flatMap((line) => line.machines))]
            .sort()
            .map((machine) => ({ machine, harness: sheet.harness })),
        ),
        evidence: {
          skills: new Set(group.flatMap(({ lines }) => lines.map((line) => line.item))).size,
          sessions: group.reduce((total, { lines }) => total + sessions(lines), 0),
          days: Math.min(...group.map(({ sheet }) => sheet.days)),
          byModel: 0,
          byUser: 0,
        },
        savesTokens: {
          value: Math.max(...group.map(({ lines }) => tokens(lines))),
          basis: "estimated",
        },
        fixes: uniqueFixes(
          group.flatMap(({ sheet, lines }) =>
            lines.flatMap((line) => removeFixes(sheet, line, unfiltered)),
          ),
        ),
      });
    }
    return findings.sort(byWaste);
  },
});

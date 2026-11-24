import type { Finding, Line } from "@loadsheet/schema";
import { removeFixes, uniqueFixes } from "../fixes.ts";
import { byWaste, defineRule, type Install, type RuleSheet } from "./rule.ts";

/** A line of the pack's on one sheet, and its installs from the pack. */
interface Member {
  line: Line;
  installs: Install[];
}

interface Hit {
  sheet: RuleSheet;
  members: Member[];
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
      // A line is the pack's when one of its installs is: each machine has its own.
      const byPack = new Map<string, Member[]>();
      for (const line of sheet.lines) {
        if (line.ref.kind !== "skill") continue;
        const installs = new Map<string, Install[]>();
        for (const install of sheet.installs(line.item)) {
          if (install.item.pack === undefined) continue;
          installs.set(install.item.pack, [...(installs.get(install.item.pack) ?? []), install]);
        }
        for (const [pack, own] of installs) {
          byPack.set(pack, [...(byPack.get(pack) ?? []), { line, installs: own }]);
        }
      }
      for (const [pack, members] of byPack) {
        if (members.some(({ line }) => line.use.byModel + line.use.byUser > 0)) continue;
        const listed = members.filter(({ line }) => line.exposure.sessions >= minSessions);
        if (listed.length < options.minSkills) continue;
        hits.set(pack, [...(hits.get(pack) ?? []), { sheet, members }]);
      }
    }
    const findings: Finding[] = [];
    for (const [pack, group] of hits) {
      const sessions = (members: Member[]) =>
        Math.max(...members.map(({ line }) => line.exposure.sessions));
      const tokens = (members: Member[]) =>
        members.reduce((total, { line }) => total + line.tokens.value, 0);
      findings.push({
        id: `dead-pack:${pack}`,
        rule: "dead-pack",
        level: "cut",
        pack,
        where: group.flatMap(({ sheet, members }) =>
          [...new Set(members.flatMap(({ installs }) => installs.map(({ machine }) => machine)))]
            .sort()
            .map((machine) => ({ machine, harness: sheet.harness })),
        ),
        evidence: {
          skills: new Set(group.flatMap(({ members }) => members.map(({ line }) => line.item)))
            .size,
          sessions: group.reduce((total, { members }) => total + sessions(members), 0),
          days: Math.min(...group.map(({ sheet }) => sheet.days)),
          byModel: 0,
          byUser: 0,
        },
        savesTokens: {
          value: Math.max(...group.map(({ members }) => tokens(members))),
          basis: "estimated",
        },
        // Only the pack's installs are removed, through a sheet that holds no other.
        fixes: uniqueFixes(
          group.flatMap(({ sheet, members }) =>
            members.flatMap(({ line, installs }) =>
              removeFixes({ ...sheet, installs: () => installs }, line, unfiltered),
            ),
          ),
        ),
      });
    }
    return findings.sort(byWaste);
  },
});

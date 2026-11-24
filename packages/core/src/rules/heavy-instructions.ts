import type { Finding, Id } from "@loadsheet/schema";
import { installsOf } from "../fixes.ts";
import { defineRule, sum, type Hit, type Install } from "./rule.ts";

interface Heavy extends Hit {
  /** The installs over maxChars; none for a line installed nowhere loadsheet reads. */
  installs: Install[];
  chars: number;
}

/**
 * An instruction file longer than maxChars characters: every session that loads it pays for all of
 * it. Size only, so it needs no signal; what to cut from the file is the user's call, so no fix.
 */
export const heavyInstructions = defineRule({
  id: "heavy-instructions",
  needs: [],
  run: ({ mode, sheets, options }) => {
    const hits = new Map<Id, Heavy[]>();
    for (const sheet of sheets) {
      for (const line of sheet.lines) {
        if (line.ref.kind !== "instructions") continue;
        const all = installsOf(sheet, line);
        const installs = all.filter(({ item }) => item.chars.listed > options.maxChars);
        const chars = all.length
          ? Math.max(0, ...installs.map(({ item }) => item.chars.listed))
          : line.chars.listed;
        if (chars <= options.maxChars) continue;
        hits.set(line.item, [...(hits.get(line.item) ?? []), { sheet, line, installs, chars }]);
      }
    }
    const findings: Finding[] = [];
    for (const [item, group] of hits) {
      const chars = Math.max(...group.map((hit) => hit.chars));
      const finding: Finding = {
        id: `heavy-instructions:${item}`,
        rule: "heavy-instructions",
        level: "info",
        item,
        where: [],
        evidence: { chars, maxChars: options.maxChars },
        fixes: [],
      };
      if (mode !== "pack") {
        const machinesOf = ({ line, installs }: Heavy) =>
          installs.length ? [...new Set(installs.map(({ machine }) => machine))] : line.machines;
        finding.where = group.flatMap((hit) =>
          machinesOf(hit).map((machine) => ({ machine, harness: hit.sheet.harness })),
        );
        // A line's sessions are over all its machines, so they are the finding's only when it
        // holds for every one of them.
        if (group.every((hit) => machinesOf(hit).length === hit.line.machines.length))
          finding.evidence.sessions = sum(group, ({ line }) => line.exposure.sessions);
      }
      findings.push(finding);
    }
    return findings.sort(
      (a, b) => b.evidence.chars! - a.evidence.chars! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  },
});

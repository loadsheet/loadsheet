import type { Finding, Id } from "@loadsheet/schema";
import { installsOf, removeFixes, uniqueFixes } from "../fixes.ts";
import { byWaste, defineRule, tokensOf, type Hit, type Install } from "./rule.ts";

interface Mismatch extends Hit {
  /** The installs every harness that loads them leaves unused on their machine. */
  installs: Install[];
  /** Sessions of this harness on those machines. */
  sessions: number;
}

/**
 * A skill installed on a machine only for harnesses that had fewer than minSessions sessions there
 * in the window. A harness's sessions are read before the entrypoint and harness filters, and one
 * that cannot tell its sessions on that machine counts as used, so a folder another harness may
 * load is never judged. Each finding is removed through the same guard as a dead skill.
 */
export const harnessMismatch = defineRule({
  id: "harness-mismatch",
  // Each install is judged by its own machine's coverage, so a machine that cannot tell does not
  // silence one that can; a sheet with no machine is a pack's.
  needs: [],
  enough: (sheet) => sheet.machines.length > 0,
  run: ({ sheets, options, unfiltered }) => {
    const unused = (machine: string, harness: string) => {
      const sessions = unfiltered.sessions(machine, harness);
      return sessions !== undefined && sessions < options.minSessions;
    };
    const hits = new Map<Id, Mismatch[]>();
    for (const sheet of sheets) {
      for (const line of sheet.lines) {
        if (line.ref.kind !== "skill") continue;
        const installs = installsOf(sheet, line).filter(({ machine, item }) =>
          item.harnesses.every((harness) => unused(machine, harness)),
        );
        if (!installs.length) continue;
        const machines = [...new Set(installs.map(({ machine }) => machine))];
        const sessions = machines.reduce(
          (total, machine) => total + (unfiltered.sessions(machine, sheet.harness) ?? 0),
          0,
        );
        const hit = { sheet, line: { ...line, machines }, installs, sessions };
        hits.set(line.item, [...(hits.get(line.item) ?? []), hit]);
      }
    }
    const findings: Finding[] = [];
    for (const [item, group] of hits) {
      findings.push({
        id: `harness-mismatch:${item}`,
        rule: "harness-mismatch",
        level: "fix",
        item,
        where: group.flatMap(({ sheet, line }) =>
          line.machines.map((machine) => ({ machine, harness: sheet.harness })),
        ),
        evidence: {
          sessions: group.reduce((total, hit) => total + hit.sessions, 0),
          minSessions: options.minSessions,
        },
        savesTokens: tokensOf(group),
        // Only the installs judged are removed, through a sheet that holds no other.
        fixes: uniqueFixes(
          group.flatMap(({ sheet, line, installs }) =>
            removeFixes({ ...sheet, installs: () => installs }, line, unfiltered),
          ),
        ),
      });
    }
    return findings.sort(byWaste);
  },
});

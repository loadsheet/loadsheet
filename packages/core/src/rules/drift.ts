import type { Finding, Id, Where } from "@loadsheet/schema";
import { defineRule } from "./rule.ts";

/**
 * In fleet mode, a skill whose copies differ between machines: the same id with different digests.
 * Each machine holds the set of digests every harness there loads, and machines are compared by
 * that set, so two copies on one machine are a duplicate, not drift. Bringing a copy up to date is
 * its installer's work, so there is no fix.
 */
export const drift = defineRule({
  id: "drift",
  needs: [],
  // A sheet with no machine is a pack's; the machines are compared over every sheet.
  enough: (sheet) => sheet.machines.length > 0,
  run: ({ mode, sheets }) => {
    if (mode !== "fleet") return [];
    const found = new Map<Id, { where: Where[]; digests: Map<string, Set<string>> }>();
    for (const sheet of sheets) {
      for (const line of sheet.lines) {
        if (line.ref.kind !== "skill") continue;
        const known = found.get(line.item) ?? { where: [] as Where[], digests: new Map() };
        for (const { machine, item } of sheet.installs(line.item)) {
          known.digests.set(machine, (known.digests.get(machine) ?? new Set()).add(item.digest));
          const last = known.where.at(-1);
          // Installs come by machine, so a machine's second copy follows its first.
          if (last?.machine !== machine || last.harness !== sheet.harness)
            known.where.push({ machine, harness: sheet.harness });
        }
        found.set(line.item, known);
      }
    }
    const findings: Finding[] = [];
    for (const [item, { where, digests }] of found) {
      const versions = new Set([...digests.values()].map((set) => [...set].sort().join(",")));
      if (versions.size < 2) continue;
      findings.push({
        id: `drift:${item}`,
        rule: "drift",
        level: "fix",
        item,
        where,
        evidence: {
          variants: new Set([...digests.values()].flatMap((set) => [...set])).size,
          machines: digests.size,
        },
        fixes: [],
      });
    }
    return findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  },
});

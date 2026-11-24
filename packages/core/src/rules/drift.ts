import type { Finding, Id, Where } from "@loadsheet/schema";
import { defineRule } from "./rule.ts";

/**
 * In fleet mode, a skill whose copies differ between machines: the same id with different digests.
 * Two copies on one machine are a duplicate, not drift, so machines are compared by the set of
 * digests each holds. Bringing a copy up to date is its installer's work, so there is no fix.
 */
export const drift = defineRule({
  id: "drift",
  needs: [],
  enough: (sheet) => sheet.machines.length >= 2,
  run: ({ sheets }) => {
    const found = new Map<Id, { where: Where[]; versions: Map<string, string> }>();
    for (const sheet of sheets) {
      for (const line of sheet.lines) {
        if (line.ref.kind !== "skill") continue;
        const byMachine = new Map<string, Set<string>>();
        for (const { machine, item } of sheet.installs(line.item)) {
          byMachine.set(machine, (byMachine.get(machine) ?? new Set()).add(item.digest));
        }
        const versions = new Map(
          [...byMachine].map(([machine, digests]) => [machine, [...digests].sort().join(",")]),
        );
        if (new Set(versions.values()).size < 2) continue;
        const known = found.get(line.item) ?? { where: [] as Where[], versions: new Map() };
        for (const [machine, version] of versions) {
          known.where.push({ machine, harness: sheet.harness });
          known.versions.set(machine, version);
        }
        found.set(line.item, known);
      }
    }
    const findings: Finding[] = [];
    for (const [item, { where, versions }] of found) {
      const digests = new Set([...versions.values()].flatMap((version) => version.split(",")));
      findings.push({
        id: `drift:${item}`,
        rule: "drift",
        level: "fix",
        item,
        where,
        evidence: { variants: digests.size, machines: versions.size },
        fixes: [],
      });
    }
    return findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  },
});

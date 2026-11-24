import type { Finding, Id } from "@loadsheet/schema";
import { dedupeFixes, uniqueFixes } from "../fixes.ts";
import { byWaste, defineRule, type Install, type RuleSheet } from "./rule.ts";

interface Hit {
  sheet: RuleSheet;
  /** The skill's installs on each machine where it is duplicated. */
  copies: Install[][];
}

/** Whether these installs on one machine are two skills: from two sources, or with two contents. */
const twice = (installs: Install[]) =>
  installs.length > 1 &&
  (new Set(installs.map(({ item }) => item.pack)).size > 1 ||
    new Set(installs.map(({ item }) => item.digest)).size > 1);

/**
 * A skill one harness loads from two places on one machine, from two sources or with two contents.
 * One folder two harnesses load is one install on each sheet, and two links to the same content
 * from the same source are one skill. The copy the harness does not load is deduped when the
 * harness's order tells which it is; otherwise there is no fix. Whether the harness lists both
 * copies is not known for every harness, so it claims no saving.
 */
export const duplicate = defineRule({
  id: "duplicate",
  needs: [],
  run: ({ mode, sheets, unfiltered }) => {
    const hits = new Map<Id, Hit[]>();
    for (const sheet of sheets) {
      for (const line of sheet.lines) {
        if (line.ref.kind !== "skill") continue;
        const byMachine = new Map<string, Install[]>();
        for (const install of sheet.installs(line.item)) {
          byMachine.set(install.machine, [...(byMachine.get(install.machine) ?? []), install]);
        }
        const copies = [...byMachine.values()].filter(twice);
        if (copies.length) hits.set(line.item, [...(hits.get(line.item) ?? []), { sheet, copies }]);
      }
    }
    const findings: Finding[] = [];
    for (const [item, group] of hits) {
      findings.push({
        id: `duplicate:${item}`,
        rule: "duplicate",
        level: "fix",
        item,
        // In pack mode the copies are the pack's own, on no machine, and which one to drop is
        // the pack's author's call.
        where:
          mode === "pack"
            ? []
            : group.flatMap(({ sheet, copies }) =>
                copies.map(([first]) => ({ machine: first!.machine, harness: sheet.harness })),
              ),
        evidence: {
          copies: Math.max(...group.flatMap(({ copies }) => copies.map((one) => one.length))),
        },
        fixes:
          mode === "pack"
            ? []
            : uniqueFixes(
                group.flatMap(({ sheet, copies }) => dedupeFixes(sheet, copies.flat(), unfiltered)),
              ),
      });
    }
    return findings.sort(byWaste);
  },
});

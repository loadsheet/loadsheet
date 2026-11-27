import { NO_REPOSITORY, type UsageRow, type UsageTotals } from "@loadsheet/core";
import { orgOf } from "@loadsheet/schema";
import { harnessName } from "./report";

/** Rows an open org or the harness total lists before the rest fold behind "Show more". */
const TOP = 5;

/** A row of the usage table: every harness summed or one org, a project or harness under it, or the fold. */
export type UsageTableRow =
  | { t: "grp"; key: string; row: UsageRow; label: string; canOpen: boolean; open: boolean }
  | { t: "it"; key: string; row: UsageRow; label: string }
  | { t: "more"; key: string; list: string; n: number; tokens: number };

const orgOfProject = (name: string) => (name === NO_REPOSITORY ? NO_REPOSITORY : orgOf(name));

/**
  The usage table from `usageTotals`: every harness summed first, opening onto each harness when there are several,
  then one row per org, heaviest first, opening onto its projects. `open` holds the keys of open rows (`all`,
  `org:<name>`), `more` the lists shown whole.
*/
export function usageRows(
  totals: UsageTotals,
  open: ReadonlySet<string>,
  more: ReadonlySet<string>,
): UsageTableRow[] {
  const out: UsageTableRow[] = [];
  const children = (key: string, items: { row: UsageRow; label: string }[]) => {
    const full = more.has(key) || items.length <= TOP + 1;
    for (const { row, label } of full ? items : items.slice(0, TOP))
      out.push({ t: "it", key: `${key}:${row.name}`, row, label });
    if (full) return;
    const rest = items.slice(TOP);
    out.push({
      t: "more",
      key: `more:${key}`,
      list: key,
      n: rest.length,
      tokens: rest.reduce((n, each) => n + each.row.tokens, 0),
    });
  };
  const harnesses = totals.harnesses.map((row) => ({ row, label: harnessName(row.name) }));
  const several = harnesses.length > 1;
  out.push({
    t: "grp",
    key: "all",
    row: totals.all,
    label: several ? "All harnesses" : (harnesses[0]?.label ?? "All harnesses"),
    canOpen: several,
    open: several && open.has("all"),
  });
  if (several && open.has("all")) children("all", harnesses);
  for (const org of totals.orgs) {
    const key = `org:${org.name}`;
    const projects = totals.projects.filter((p) => orgOfProject(p.name) === org.name);
    // A single project under the org's own name, "no repository", opens onto nothing new.
    const canOpen = !(projects.length === 1 && projects[0]!.name === org.name);
    const isOpen = canOpen && open.has(key);
    out.push({ t: "grp", key, row: org, label: org.name, canOpen, open: isOpen });
    if (isOpen)
      children(
        key,
        projects.map((row) => ({ row, label: row.name })),
      );
  }
  return out;
}

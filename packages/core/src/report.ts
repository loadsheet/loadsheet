import type {
  Coverage,
  Day,
  Grade,
  Id,
  Item,
  Line,
  Machine,
  Report,
  ResolvedConfig,
  Scan,
  Sheet,
  Signal,
} from "@loadsheet/schema";
import { parseId, SIGNALS } from "@loadsheet/schema";
import { NO_SIGNALS, runRules } from "./engine.ts";
import { estimateTokens, type Install, type RuleSheet, type Unfiltered } from "./rules/rule.ts";
import { sumUsage } from "./usage.ts";

/** Input for buildReport. */
export interface BuildReportInput {
  /** One Scan per machine read. */
  scans: Scan[];
  config: ResolvedConfig;
  /** When the report is generated. */
  now: Date;
  /** The tool and version, such as loadsheet@0.0.1. */
  tool: string;
  /** Default local for one machine, fleet for more. */
  mode?: "local" | "fleet";
  /** Machines that could not be read, listed after the Scans' machines. */
  machines?: Machine[];
}

const RANK: Record<Grade, number> = { none: 0, inferred: 1, exact: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** Days the headline figure, what a session starts with, is averaged over: a setup grows. */
export const RECENT_DAYS = 7;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTokens = (a: Line, b: Line) => b.tokens.value - a.tokens.value || compare(a.item, b.item);
const daysBetween = (first: Day, last: Day) =>
  Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1;

/** Each signal at the worst grade among these coverages: a rule needs it from every machine. */
const worstSignals = (coverage: Coverage[]): Record<Signal, Grade> => {
  if (!coverage.length) return { ...NO_SIGNALS };
  const signals = { ...coverage[0]!.signals };
  for (const entry of coverage.slice(1)) {
    for (const signal of SIGNALS) {
      if (RANK[entry.signals[signal]] < RANK[signals[signal]])
        signals[signal] = entry.signals[signal];
    }
  }
  return signals;
};

interface Usage {
  sessions: number;
  bare: number;
  chars: number;
  byModel: number;
  byUser: number;
  lastUsed?: Day;
  machines: Set<string>;
}

/** The Scans as they are, before the harness, entrypoint and ignore filters. */
const unfilteredOf = (
  scans: Scan[],
  wholeFleet: boolean,
  inWindow: (day: Day) => boolean,
): Unfiltered => {
  const users = new Map<Id, Set<string>>();
  for (const scan of scans) {
    for (const cell of scan.cells) {
      if (cell.byModel + cell.byUser === 0) continue;
      users.set(cell.item, (users.get(cell.item) ?? new Set()).add(cell.harness));
    }
  }
  const tells = new Set(
    scans.flatMap((scan) =>
      scan.coverage
        .filter((c) => c.signals.modelUse !== "none" && c.signals.userUse !== "none")
        .map((c) => JSON.stringify([c.machine, c.harness])),
    ),
  );
  const byMachine = new Map(scans.map((scan) => [scan.machine, scan]));
  const sessionsOf = (machine: string, harness: string) => {
    const scan = byMachine.get(machine);
    const row = scan?.coverage.find((c) => c.harness === harness);
    if (!scan || !row || row.signals.listing === "none") return undefined;
    return scan.sessions
      .filter((cell) => cell.harness === harness && inWindow(cell.day))
      .reduce((total, cell) => total + cell.sessions, 0);
  };
  return {
    wholeFleet,
    machines: scans.map((scan) => scan.machine),
    usedBy: (item) => [...(users.get(item) ?? [])].sort(compare),
    tellsUse: (machine, harness) => tells.has(JSON.stringify([machine, harness])),
    items: (machine) =>
      machine === undefined
        ? scans.flatMap((scan) => scan.items)
        : (byMachine.get(machine)?.items ?? []),
    cells: (machine) => (byMachine.get(machine)?.cells ?? []).filter((cell) => inWindow(cell.day)),
    sessions: sessionsOf,
  };
};

/** A coverage row whose sessions and days count only the sessions the report kept. */
const keptCoverage = (
  row: Coverage,
  scan: Scan,
  keep: (cell: { day: Day; via: string }) => boolean,
): Coverage => {
  const kept: Coverage = { ...row, sessions: 0 };
  delete kept.firstDay;
  delete kept.lastDay;
  for (const cell of scan.sessions) {
    if (cell.harness !== row.harness || !keep(cell)) continue;
    kept.sessions += cell.sessions;
    if (cell.sessions === 0) continue;
    if (!kept.firstDay || cell.day < kept.firstDay) kept.firstDay = cell.day;
    if (!kept.lastDay || cell.day > kept.lastDay) kept.lastDay = cell.day;
  }
  return kept;
};

/** One harness's sheet and what its rules see behind it. */
const buildSheet = (
  harness: string,
  scans: Scan[],
  keep: (cell: { day: Day; via: string }) => boolean,
  last: Day,
): { sheet: Sheet; rules: RuleSheet } => {
  const installs = new Map<Id, Install[]>();
  const itemsOn = new Map<string, Item[]>();
  for (const scan of scans) {
    for (const item of scan.items) {
      if (!item.harnesses.includes(harness)) continue;
      installs.set(item.id, [...(installs.get(item.id) ?? []), { machine: scan.machine, item }]);
      const onMachine = itemsOn.get(scan.machine) ?? [];
      onMachine.push(item);
      itemsOn.set(scan.machine, onMachine);
    }
  }
  for (const list of installs.values()) {
    list.sort((a, b) => compare(a.machine, b.machine) || compare(a.item.path, b.item.path));
  }
  for (const list of itemsOn.values()) list.sort((a, b) => compare(a.path, b.path));

  let sessions = 0;
  const perMachine = new Map<string, number>();
  const firstOn = new Map<string, Day>();
  let fixedTokens = 0;
  let measured = 0;
  let recentTokens = 0;
  let recentMeasured = 0;
  const recentSince = new Date(Date.parse(`${last}T00:00:00Z`) - (RECENT_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  let firstDay: Day | undefined;
  let lastDay: Day | undefined;
  const usage = new Map<Id, Usage>();
  for (const scan of scans) {
    for (const cell of scan.sessions) {
      if (cell.harness !== harness || !keep(cell)) continue;
      if (cell.sessions > 0) {
        const first = firstOn.get(scan.machine);
        if (!first || cell.day < first) firstOn.set(scan.machine, cell.day);
        if (!firstDay || cell.day < firstDay) firstDay = cell.day;
        if (!lastDay || cell.day > lastDay) lastDay = cell.day;
      }
      sessions += cell.sessions;
      perMachine.set(scan.machine, (perMachine.get(scan.machine) ?? 0) + cell.sessions);
      fixedTokens += cell.fixedTokens;
      measured += cell.measured;
      if (cell.day >= recentSince) {
        recentTokens += cell.fixedTokens;
        recentMeasured += cell.measured;
      }
    }
    for (const cell of scan.cells) {
      if (cell.harness !== harness || !keep(cell)) continue;
      const known = usage.get(cell.item) ?? {
        sessions: 0,
        bare: 0,
        chars: 0,
        byModel: 0,
        byUser: 0,
        machines: new Set<string>(),
      };
      known.sessions += cell.sessions;
      known.bare += cell.bare;
      known.chars += cell.chars;
      known.byModel += cell.byModel;
      known.byUser += cell.byUser;
      if (cell.byModel + cell.byUser > 0 && (!known.lastUsed || cell.day > known.lastUsed)) {
        known.lastUsed = cell.day;
      }
      known.machines.add(scan.machine);
      usage.set(cell.item, known);
    }
  }

  const ids = new Set([...installs.keys(), ...usage.keys()]);
  const lines: Line[] = [];
  for (const id of ids) {
    const install = installs.get(id)?.[0]?.item;
    const used = usage.get(id);
    const machines = new Set([
      ...(installs.get(id) ?? []).map(({ machine }) => machine),
      ...(used?.machines ?? []),
    ]);
    // An item installed nowhere, or whose install measured no listing (an MCP server's size is not
    // on disk), is measured by what its sessions held.
    const chars = install ? { ...install.chars } : { listed: 0, body: 0 };
    if (chars.listed === 0 && used?.sessions) chars.listed = Math.round(used.chars / used.sessions);
    const line: Line = {
      item: id,
      ref: install ? { ...install.ref } : parseId(id),
      machines: [...machines].sort(compare),
      chars,
      tokens: { value: estimateTokens(chars.listed), basis: "estimated" },
      exposure: {
        sessions: used?.sessions ?? 0,
        share: sessions && used ? Math.round((used.sessions / sessions) * 10000) / 10000 : 0,
        bare: used?.bare ?? 0,
      },
      use: { byModel: used?.byModel ?? 0, byUser: used?.byUser ?? 0 },
    };
    if (used?.lastUsed) line.use.lastUsed = used.lastUsed;
    if (
      install?.description !== undefined &&
      (id.startsWith("skill:") || id.startsWith("subagent:"))
    )
      line.description = install.description;
    if (install) {
      line.scope = install.scope;
      if (install.pack !== undefined) line.pack = install.pack;
      line.managedBy = install.managedBy;
      line.path = install.path;
    }
    lines.push(line);
  }
  lines.sort(byTokens);

  const coverage = scans.flatMap((scan) => scan.coverage.filter((c) => c.harness === harness));
  const active = coverage.filter((c) => c.installed || c.sessions > 0);
  const machines = new Set([
    ...active.map((c) => c.machine),
    ...itemsOn.keys(),
    ...perMachine.keys(),
  ]);

  const sheet: Sheet = { harness, sessions, lines };
  // The last days' sessions, as the setup is now; the whole window's when none of those reported.
  if (recentMeasured > 0) {
    sheet.fixedTokens = { value: Math.round(recentTokens / recentMeasured), basis: "measured" };
  } else if (measured > 0) {
    sheet.fixedTokens = { value: Math.round(fixedTokens / measured), basis: "measured" };
  }
  const windows = coverage.flatMap((row) =>
    row.contextWindow === undefined ? [] : [row.contextWindow],
  );
  if (windows.length) sheet.contextWindow = Math.max(...windows);
  return {
    sheet,
    rules: {
      harness,
      sessions,
      days: firstDay && lastDay ? daysBetween(firstDay, lastDay) : 0,
      history: firstDay ? daysBetween(firstDay, last) : 0,
      machines: [...machines].sort(compare),
      sessionsOn: (machine) => perMachine.get(machine) ?? 0,
      historyOn: (machine) => {
        const first = firstOn.get(machine);
        return first ? daysBetween(first, last) : 0;
      },
      signals: worstSignals(active.length ? active : coverage),
      lines,
      installs: (item) => installs.get(item) ?? [],
      itemsOn: (machine) => itemsOn.get(machine) ?? [],
      usageOn: (machine) =>
        sumUsage(
          scans.filter((scan) => scan.machine === machine).map((scan) => scan.usage),
          (cell) => cell.harness === harness && keep(cell),
        ),
      settingsOn: (machine) => coverage.find((row) => row.machine === machine)?.settings,
    },
  };
};

/**
 * A Report from one Scan per machine: one sheet per harness, aggregated over machines by item id,
 * and what the rules find in them. Throws when two Scans name the same machine.
 */
export const buildReport = ({
  scans,
  config,
  now,
  tool,
  mode,
  machines = [],
}: BuildReportInput): Report => {
  const names = [...scans.map((scan) => scan.machine), ...machines.map((machine) => machine.name)];
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) {
    throw new Error(
      `Two Scans name the machine ${JSON.stringify(twice)}; merge them with mergeScans first`,
    );
  }

  // The window is the last `config.window` days up to the Scans' last day, as a Scan's own is.
  const today = now.toISOString().slice(0, 10);
  const firsts = scans.map((scan) => scan.window[0]).sort(compare);
  const lasts = scans.map((scan) => scan.window[1]).sort(compare);
  const last = lasts.at(-1) ?? today;
  const since = new Date(Date.parse(`${last}T00:00:00Z`) - (config.window - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const first = firsts[0] !== undefined && firsts[0] > since ? firsts[0] : since;
  const inWindow = (day: Day) => day >= first && day <= last;
  const include = new Set(config.via.include);
  const exclude = new Set(config.via.exclude);
  const keep = ({ day, via }: { day: Day; via: string }) =>
    inWindow(day) && (include.size === 0 || include.has(via)) && !exclude.has(via);

  // A harness gets a sheet when some machine has it installed, or has its items or sessions.
  const harnesses = new Set<string>();
  for (const scan of scans) {
    for (const coverage of scan.coverage) {
      if (coverage.installed || coverage.sessions > 0) harnesses.add(coverage.harness);
    }
    for (const item of scan.items) for (const harness of item.harnesses) harnesses.add(harness);
    for (const cell of scan.sessions) harnesses.add(cell.harness);
  }
  const wanted = config.harnesses ? new Set(config.harnesses) : undefined;
  const t3SuppliesSelected = config.harnesses?.some(
    (id) => !["claude-code", "codex", "grok", "opencode"].includes(id),
  );
  const built = [...harnesses]
    .filter((harness) => !wanted || wanted.has(harness))
    .sort(compare)
    .map((harness) => buildSheet(harness, scans, keep, last));

  const reportMode = mode ?? (names.length > 1 ? "fleet" : "local");
  // Every machine the report names has a Scan: one listed without, reachable or not, is unknown.
  const wholeFleet = reportMode === "fleet" && machines.length === 0;
  const { findings, skipped } = runRules({
    mode: reportMode,
    sheets: built.map(({ rules }) => rules),
    config,
    unfiltered: unfilteredOf(scans, wholeFleet, inWindow),
  });

  // Usage history is not cut by the window, only by `usageWindow` when one is set; the rules
  // read it through `usageOn`, inside the window.
  const usageSince =
    config.usageWindow === undefined
      ? undefined
      : new Date(Date.parse(`${last}T00:00:00Z`) - (config.usageWindow - 1) * DAY_MS)
          .toISOString()
          .slice(0, 10);
  const usage = sumUsage(
    scans.map((scan) => scan.usage),
    (cell) =>
      (!wanted || wanted.has(cell.harness)) &&
      (usageSince === undefined || (cell.day >= usageSince && cell.day <= last)) &&
      (include.size === 0 || include.has(cell.via)) &&
      !exclude.has(cell.via),
  );

  return {
    schema: 1,
    tool,
    generatedAt: now.toISOString(),
    mode: reportMode,
    machines: [
      ...scans.map((scan) => ({ name: scan.machine, reachable: true, scannedAt: scan.scannedAt })),
      ...machines,
    ],
    window: scans.length ? [first, last] : [today, today],
    config,
    coverage: scans
      .flatMap((scan) =>
        scan.coverage
          .filter(
            (row) =>
              !wanted ||
              wanted.has(row.harness) ||
              (t3SuppliesSelected && row.harness === "t3-code" && row.unread?.length),
          )
          .map((row) => keptCoverage(row, scan, keep)),
      )
      .sort((a, b) => compare(a.machine, b.machine) || compare(a.harness, b.harness)),
    sheet: built.map(({ sheet }) => sheet),
    findings,
    skipped,
    ...(usage ? { usage } : {}),
  };
};

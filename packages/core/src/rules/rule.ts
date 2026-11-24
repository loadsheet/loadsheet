import type {
  Cell,
  Finding,
  Grade,
  Id,
  Item,
  Line,
  ResolvedConfig,
  RuleId,
  RuleOptions,
  Signal,
} from "@loadsheet/schema";

/** One machine's install of an item: the Item a Scan of that machine holds. */
export interface Install {
  /** The machine's name. */
  machine: string;
  /** The installed Item. */
  item: Item;
}

/** One harness's sheet as a rule sees it: its lines and what is behind them. */
export interface RuleSheet {
  /** The harness id. */
  harness: string;
  /** Its sessions in the window, over all machines. */
  sessions: number;
  /** Days of history: from the first day with a session left after every filter to the last, inclusive; 0 without sessions. */
  days: number;
  /** Days from the first day with a session left after every filter to the window's last day, inclusive; 0 without sessions. */
  history: number;
  /** The machines it is on: those with its coverage, an Item it loads or one of its sessions; empty in pack mode. */
  machines: string[];
  /** Its sessions on a machine, after every filter. */
  sessionsOn: (machine: string) => number;
  /** How well each signal is provided: the worst grade among the machines read. */
  signals: Record<Signal, Grade>;
  /** The sheet's lines, without ignored items. */
  lines: Line[];
  /** Every install of an item this harness loads, by machine then path; empty in pack mode. */
  installs: (item: Id) => Install[];
  /** Every Item this harness loads on a machine, by path; empty in pack mode. */
  itemsOn: (machine: string) => Item[];
}

/**
 * What the Scans hold before any harness, entrypoint or ignore filter: what the guards that keep a
 * Fix right for the machine it names read. Empty in pack mode.
 */
export interface Unfiltered {
  /** Whether the Report is in fleet mode and read every machine it names. */
  wholeFleet: boolean;
  /** The machines that have a Scan. */
  machines: string[];
  /** The harnesses, on any machine and through any entrypoint, whose model or user invoked the item. */
  usedBy: (item: Id) => string[];
  /** Whether a harness on a machine can tell use: the machine covers it and grades modelUse and userUse above none. */
  tellsUse: (machine: string, harness: string) => boolean;
  /** Every Item on a machine, of every harness; with no machine, every Item of every machine. */
  items: (machine?: string) => Item[];
  /** A machine's usage counters in the window, of every harness and entrypoint. */
  cells: (machine: string) => Cell[];
  /**
   * A harness's sessions on a machine in the window, through every entrypoint; undefined when the
   * machine does not cover the harness or its coverage grades listing none, so it cannot tell.
   */
  sessions: (machine: string, harness: string) => number | undefined;
}

/** What a pack, read without Scans, holds. */
export const NOTHING_UNFILTERED: Unfiltered = {
  wholeFleet: false,
  machines: [],
  usedBy: () => [],
  tellsUse: () => false,
  items: () => [],
  cells: () => [],
  sessions: () => undefined,
};

/** What a rule sees: every sheet that can answer it, and its thresholds. */
export interface RuleContext<R extends RuleId = RuleId> {
  /** local, fleet or pack. */
  mode: "local" | "fleet" | "pack";
  /** The sheets whose harness provides the signals the rule needs and holds enough data. */
  sheets: RuleSheet[];
  /** This rule's thresholds. */
  options: RuleOptions[R];
  /** The whole config, for rules that need more than their own thresholds. */
  config: ResolvedConfig;
  /** The Scans before any filter. */
  unfiltered: Unfiltered;
}

/** A rule: the signals it cannot judge without, how much data it needs, and what it finds. One file per rule. */
export interface Rule<R extends RuleId = RuleId> {
  id: R;
  /** Signals the rule needs; a sheet is skipped as missing-signal when any of them is graded none. */
  needs: Signal[];
  /** Whether a sheet holds enough history to judge; a sheet that does not is skipped as not-enough-data. */
  enough?: (sheet: RuleSheet, options: RuleOptions[R], config: ResolvedConfig) => boolean;
  /** Runs once per Report over the sheets that can answer it, and gives one Finding per item. */
  run: (context: RuleContext<R>) => Finding[];
}

/** Declares a rule; it only checks the shape. */
export const defineRule = <R extends RuleId>(rule: Rule<R>): Rule<R> => rule;

/** Tokens estimated from characters, at four characters a token. */
export const estimateTokens = (chars: number) => Math.round(chars / 4);

/** A line of one sheet that a rule judged. */
export interface Hit {
  sheet: RuleSheet;
  line: Line;
}

/** The lines that match, grouped by item id across sheets, in first-seen order. */
export const hitsByItem = (
  sheets: RuleSheet[],
  match: (line: Line, sheet: RuleSheet) => boolean,
) => {
  const hits = new Map<Id, Hit[]>();
  for (const sheet of sheets) {
    for (const line of sheet.lines) {
      if (!match(line, sheet)) continue;
      const list = hits.get(line.item) ?? [];
      list.push({ sheet, line });
      hits.set(line.item, list);
    }
  }
  return hits;
};

/** Every machine and harness a group of hits holds for. */
export const whereOf = (hits: Hit[]) =>
  hits.flatMap(({ sheet, line }) =>
    line.machines.map((machine) => ({ machine, harness: sheet.harness })),
  );

/** A sum over hits. */
export const sum = (hits: Hit[], value: (hit: Hit) => number) =>
  hits.reduce((total, hit) => total + value(hit), 0);

const waste = (finding: Finding) =>
  (finding.savesTokens?.value ?? 1) * (finding.evidence.sessions ?? 0);

/** Findings by tokens spent in vain over the window, most first, then by id. */
export const byWaste = (a: Finding, b: Finding) =>
  waste(b) - waste(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The largest line tokens over hits, as an estimate of what one session pays. */
export const tokensOf = (hits: Hit[]) => ({
  value: Math.max(0, ...hits.map(({ line }) => line.tokens.value)),
  basis: "estimated" as const,
});

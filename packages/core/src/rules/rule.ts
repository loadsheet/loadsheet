import type {
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
  /** Days of history: from the first day with a session to the last, inclusive; 0 without sessions. */
  days: number;
  /** How well each signal is provided: the worst grade among the machines read. */
  signals: Record<Signal, Grade>;
  /** The sheet's lines, without ignored items. */
  lines: Line[];
  /** Every install of an item this harness loads, by machine then path; empty in pack mode. */
  installs: (item: Id) => Install[];
  /** Every Item this harness loads on a machine, by path; empty in pack mode. */
  itemsOn: (machine: string) => Item[];
}

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
  /** The harnesses, over every sheet, whose model or user invoked the item. */
  usedBy: (item: Id) => string[];
}

/** A rule: the signals it cannot judge without, how much data it needs, and what it finds. One file per rule. */
export interface Rule<R extends RuleId = RuleId> {
  id: R;
  /** Signals the rule needs; a sheet is skipped as missing-signal when any of them is graded none. */
  needs: Signal[];
  /** Whether a sheet holds enough history to judge; a sheet that does not is skipped as not-enough-data. */
  enough?: (sheet: RuleSheet, options: RuleOptions[R]) => boolean;
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

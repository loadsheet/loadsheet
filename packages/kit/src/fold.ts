// From Facts to a Scan's counters, and Scans of one machine back into one. Every step is a sum or
// a union, so folding sessions A and B together equals merging the Scan of A with the Scan of B.
import type {
  Cell,
  Coverage,
  Day,
  Grade,
  Item,
  Scan,
  SessionCell,
  Signal,
} from "@loadsheet/schema";
import type { Fact } from "./index.ts";

/** A harness version a session that started on `day` ran. */
export interface VersionSeen {
  readonly harness: string;
  readonly day: Day;
  readonly version: string;
}

/**
 * Counters folded from Facts, keyed by day so a window can be cut from them later. Plain JSON,
 * sorted, with one entry per key: the cache keeps one per transcript file.
 */
export interface Tally {
  readonly sessions: SessionCell[];
  readonly cells: Cell[];
  readonly versions: VersionSeen[];
}

const SEP = "\u0000";
const sessionKey = (cell: { day: Day; harness: string; via: string }) =>
  [cell.day, cell.harness, cell.via].join(SEP);
const cellKey = (cell: { day: Day; harness: string; via: string; item: string }) =>
  [cell.day, cell.harness, cell.via, cell.item].join(SEP);
const versionKey = (seen: VersionSeen) => [seen.harness, seen.day, seen.version].join(SEP);
const byKey = <T>(key: (value: T) => string) => {
  return (a: T, b: T) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
};

/** Sums counters by key; what `foldFacts`, `sumTallies` and `mergeScans` share. */
class Accumulator {
  readonly #sessions = new Map<string, SessionCell>();
  readonly #cells = new Map<string, Cell>();
  readonly #versions = new Map<string, VersionSeen>();

  session(day: Day, harness: string, via: string): SessionCell {
    const key = sessionKey({ day, harness, via });
    let cell = this.#sessions.get(key);
    if (!cell) {
      cell = { day, harness, via, sessions: 0, fixedTokens: 0, measured: 0 };
      this.#sessions.set(key, cell);
    }
    return cell;
  }

  cell(day: Day, harness: string, via: string, item: string): Cell {
    const key = cellKey({ day, harness, via, item });
    let cell = this.#cells.get(key);
    if (!cell) {
      cell = { day, harness, via, item, sessions: 0, bare: 0, chars: 0, byModel: 0, byUser: 0 };
      this.#cells.set(key, cell);
    }
    return cell;
  }

  version(seen: VersionSeen): void {
    const { harness, day, version } = seen;
    this.#versions.set(versionKey(seen), { harness, day, version });
  }

  fact(harness: string, fact: Fact): void {
    switch (fact.type) {
      case "session":
        this.session(fact.day, harness, fact.via).sessions += 1;
        if (fact.version !== undefined) {
          this.version({ harness, day: fact.day, version: fact.version });
        }
        return;
      case "tokens": {
        const cell = this.session(fact.day, harness, fact.via);
        cell.fixedTokens += fact.tokens;
        cell.measured += 1;
        return;
      }
      case "listed": {
        const cell = this.cell(fact.day, harness, fact.via, fact.item);
        cell.sessions += 1;
        cell.chars += fact.chars;
        if (fact.bare) cell.bare += 1;
        return;
      }
      case "used": {
        const cell = this.cell(fact.day, harness, fact.via, fact.item);
        if (fact.by === "model") cell.byModel += 1;
        else cell.byUser += 1;
      }
    }
  }

  tally(tally: Tally, keep: (day: Day) => boolean): void {
    for (const from of tally.sessions) {
      if (!keep(from.day)) continue;
      const cell = this.session(from.day, from.harness, from.via);
      cell.sessions += from.sessions;
      cell.fixedTokens += from.fixedTokens;
      cell.measured += from.measured;
    }
    for (const from of tally.cells) {
      if (!keep(from.day)) continue;
      const cell = this.cell(from.day, from.harness, from.via, from.item);
      cell.sessions += from.sessions;
      cell.bare += from.bare;
      cell.chars += from.chars;
      cell.byModel += from.byModel;
      cell.byUser += from.byUser;
    }
    for (const seen of tally.versions) if (keep(seen.day)) this.version(seen);
  }

  result(): Tally {
    return {
      sessions: [...this.#sessions.values()].sort(byKey(sessionKey)),
      cells: [...this.#cells.values()].sort(byKey(cellKey)),
      versions: [...this.#versions.values()].sort(byKey(versionKey)),
    };
  }
}

/** Folds one harness's Facts into counters: `session` and `tokens` into SessionCells, `listed` and `used` into Cells. */
export const foldFacts = (harness: string, facts: Iterable<Fact>): Tally => {
  const accumulator = new Accumulator();
  for (const fact of facts) accumulator.fact(harness, fact);
  return accumulator.result();
};

/** Sums tallies, keeping only the days inside `window` when it is given. */
export const sumTallies = (tallies: Iterable<Tally>, window?: readonly [Day, Day]): Tally => {
  const keep = window ? (day: Day) => day >= window[0] && day <= window[1] : () => true;
  const accumulator = new Accumulator();
  for (const tally of tallies) accumulator.tally(tally, keep);
  return accumulator.result();
};

/** What one harness on one machine could tell, from its counters. */
export const coverageOf = (
  tally: Tally,
  base: {
    machine: string;
    harness: string;
    installed: boolean;
    signals: Record<Signal, Grade>;
  },
): Coverage => {
  const sessions = tally.sessions.filter(
    (cell) => cell.harness === base.harness && cell.sessions > 0,
  );
  const days = sessions.map((cell) => cell.day).sort();
  const versions = new Set(
    tally.versions.filter((seen) => seen.harness === base.harness).map((seen) => seen.version),
  );
  return {
    machine: base.machine,
    harness: base.harness,
    installed: base.installed,
    sessions: sessions.reduce((sum, cell) => sum + cell.sessions, 0),
    versions: [...versions].sort(),
    ...(days.length ? { firstDay: days[0]!, lastDay: days.at(-1)! } : {}),
    signals: { ...base.signals },
  };
};

const itemKey = (item: Item) => [item.id, item.path].join(SEP);

/** Items by id and path; the same item from two harnesses or two Scans lists both harnesses. */
const unionItems = (lists: Iterable<readonly Item[]>): Item[] => {
  const items = new Map<string, Item>();
  for (const list of lists) {
    for (const item of list) {
      const key = itemKey(item);
      const known = items.get(key);
      const harnesses = new Set([...(known?.harnesses ?? []), ...item.harnesses]);
      items.set(key, { ...item, harnesses: [...harnesses].sort() });
    }
  }
  return [...items.values()].sort(byKey(itemKey));
};

/** One harness's part of a machine's Scan. */
export interface HarnessScan {
  readonly harness: string;
  readonly installed: boolean;
  readonly signals: Record<Signal, Grade>;
  readonly items: readonly Item[];
  readonly tally: Tally;
}

/** A machine's Scan from each harness's part, keeping only the counters inside `window`. */
export const buildScan = (input: {
  tool: string;
  machine: string;
  scannedAt: string;
  window: [Day, Day];
  harnesses: readonly HarnessScan[];
}): Scan => {
  const tallies = input.harnesses.map((part) => sumTallies([part.tally], input.window));
  const total = sumTallies(tallies);
  return {
    schema: 1,
    tool: input.tool,
    machine: input.machine,
    scannedAt: input.scannedAt,
    window: [...input.window],
    coverage: input.harnesses
      .map((part, index) => coverageOf(tallies[index]!, { ...part, machine: input.machine }))
      .sort(byKey((coverage) => coverage.harness)),
    items: unionItems(input.harnesses.map((part) => part.items)),
    sessions: total.sessions,
    cells: total.cells,
  };
};

/**
 * Merges Scans of the same machine: counters are summed, everything else is unioned. The Scans
 * must cover different sessions, or those are counted twice. Where two Scans describe the same
 * item or harness differently, the later scan wins. Throws on Scans of different machines.
 */
export const mergeScans = (first: Scan, ...rest: Scan[]): Scan => {
  const scans = [first, ...rest];
  const machine = first.machine;
  if (scans.some((scan) => scan.machine !== machine)) {
    throw new Error(
      "mergeScans merges Scans of one machine; Scans of different machines stay separate",
    );
  }
  // Oldest first, so the later scan's description of an item or harness is the one kept.
  const ordered = [...scans].sort(byKey((scan) => scan.scannedAt));
  const latest = ordered.at(-1)!;

  const counters = new Accumulator();
  for (const scan of ordered) {
    counters.tally({ sessions: scan.sessions, cells: scan.cells, versions: [] }, () => true);
  }
  const total = counters.result();

  const coverage = new Map<string, Coverage>();
  for (const scan of ordered) {
    for (const next of scan.coverage) {
      const known = coverage.get(next.harness);
      if (!known) {
        coverage.set(next.harness, { ...next, versions: [...next.versions], machine });
        continue;
      }
      const days = [known.firstDay, known.lastDay, next.firstDay, next.lastDay]
        .filter((day) => day !== undefined)
        .sort();
      coverage.set(next.harness, {
        machine,
        harness: next.harness,
        installed: known.installed || next.installed,
        sessions: known.sessions + next.sessions,
        versions: [...new Set([...known.versions, ...next.versions])].sort(),
        ...(days.length ? { firstDay: days[0]!, lastDay: days.at(-1)! } : {}),
        signals: { ...next.signals },
      });
    }
  }

  const starts = scans.map((scan) => scan.window[0]).sort();
  const ends = scans.map((scan) => scan.window[1]).sort();
  return {
    schema: 1,
    tool: latest.tool,
    machine,
    scannedAt: latest.scannedAt,
    window: [starts[0]!, ends.at(-1)!],
    coverage: [...coverage.values()].sort(byKey((entry) => entry.harness)),
    items: unionItems(ordered.map((scan) => scan.items)),
    sessions: total.sessions,
    cells: total.cells,
  };
};

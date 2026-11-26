// Counters summed by key: what folding Facts, summing tallies and merging Scans share. Kept out of
// kit's exports; the scan cache sums its encoded tallies into it without building a Tally first.
import type { Cell, Day, SessionCell } from "@loadsheet/schema";
import type { Fact } from "./index.ts";
import type { Tally, VersionSeen, WindowSeen } from "./fold.ts";

export const SEP = "\u0000";
const sessionKey = (cell: { day: Day; harness: string; via: string }) =>
  [cell.day, cell.harness, cell.via].join(SEP);
const cellKey = (cell: { day: Day; harness: string; via: string; item: string }) =>
  [cell.day, cell.harness, cell.via, cell.item].join(SEP);
const versionKey = (seen: VersionSeen) => [seen.harness, seen.day, seen.version].join(SEP);
const windowKey = (seen: WindowSeen) =>
  [seen.harness, seen.day, String(seen.tokens).padStart(12, "0")].join(SEP);

export const byKey = <T>(key: (value: T) => string) => {
  return (a: T, b: T) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
};

/** `values` in the order `byKey(key)` gives, working out each key once. */
const sortedBy = <T>(values: Iterable<T>, key: (value: T) => string): T[] =>
  Array.from(values, (value) => ({ key: key(value), value }))
    .sort(byKey((entry) => entry.key))
    .map((entry) => entry.value);

/** Sums counters by key; a tally's days outside `window`, when it is given, are left out. */
export class Accumulator {
  readonly keep: (day: Day) => boolean;
  readonly #sessions = new Map<string, SessionCell>();
  /** Cells by their day, harness and via, then by item. */
  readonly #groups = new Map<string, Map<string, Cell>>();
  /** The group the last cell went to: a tally lists its cells grouped. */
  #last: { day: Day; harness: string; via: string; cells: Map<string, Cell> } | undefined;
  readonly #versions = new Map<string, VersionSeen>();
  readonly #windows = new Map<string, WindowSeen>();

  constructor(window?: readonly [Day, Day]) {
    this.keep = window ? (day) => day >= window[0] && day <= window[1] : () => true;
  }

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
    let last = this.#last;
    if (last?.day !== day || last.harness !== harness || last.via !== via) {
      const key = sessionKey({ day, harness, via });
      let cells = this.#groups.get(key);
      if (!cells) {
        cells = new Map();
        this.#groups.set(key, cells);
      }
      last = { day, harness, via, cells };
      this.#last = last;
    }
    let cell = last.cells.get(item);
    if (!cell) {
      cell = { day, harness, via, item, sessions: 0, bare: 0, chars: 0, byModel: 0, byUser: 0 };
      last.cells.set(item, cell);
    }
    return cell;
  }

  version(seen: VersionSeen): void {
    const { harness, day, version } = seen;
    this.#versions.set(versionKey(seen), { harness, day, version });
  }

  window(seen: WindowSeen): void {
    const { harness, day, tokens } = seen;
    this.#windows.set(windowKey(seen), { harness, day, tokens });
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
      case "window":
        this.window({ harness, day: fact.day, tokens: fact.tokens });
        return;
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

  tally(tally: Tally): void {
    const keep = this.keep;
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
    for (const seen of tally.windows ?? []) if (keep(seen.day)) this.window(seen);
  }

  result(): Tally {
    const cells: Cell[] = [];
    for (const group of this.#groups.values()) for (const cell of group.values()) cells.push(cell);
    const tally: Tally = {
      sessions: sortedBy(this.#sessions.values(), sessionKey),
      cells: sortedBy(cells, cellKey),
      versions: sortedBy(this.#versions.values(), versionKey),
    };
    if (this.#windows.size === 0) return tally;
    return { ...tally, windows: sortedBy(this.#windows.values(), windowKey) };
  }
}

// Counters summed by key: what folding Facts, summing tallies and merging Scans share. Kept out of
// kit's exports; the scan cache sums its encoded tallies into it without building a Tally first.
import type {
  Cell,
  Day,
  SessionCell,
  Thread,
  Usage,
  UsageSessionCell,
  UsageTokenCell,
} from "@loadsheet/schema";
import type { Fact } from "./index.ts";
import type { Tally, VersionSeen, WindowSeen } from "./fold.ts";

export const SEP = "\u0000";
const sessionKey = (cell: { day: Day; harness: string; via: string }) =>
  [cell.day, cell.harness, cell.via].join(SEP);
const cellKey = (cell: { day: Day; harness: string; via: string; item: string }) =>
  [cell.day, cell.harness, cell.via, cell.item].join(SEP);
const usageSessionKey = (cell: UsageSessionCell) =>
  [cell.day, cell.harness, cell.via, cell.project, cell.thread].join(SEP);
const usageTokenKey = (cell: UsageTokenCell) =>
  [cell.day, cell.harness, cell.via, cell.project, cell.thread, cell.model].join(SEP);
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
  readonly #usageSessions = new Map<string, UsageSessionCell>();
  readonly #usageTokens = new Map<string, UsageTokenCell>();

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

  usageSession(key: {
    day: Day;
    harness: string;
    via: string;
    project: string;
    thread: Thread;
  }): UsageSessionCell {
    const { day, harness, via, project, thread } = key;
    const blank: UsageSessionCell = {
      day,
      harness,
      via,
      project,
      thread,
      sessions: 0,
      compacted: 0,
      compactions: 0,
      manualCompactions: 0,
    };
    const id = usageSessionKey(blank);
    let cell = this.#usageSessions.get(id);
    if (!cell) {
      cell = blank;
      this.#usageSessions.set(id, cell);
    }
    return cell;
  }

  usageTokens(key: {
    day: Day;
    harness: string;
    via: string;
    project: string;
    thread: Thread;
    model: string;
  }): UsageTokenCell {
    const { day, harness, via, project, thread, model } = key;
    const blank: UsageTokenCell = {
      day,
      harness,
      via,
      project,
      thread,
      model,
      requests: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRewrite: 0,
    };
    const id = usageTokenKey(blank);
    let cell = this.#usageTokens.get(id);
    if (!cell) {
      cell = blank;
      this.#usageTokens.set(id, cell);
    }
    return cell;
  }

  /** Adds a Usage's cells inside the window. */
  usage(usage: Usage): void {
    for (const from of usage.sessions) {
      if (!this.keep(from.day)) continue;
      const cell = this.usageSession(from);
      cell.sessions += from.sessions;
      cell.compacted += from.compacted;
      cell.compactions += from.compactions;
      cell.manualCompactions += from.manualCompactions;
    }
    for (const from of usage.tokens) {
      if (!this.keep(from.day)) continue;
      const cell = this.usageTokens(from);
      cell.requests += from.requests;
      cell.input += from.input;
      cell.output += from.output;
      cell.reasoning += from.reasoning;
      cell.cacheRead += from.cacheRead;
      cell.cacheWrite += from.cacheWrite;
      cell.cacheWrite5m += from.cacheWrite5m;
      cell.cacheWrite1h += from.cacheWrite1h;
      cell.cacheRewrite += from.cacheRewrite;
      if (from.unsplit) cell.unsplit = (cell.unsplit ?? 0) + from.unsplit;
    }
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
        return;
      }
      case "usage-session":
        this.usageSession({ ...fact, harness }).sessions += 1;
        return;
      case "compaction": {
        const cell = this.usageSession({ ...fact, harness });
        cell.compactions += 1;
        if (fact.first) cell.compacted += 1;
        if (fact.manual) cell.manualCompactions += 1;
        return;
      }
      case "usage-tokens": {
        const cell = this.usageTokens({ ...fact, harness });
        // Each part is held to its whole here, so every cell keeps the schema's bounds.
        const write5m = Math.min(fact.cacheWrite5m, fact.cacheWrite);
        cell.requests += fact.requests ?? 1;
        cell.input += fact.input;
        cell.output += fact.output;
        cell.reasoning += Math.min(fact.reasoning, fact.output);
        cell.cacheRead += fact.cacheRead;
        cell.cacheWrite += fact.cacheWrite;
        cell.cacheWrite5m += write5m;
        cell.cacheWrite1h += Math.min(fact.cacheWrite1h, fact.cacheWrite - write5m);
        cell.cacheRewrite += Math.min(fact.cacheRewrite, fact.cacheWrite);
        // Written only when some are counted, so cells without any keep their shape.
        if (fact.unsplit) cell.unsplit = (cell.unsplit ?? 0) + fact.unsplit;
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
    if (tally.usage) this.usage(tally.usage);
  }

  result(): Tally {
    const cells: Cell[] = [];
    for (const group of this.#groups.values()) for (const cell of group.values()) cells.push(cell);
    const tally: Tally = {
      sessions: sortedBy(this.#sessions.values(), sessionKey),
      cells: sortedBy(cells, cellKey),
      versions: sortedBy(this.#versions.values(), versionKey),
    };
    const usage = this.usageResult();
    return {
      ...tally,
      ...(this.#windows.size === 0 ? {} : { windows: sortedBy(this.#windows.values(), windowKey) }),
      ...(usage ? { usage } : {}),
    };
  }

  /** The usage cells summed so far, sorted; undefined when there are none. */
  usageResult(): Usage | undefined {
    if (this.#usageSessions.size === 0 && this.#usageTokens.size === 0) return undefined;
    return {
      sessions: sortedBy(this.#usageSessions.values(), usageSessionKey),
      tokens: sortedBy(this.#usageTokens.values(), usageTokenKey),
    };
  }
}

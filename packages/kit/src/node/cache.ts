// The scan cache: the only thing loadsheet writes. Per transcript file it keeps where reading
// stopped and the counters the committed lines gave, so a warm run reads only new bytes. It holds
// no transcript text, session id, file name or path: files are keyed by a salted hash.
//
// On disk every string is an index into one table per cache file, and counters are flat tuples
// grouped by day, harness and entrypoint, because thousands of transcripts repeat the same names.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cell, Day, Thread } from "@loadsheet/schema";
import type { Tally, TranscriptFormat } from "../index.ts";
import { Accumulator } from "../sum.ts";
import type { ReadPosition } from "./reader.ts";

/** The layout of a cache file; a change here starts every cache cold. */
const CACHE_LAYOUT = 6;

/** What the cache keeps for one transcript file. */
export interface CachedFile {
  /** The file's size, mtime and ctime when it was read, to skip a file that has not changed. */
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  /** Whether it ended in an unterminated line, which is read again every run. */
  readonly hasTail: boolean;
  /** Where reading stopped, after the last complete line. */
  readonly position: ReadPosition;
  /** The counters of the lines before `position`. */
  readonly tally: Tally;
}

/** One harness's cache: its files by key, valid for one tool version and transcript format. */
export interface HarnessCache {
  /** Hashes a transcript's absolute path into its key. */
  key(path: string): string;
  get(key: string): CachedFile | undefined;
  /**
   * The sum of `files`' tallies, keeping only the days inside `window`. Those `get` returned are
   * summed as the cache file holds them, without building their Tally.
   */
  sum(files: Iterable<CachedFile>, window: readonly [Day, Day]): Tally;
  /**
   * Writes `files` as the whole cache, atomically; files it leaves out are forgotten. Writes
   * nothing when `files` holds exactly the entries `get` returned from the file on disk.
   */
  save(files: ReadonlyMap<string, CachedFile>): Promise<void>;
}

/** Where the cache lives by default: `$XDG_CACHE_HOME/loadsheet`, else `~/.cache/loadsheet`. */
export const defaultCacheDir = (place: {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}): string => join(place.env.XDG_CACHE_HOME || join(place.home, ".cache"), "loadsheet");

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

// A cache file is `{"layout":6,"sum":"<sha256 of the document's text>","doc":<document>}`, so one
// cut short or changed by anything else opens empty, and checking it hashes the bytes as read.
const HEAD = `{"layout":${CACHE_LAYOUT},"sum":"`;
const DOC = '","doc":';
const HEAD_BYTES = Buffer.from(HEAD);
const DOC_BYTES = Buffer.from(DOC);
const SUM_LENGTH = 64;
const DOC_AT = HEAD.length + SUM_LENGTH + DOC.length;

const storedText = (document: string) => `${HEAD}${sha256(document)}${DOC}${document}}`;

/** The document a cache file holds, or undefined when its layout or sum is not this one's. */
const storedDocument = (bytes: Buffer): unknown => {
  if (
    bytes.length <= DOC_AT ||
    !bytes.subarray(0, HEAD.length).equals(HEAD_BYTES) ||
    !bytes.subarray(DOC_AT - DOC.length, DOC_AT).equals(DOC_BYTES) ||
    bytes[bytes.length - 1] !== 0x7d
  ) {
    return undefined;
  }
  const document = bytes.subarray(DOC_AT, -1);
  if (sha256(document) !== bytes.toString("latin1", HEAD.length, HEAD.length + SUM_LENGTH)) {
    return undefined;
  }
  return JSON.parse(document.toString("utf8")) as unknown;
};

/** Changes when the harness's parser or its `skip` does, so a new format starts cold. */
const formatFingerprint = (format: TranscriptFormat<unknown>) => {
  const skip = (format as { skip?: unknown }).skip;
  return sha256(
    JSON.stringify([
      format.markers,
      format.initial(),
      format.parse.toString(),
      typeof skip === "function" ? skip.toString() : null,
    ]),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** A `YYYY-MM-DD` calendar day, which the window filter compares as a string. */
const isDay = (text: string) => {
  if (!DAY.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
};

/** Thrown while decoding a malformed entry, which then opens as a miss. */
class Malformed extends Error {}

/** A cache file's strings, each stored once and referred to by index. */
class StringTable {
  readonly strings: string[] = [];
  readonly #index = new Map<string, number>();

  ref(text: string): number {
    let index = this.#index.get(text);
    if (index === undefined) {
      index = this.strings.push(text) - 1;
      this.#index.set(text, index);
    }
    return index;
  }
}

/** Reads encoded counters and string references, throwing Malformed on anything else. */
class Decoder {
  readonly strings: readonly string[];
  /** Per string: 0 not checked yet, 1 a day, -1 not one. */
  readonly #days: Int8Array;

  constructor(strings: readonly string[]) {
    this.strings = strings;
    this.#days = new Int8Array(strings.length);
  }

  isRef(value: unknown): value is number {
    return (
      Number.isInteger(value) && (value as number) >= 0 && (value as number) < this.strings.length
    );
  }

  text(value: unknown): string {
    if (!this.isRef(value)) throw new Malformed();
    return this.strings[value]!;
  }

  /** A `YYYY-MM-DD` calendar day, which the window filter compares as a string. */
  day(value: unknown): string {
    const text = this.text(value);
    const index = value as number;
    if (this.#days[index] === 0) this.#days[index] = isDay(text) ? 1 : -1;
    if (this.#days[index] === -1) throw new Malformed();
    return text;
  }

  /** A usage cell's thread, `main` or `subagent`. */
  thread(value: unknown): Thread {
    const text = this.text(value);
    if (text !== "main" && text !== "subagent") throw new Malformed();
    return text;
  }

  count(value: unknown): number {
    if (!isCount(value)) throw new Malformed();
    return value;
  }

  /** A limit reading's value: a finite number of at least 0, or -1 for none. */
  gauge(value: unknown): number {
    if (value !== -1 && !(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      throw new Malformed();
    }
    return value;
  }

  /** `value` as an array whose length is a multiple of `stride`. */
  tuples(value: unknown, stride: number): unknown[] {
    if (!Array.isArray(value) || value.length % stride !== 0) throw new Malformed();
    return value;
  }
}

// The adapter's state is any JSON value, opaque to kit. Encoded, each JSON type stands for
// another so no tags are needed: a string is its table index, a number its decimal string, an
// object a flat [key, value, ...] array with keys as indices, and an array `{ a: items }`. true,
// false and null stay as they are.

const isJsonMember = (value: unknown) =>
  value !== undefined && typeof value !== "function" && typeof value !== "symbol";

const encodeValue = (value: unknown, table: StringTable): unknown => {
  if (typeof value === "string") return table.ref(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return { a: value.map((item) => (isJsonMember(item) ? encodeValue(item, table) : null)) };
  }
  if (typeof value === "object") {
    const flat: unknown[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (isJsonMember(item)) flat.push(table.ref(key), encodeValue(item, table));
    }
    return flat;
  }
  return null;
};

const checkValue = (raw: unknown, decoder: Decoder): void => {
  if (typeof raw === "number") {
    decoder.text(raw);
  } else if (typeof raw === "string") {
    const number = Number(raw);
    if (!Number.isFinite(number) || String(number) !== raw) throw new Malformed();
  } else if (Array.isArray(raw)) {
    decoder.tuples(raw, 2);
    for (let index = 0; index < raw.length; index += 2) {
      decoder.text(raw[index]);
      checkValue(raw[index + 1], decoder);
    }
  } else if (isRecord(raw)) {
    if (!Array.isArray(raw.a) || Object.keys(raw).length !== 1) throw new Malformed();
    for (const item of raw.a) checkValue(item, decoder);
  } else if (typeof raw !== "boolean" && raw !== null) {
    throw new Malformed();
  }
};

/** Decodes a value `checkValue` accepted. */
const decodeValue = (raw: unknown, strings: readonly string[]): unknown => {
  if (typeof raw === "number") return strings[raw];
  if (typeof raw === "string") return Number(raw);
  if (Array.isArray(raw)) {
    const entries: [string, unknown][] = [];
    for (let index = 0; index < raw.length; index += 2) {
      entries.push([strings[raw[index] as number]!, decodeValue(raw[index + 1], strings)]);
    }
    // fromEntries defines own properties, so a "__proto__" key stays data.
    return Object.fromEntries(entries);
  }
  if (isRecord(raw)) return (raw.a as unknown[]).map((item) => decodeValue(item, strings));
  return raw;
};

/** An encoded value moved from one table to another, without decoding it. */
const retable = (raw: unknown, from: readonly string[], to: StringTable): unknown => {
  if (typeof raw === "number") return to.ref(from[raw]!);
  if (Array.isArray(raw)) return raw.map((item) => retable(item, from, to));
  if (isRecord(raw)) return { a: (raw.a as unknown[]).map((item) => retable(item, from, to)) };
  return raw;
};

// A Tally encodes as [sessions, cells, versions, windows, usageSessions, usageTokens, usageTurns,
// usageHours, usageTools, usageLimits]:
//   sessions:      day, harness, via, sessions, fixedTokens, measured, ...
//   cells:         day, harness, via, [item, sessions, bare, chars, byModel, byUser, ...], ...
//   versions:      harness, day, version, ...
//   windows:       harness, day, tokens, ...
//   usageSessions: day, harness, via, project, thread, sessions, compacted, compactions,
//                  manualCompactions, ...
//   usageTokens:   day, harness, via, project, thread, model, requests, input, output, reasoning,
//                  cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, cacheRewrite, ...
//   usageTurns:    day, harness, via, project, thread, turns, interrupted, timed, durationMs,
//                  toolCalls, withSubagents, ...
//   usageHours:    day, harness, thread, hour, requests, turns, ...
//   usageTools:    day, harness, thread, tool, calls, ...
//   usageLimits:   day, harness, windowMinutes, reached, usedPercent, at, resetsAt,
//                  peakUsedPercent, ... with -1 for a reading's value that is absent
// Within each tuple the strings come first: `refs` is how many.

/** An encoded tally, as `checkTally` accepted it. */
type EncodedTally = [
  number[],
  (number | number[])[],
  number[],
  number[],
  number[],
  number[],
  number[],
  number[],
  number[],
  number[],
];

const USAGE_SESSION_STRIDE = 9;
const USAGE_SESSION_REFS = 5;
const USAGE_TOKEN_STRIDE = 15;
const USAGE_TOKEN_REFS = 6;
const USAGE_TURN_STRIDE = 11;
const USAGE_TURN_REFS = 5;
const USAGE_HOUR_STRIDE = 6;
const USAGE_HOUR_REFS = 3;
const USAGE_TOOL_STRIDE = 5;
const USAGE_TOOL_REFS = 4;
const USAGE_LIMIT_STRIDE = 8;
const USAGE_LIMIT_REFS = 2;

/** A limit reading's optional value as a tuple holds it. */
const gauge = (value: number | undefined) => value ?? -1;
const ungauge = (value: number) => (value === -1 ? undefined : value);

const encodeTally = (tally: Tally, table: StringTable): unknown => {
  const sessions: number[] = [];
  for (const cell of tally.sessions) {
    sessions.push(table.ref(cell.day), table.ref(cell.harness), table.ref(cell.via));
    sessions.push(cell.sessions, cell.fixedTokens, cell.measured);
  }
  const cells: unknown[] = [];
  let group: number[] = [];
  let last: Cell | undefined;
  for (const cell of tally.cells) {
    if (last?.day !== cell.day || last.harness !== cell.harness || last.via !== cell.via) {
      group = [];
      cells.push(table.ref(cell.day), table.ref(cell.harness), table.ref(cell.via), group);
    }
    group.push(
      table.ref(cell.item),
      cell.sessions,
      cell.bare,
      cell.chars,
      cell.byModel,
      cell.byUser,
    );
    last = cell;
  }
  const versions: number[] = [];
  for (const seen of tally.versions) {
    versions.push(table.ref(seen.harness), table.ref(seen.day), table.ref(seen.version));
  }
  const windows: number[] = [];
  for (const seen of tally.windows ?? []) {
    windows.push(table.ref(seen.harness), table.ref(seen.day), seen.tokens);
  }
  const usageSessions: number[] = [];
  for (const cell of tally.usage?.sessions ?? []) {
    usageSessions.push(
      table.ref(cell.day),
      table.ref(cell.harness),
      table.ref(cell.via),
      table.ref(cell.project),
      table.ref(cell.thread),
      cell.sessions,
      cell.compacted,
      cell.compactions,
      cell.manualCompactions,
    );
  }
  const usageTokens: number[] = [];
  for (const cell of tally.usage?.tokens ?? []) {
    usageTokens.push(
      table.ref(cell.day),
      table.ref(cell.harness),
      table.ref(cell.via),
      table.ref(cell.project),
      table.ref(cell.thread),
      table.ref(cell.model),
      cell.requests,
      cell.input,
      cell.output,
      cell.reasoning,
      cell.cacheRead,
      cell.cacheWrite,
      cell.cacheWrite5m,
      cell.cacheWrite1h,
      cell.cacheRewrite,
    );
  }
  const usage = tally.usage;
  const usageTurns: number[] = [];
  for (const cell of usage?.turns ?? []) {
    usageTurns.push(
      table.ref(cell.day),
      table.ref(cell.harness),
      table.ref(cell.via),
      table.ref(cell.project),
      table.ref(cell.thread),
      cell.turns,
      cell.interrupted,
      cell.timed,
      cell.durationMs,
      cell.toolCalls,
      cell.withSubagents,
    );
  }
  const usageHours: number[] = [];
  for (const cell of usage?.hours ?? []) {
    usageHours.push(
      table.ref(cell.day),
      table.ref(cell.harness),
      table.ref(cell.thread),
      cell.hour,
      cell.requests,
      cell.turns,
    );
  }
  const usageTools: number[] = [];
  for (const cell of usage?.tools ?? []) {
    usageTools.push(
      table.ref(cell.day),
      table.ref(cell.harness),
      table.ref(cell.thread),
      table.ref(cell.tool),
      cell.calls,
    );
  }
  const usageLimits: number[] = [];
  for (const cell of usage?.limits ?? []) {
    usageLimits.push(
      table.ref(cell.day),
      table.ref(cell.harness),
      cell.windowMinutes,
      cell.reached,
      gauge(cell.usedPercent),
      gauge(cell.at),
      gauge(cell.resetsAt),
      gauge(cell.peakUsedPercent),
    );
  }
  return [
    sessions,
    cells,
    versions,
    windows,
    usageSessions,
    usageTokens,
    usageTurns,
    usageHours,
    usageTools,
    usageLimits,
  ];
};

/** Throws Malformed unless `raw` is an encoded tally. */
const checkTally = (raw: unknown, decoder: Decoder): EncodedTally => {
  if (!Array.isArray(raw) || raw.length !== 10) throw new Malformed();
  const [
    sessions,
    groups,
    versions,
    windows,
    usageSessions,
    usageTokens,
    usageTurns,
    usageHours,
    usageTools,
    usageLimits,
  ] = raw as unknown[];
  const flatSessions = decoder.tuples(sessions, 6);
  for (let index = 0; index < flatSessions.length; index += 6) {
    decoder.day(flatSessions[index]);
    decoder.text(flatSessions[index + 1]);
    decoder.text(flatSessions[index + 2]);
    for (let at = 3; at < 6; at += 1) decoder.count(flatSessions[index + at]);
  }
  const flatGroups = decoder.tuples(groups, 4);
  for (let index = 0; index < flatGroups.length; index += 4) {
    decoder.day(flatGroups[index]);
    decoder.text(flatGroups[index + 1]);
    decoder.text(flatGroups[index + 2]);
    const items = decoder.tuples(flatGroups[index + 3], 6);
    for (let at = 0; at < items.length; at += 6) {
      decoder.text(items[at]);
      for (let count = 1; count < 6; count += 1) decoder.count(items[at + count]);
    }
  }
  const flatVersions = decoder.tuples(versions, 3);
  for (let index = 0; index < flatVersions.length; index += 3) {
    decoder.text(flatVersions[index]);
    decoder.day(flatVersions[index + 1]);
    decoder.text(flatVersions[index + 2]);
  }
  const flatWindows = decoder.tuples(windows, 3);
  for (let index = 0; index < flatWindows.length; index += 3) {
    decoder.text(flatWindows[index]);
    decoder.day(flatWindows[index + 1]);
    decoder.count(flatWindows[index + 2]);
  }
  const flatUsageSessions = decoder.tuples(usageSessions, USAGE_SESSION_STRIDE);
  for (let index = 0; index < flatUsageSessions.length; index += USAGE_SESSION_STRIDE) {
    decoder.day(flatUsageSessions[index]);
    for (let at = 1; at < USAGE_SESSION_REFS - 1; at += 1)
      decoder.text(flatUsageSessions[index + at]);
    decoder.thread(flatUsageSessions[index + USAGE_SESSION_REFS - 1]);
    for (let at = USAGE_SESSION_REFS; at < USAGE_SESSION_STRIDE; at += 1)
      decoder.count(flatUsageSessions[index + at]);
  }
  const flatUsageTokens = decoder.tuples(usageTokens, USAGE_TOKEN_STRIDE);
  for (let index = 0; index < flatUsageTokens.length; index += USAGE_TOKEN_STRIDE) {
    decoder.day(flatUsageTokens[index]);
    for (let at = 1; at < USAGE_TOKEN_REFS; at += 1) {
      if (at === 4) decoder.thread(flatUsageTokens[index + at]);
      else decoder.text(flatUsageTokens[index + at]);
    }
    for (let at = USAGE_TOKEN_REFS; at < USAGE_TOKEN_STRIDE; at += 1)
      decoder.count(flatUsageTokens[index + at]);
  }
  const flatUsageTurns = decoder.tuples(usageTurns, USAGE_TURN_STRIDE);
  for (let index = 0; index < flatUsageTurns.length; index += USAGE_TURN_STRIDE) {
    decoder.day(flatUsageTurns[index]);
    for (let at = 1; at < USAGE_TURN_REFS - 1; at += 1) decoder.text(flatUsageTurns[index + at]);
    decoder.thread(flatUsageTurns[index + USAGE_TURN_REFS - 1]);
    for (let at = USAGE_TURN_REFS; at < USAGE_TURN_STRIDE; at += 1)
      decoder.count(flatUsageTurns[index + at]);
  }
  const flatUsageHours = decoder.tuples(usageHours, USAGE_HOUR_STRIDE);
  for (let index = 0; index < flatUsageHours.length; index += USAGE_HOUR_STRIDE) {
    decoder.day(flatUsageHours[index]);
    decoder.text(flatUsageHours[index + 1]);
    decoder.thread(flatUsageHours[index + 2]);
    if (decoder.count(flatUsageHours[index + 3]) > 23) throw new Malformed();
    decoder.count(flatUsageHours[index + 4]);
    decoder.count(flatUsageHours[index + 5]);
  }
  const flatUsageTools = decoder.tuples(usageTools, USAGE_TOOL_STRIDE);
  for (let index = 0; index < flatUsageTools.length; index += USAGE_TOOL_STRIDE) {
    decoder.day(flatUsageTools[index]);
    decoder.text(flatUsageTools[index + 1]);
    decoder.thread(flatUsageTools[index + 2]);
    decoder.text(flatUsageTools[index + 3]);
    decoder.count(flatUsageTools[index + 4]);
  }
  const flatUsageLimits = decoder.tuples(usageLimits, USAGE_LIMIT_STRIDE);
  for (let index = 0; index < flatUsageLimits.length; index += USAGE_LIMIT_STRIDE) {
    decoder.day(flatUsageLimits[index]);
    decoder.text(flatUsageLimits[index + 1]);
    decoder.count(flatUsageLimits[index + 2]);
    decoder.count(flatUsageLimits[index + 3]);
    for (let at = 4; at < USAGE_LIMIT_STRIDE; at += 1) decoder.gauge(flatUsageLimits[index + at]);
  }
  return raw as EncodedTally;
};

/** Adds an encoded tally's counters inside the sum's window to it, building no Tally. */
const addTally = (sum: Accumulator, raw: EncodedTally, strings: readonly string[]): void => {
  const [
    sessions,
    groups,
    versions,
    windows,
    usageSessions,
    usageTokens,
    usageTurns,
    usageHours,
    usageTools,
    usageLimits,
  ] = raw;
  for (let index = 0; index < sessions.length; index += 6) {
    const day = strings[sessions[index]!]!;
    if (!sum.keep(day)) continue;
    const cell = sum.session(day, strings[sessions[index + 1]!]!, strings[sessions[index + 2]!]!);
    cell.sessions += sessions[index + 3]!;
    cell.fixedTokens += sessions[index + 4]!;
    cell.measured += sessions[index + 5]!;
  }
  for (let index = 0; index < groups.length; index += 4) {
    const day = strings[groups[index] as number]!;
    if (!sum.keep(day)) continue;
    const harness = strings[groups[index + 1] as number]!;
    const via = strings[groups[index + 2] as number]!;
    const items = groups[index + 3] as number[];
    for (let at = 0; at < items.length; at += 6) {
      const cell = sum.cell(day, harness, via, strings[items[at]!]!);
      cell.sessions += items[at + 1]!;
      cell.bare += items[at + 2]!;
      cell.chars += items[at + 3]!;
      cell.byModel += items[at + 4]!;
      cell.byUser += items[at + 5]!;
    }
  }
  for (let index = 0; index < versions.length; index += 3) {
    const day = strings[versions[index + 1]!]!;
    if (!sum.keep(day)) continue;
    const harness = strings[versions[index]!]!;
    sum.version({ harness, day, version: strings[versions[index + 2]!]! });
  }
  for (let index = 0; index < windows.length; index += 3) {
    const day = strings[windows[index + 1]!]!;
    if (sum.keep(day))
      sum.window({ harness: strings[windows[index]!]!, day, tokens: windows[index + 2]! });
  }
  for (let index = 0; index < usageSessions.length; index += USAGE_SESSION_STRIDE) {
    const day = strings[usageSessions[index]!]!;
    if (!sum.keep(day)) continue;
    const at = (offset: number) => usageSessions[index + offset]!;
    const cell = sum.usageSession({
      day,
      harness: strings[at(1)]!,
      via: strings[at(2)]!,
      project: strings[at(3)]!,
      thread: strings[at(4)] as Thread,
    });
    cell.sessions += at(5);
    cell.compacted += at(6);
    cell.compactions += at(7);
    cell.manualCompactions += at(8);
  }
  for (let index = 0; index < usageTokens.length; index += USAGE_TOKEN_STRIDE) {
    const day = strings[usageTokens[index]!]!;
    if (!sum.keep(day)) continue;
    const at = (offset: number) => usageTokens[index + offset]!;
    const cell = sum.usageTokens({
      day,
      harness: strings[at(1)]!,
      via: strings[at(2)]!,
      project: strings[at(3)]!,
      thread: strings[at(4)] as Thread,
      model: strings[at(5)]!,
    });
    cell.requests += at(6);
    cell.input += at(7);
    cell.output += at(8);
    cell.reasoning += at(9);
    cell.cacheRead += at(10);
    cell.cacheWrite += at(11);
    cell.cacheWrite5m += at(12);
    cell.cacheWrite1h += at(13);
    cell.cacheRewrite += at(14);
  }
  for (let index = 0; index < usageTurns.length; index += USAGE_TURN_STRIDE) {
    const day = strings[usageTurns[index]!]!;
    if (!sum.keep(day)) continue;
    const at = (offset: number) => usageTurns[index + offset]!;
    const cell = sum.usageTurn({
      day,
      harness: strings[at(1)]!,
      via: strings[at(2)]!,
      project: strings[at(3)]!,
      thread: strings[at(4)] as Thread,
    });
    cell.turns += at(5);
    cell.interrupted += at(6);
    cell.timed += at(7);
    cell.durationMs += at(8);
    cell.toolCalls += at(9);
    cell.withSubagents += at(10);
  }
  for (let index = 0; index < usageHours.length; index += USAGE_HOUR_STRIDE) {
    const day = strings[usageHours[index]!]!;
    if (!sum.keep(day)) continue;
    const at = (offset: number) => usageHours[index + offset]!;
    const cell = sum.usageHour({
      day,
      harness: strings[at(1)]!,
      thread: strings[at(2)] as Thread,
      hour: at(3),
    });
    cell.requests += at(4);
    cell.turns += at(5);
  }
  for (let index = 0; index < usageTools.length; index += USAGE_TOOL_STRIDE) {
    const day = strings[usageTools[index]!]!;
    if (!sum.keep(day)) continue;
    const at = (offset: number) => usageTools[index + offset]!;
    sum.usageTool({
      day,
      harness: strings[at(1)]!,
      thread: strings[at(2)] as Thread,
      tool: strings[at(3)]!,
    }).calls += at(4);
  }
  for (let index = 0; index < usageLimits.length; index += USAGE_LIMIT_STRIDE) {
    const day = strings[usageLimits[index]!]!;
    if (!sum.keep(day)) continue;
    const at = (offset: number) => usageLimits[index + offset]!;
    const usedPercent = ungauge(at(4));
    const readAt = ungauge(at(5));
    const resetsAt = ungauge(at(6));
    const peakUsedPercent = ungauge(at(7));
    sum.usageLimit({
      day,
      harness: strings[at(1)]!,
      windowMinutes: at(2),
      reached: at(3),
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(readAt === undefined ? {} : { at: readAt }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(peakUsedPercent === undefined ? {} : { peakUsedPercent }),
    });
  }
};

/** The Tally of an encoded tally. */
const decodeTally = (raw: EncodedTally, strings: readonly string[]): Tally => {
  const sum = new Accumulator();
  addTally(sum, raw, strings);
  return sum.result();
};

/** `flat`'s tuples of `stride` with their first `refs` moved from one table to another. */
const retableTuples = (
  flat: readonly number[],
  stride: number,
  refs: number,
  from: readonly string[],
  to: StringTable,
): number[] => flat.map((value, index) => (index % stride < refs ? to.ref(from[value]!) : value));

/** An encoded tally moved from one table to another, without decoding it. */
const retableTally = (
  raw: EncodedTally,
  from: readonly string[],
  to: StringTable,
): EncodedTally => {
  const [
    sessions,
    groups,
    versions,
    windows,
    usageSessions,
    usageTokens,
    usageTurns,
    usageHours,
    usageTools,
    usageLimits,
  ] = raw;
  return [
    retableTuples(sessions, 6, 3, from, to),
    groups.map((value, index) =>
      index % 4 === 3
        ? retableTuples(value as number[], 6, 1, from, to)
        : to.ref(from[value as number]!),
    ),
    retableTuples(versions, 3, 3, from, to),
    retableTuples(windows, 3, 2, from, to),
    retableTuples(usageSessions, USAGE_SESSION_STRIDE, USAGE_SESSION_REFS, from, to),
    retableTuples(usageTokens, USAGE_TOKEN_STRIDE, USAGE_TOKEN_REFS, from, to),
    retableTuples(usageTurns, USAGE_TURN_STRIDE, USAGE_TURN_REFS, from, to),
    retableTuples(usageHours, USAGE_HOUR_STRIDE, USAGE_HOUR_REFS, from, to),
    retableTuples(usageTools, USAGE_TOOL_STRIDE, USAGE_TOOL_REFS, from, to),
    retableTuples(usageLimits, USAGE_LIMIT_STRIDE, USAGE_LIMIT_REFS, from, to),
  ];
};

// A CachedFile encodes as
// [size, mtimeMs, ctimeMs, hasTail (0 or 1), offset, guardLength, guardHash, state, tally].

const encodeFile = (file: CachedFile, state: unknown, tally: unknown): unknown[] => {
  const { position } = file;
  return [
    file.size,
    file.mtimeMs,
    file.ctimeMs,
    file.hasTail ? 1 : 0,
    position.offset,
    position.guardLength,
    position.guardHash,
    state,
    tally,
  ];
};

/** An entry as the cache file holds it, its state and tally decoded only when they are read. */
interface OpenedFile {
  readonly file: CachedFile;
  readonly state: unknown;
  readonly tally: EncodedTally;
}

const decodeFile = (raw: unknown, decoder: Decoder): OpenedFile => {
  if (!Array.isArray(raw) || raw.length !== 9) throw new Malformed();
  const [size, mtimeMs, ctimeMs, hasTail, offset, guardLength, guardHash, state, tally] = raw;
  if (typeof mtimeMs !== "number" || typeof ctimeMs !== "number") throw new Malformed();
  if (hasTail !== 0 && hasTail !== 1) throw new Malformed();
  checkValue(state, decoder);
  const encoded = checkTally(tally, decoder);
  let decoded: { value: unknown } | undefined;
  let decodedTally: Tally | undefined;
  const strings = decoder.strings;
  const file: CachedFile = {
    size: decoder.count(size),
    mtimeMs,
    ctimeMs,
    hasTail: hasTail === 1,
    position: {
      offset: decoder.count(offset),
      guardLength: decoder.count(guardLength),
      guardHash: decoder.count(guardHash),
      get state() {
        decoded ??= { value: decodeValue(state, strings) };
        return decoded.value;
      },
    },
    get tally() {
      decodedTally ??= decodeTally(encoded, strings);
      return decodedTally;
    },
  };
  return { file, state, tally: encoded };
};

/** The cache file's document, when it is one this tool saved for this format. */
interface Document {
  readonly salt: string;
  readonly strings: string[];
  readonly files: Record<string, unknown>;
}

const readDocument = async (
  file: string,
  tool: string,
  fingerprint: string,
): Promise<Document | undefined> => {
  try {
    const stored = storedDocument(await readFile(file));
    if (
      isRecord(stored) &&
      stored.tool === tool &&
      stored.format === fingerprint &&
      typeof stored.salt === "string" &&
      Array.isArray(stored.strings) &&
      stored.strings.every((text) => typeof text === "string") &&
      isRecord(stored.files)
    ) {
      return stored as unknown as Document;
    }
  } catch {
    // Missing, unreadable, or nested too deep to parse, which nothing loadsheet saved is.
  }
  return undefined;
};

/**
 * Opens one harness's cache in `dir`. A missing or stale cache (another tool version or
 * transcript format), and one whose contents are not what loadsheet wrote, opens empty, so the
 * run starts cold; a malformed entry opens as a miss.
 */
export const openCache = async (
  dir: string,
  harness: string,
  tool: string,
  format: TranscriptFormat<unknown>,
): Promise<HarnessCache> => {
  const file = join(dir, `${harness.replace(/[^\w.-]/gu, "_")}.json`);
  const fingerprint = formatFingerprint(format);
  const stored = await readDocument(file, tool, fingerprint);
  const entries = new Map(Object.entries(stored?.files ?? {}));
  const decoder = new Decoder(stored?.strings ?? []);
  const salt = stored?.salt;
  // A fresh salt per cold cache, so keys cannot be matched against a guessed path's hash.
  const keySalt = salt ?? randomBytes(16).toString("hex");

  /** Entries decoded by `get`, null when malformed. */
  const opened = new Map<string, CachedFile | null>();
  /** What the cache file holds for each CachedFile `get` returned, to sum and save it as it is. */
  const held = new WeakMap<CachedFile, OpenedFile>();

  const unchanged = (next: ReadonlyMap<string, CachedFile>) => {
    if (salt === undefined || next.size !== entries.size) return false;
    for (const [key, entry] of next) if (opened.get(key) !== entry) return false;
    return true;
  };

  return {
    key: (path) => sha256(`${keySalt}\u0000${path}`),
    get(key) {
      let entry = opened.get(key);
      if (entry === undefined && entries.has(key)) {
        try {
          const decoded = decodeFile(entries.get(key), decoder);
          held.set(decoded.file, decoded);
          entry = decoded.file;
        } catch {
          // Malformed: read the transcript again, as if it were not cached.
          entry = null;
        }
        opened.set(key, entry);
      }
      return entry ?? undefined;
    },
    sum(files, window) {
      const sum = new Accumulator(window);
      for (const entry of files) {
        const encoded = held.get(entry)?.tally;
        if (encoded) addTally(sum, encoded, decoder.strings);
        else sum.tally(entry.tally);
      }
      return sum.result();
    },
    async save(next) {
      if (unchanged(next)) return;
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        const table = new StringTable();
        const files: Record<string, unknown> = {};
        for (const [key, entry] of next) {
          const opened = held.get(entry);
          files[key] = opened
            ? encodeFile(
                entry,
                retable(opened.state, decoder.strings, table),
                retableTally(opened.tally, decoder.strings, table),
              )
            : encodeFile(
                entry,
                encodeValue(entry.position.state, table),
                encodeTally(entry.tally, table),
              );
        }
        const document = JSON.stringify({
          tool,
          format: fingerprint,
          salt: keySalt,
          strings: table.strings,
          files,
        });
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // A directory that was already there keeps its mode, so the names in it could be listed.
        await chmod(dir, 0o700);
        await writeFile(temporary, storedText(document), { mode: 0o600 });
        await rename(temporary, file);
      } catch {
        // The cache only saves time: a run that cannot write it still returns its Scan.
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
};

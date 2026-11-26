// Ported from vite-hub/t3code apps/server/src/usage/usageTranscriptReader.ts
//
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { Transform } from "node:stream";
import * as NodeZlib from "node:zlib";
import type { LineBytes } from "../index.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** When the file or its metadata last changed, which a restored mtime does not hide. */
  readonly ctimeMs: number;
}

/** How to turn a transcript's lines into records. */
export interface LineFormat<State, Entry> {
  /** A line that contains none of these byte strings is skipped before it is decoded. */
  readonly markers: readonly [string, ...string[]];
  /** Plain JSON data; the reader copies it with structuredClone. */
  initial(): State;
  /**
   * True only when `parse` would return no records and leave `state` unchanged. Called before the
   * marker test and before the line is decoded; the line counts as read either way.
   */
  skip?(line: LineBytes, state: State): boolean;
  /** May mutate `state`. A throw fails the whole read (null), so catch malformed lines inside. */
  parse(line: string, state: State): readonly Entry[];
}

/** Resume only if the bytes before `offset` still hash to `guardHash`; a rewritten file is read in full. */
export interface ReadPosition {
  readonly offset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly state: unknown;
}

export interface ReadResult<Entry> {
  /** Records from complete lines. */
  readonly records: Entry[];
  /** Records from an unterminated last line; reread next time and never part of `position`. */
  readonly tail: Entry[];
  readonly position: ReadPosition;
  readonly resumed: boolean;
  /** Complete lines longer than `maxLineBytes`, skipped without being decoded. */
  readonly skippedLines: number;
}

export interface ReadOptions {
  /** Longest line decoded, in bytes without its newline. Default 8 MB. */
  readonly maxLineBytes?: number;
  /** Bytes read from disk at a time. Default 256 KB. */
  readonly chunkBytes?: number;
  /**
   * Read a `.jsonl` file with blocking reads, for a worker thread where nothing else waits on the
   * event loop. A `.jsonl.zst` file is read through its stream either way. Default false.
   */
  readonly sync?: boolean;
}

export const GUARD_LENGTH = 64;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const STAT_CONCURRENCY = 32;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Walks `root` for `.jsonl` and `.jsonl.zst` files modified at or after `sinceMs`, in readdir order. */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<{ files: TranscriptFile[]; failedPaths: number }> {
  const candidates: string[] = [];
  let failedPaths = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      failedPaths += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst")) {
        candidates.push(child);
      }
    }
  };
  await walk(root);

  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  const queue = candidates.entries();
  const statQueued = async (): Promise<void> => {
    for (const [index, path] of queue) {
      try {
        const stats = await NodeFSP.stat(path);
        if (stats.mtimeMs >= sinceMs) {
          found[index] = {
            path,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            ctimeMs: stats.ctimeMs,
          };
        }
      } catch (error) {
        // A file deleted between readdir and stat is gone, not failed.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          failedPaths += 1;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued),
  );
  return { files: found.filter((file) => file !== undefined), failedPaths };
}

/** A zeroed buffer for the guard window before `position.offset`; undefined when it cannot be resumed from. */
function guardWindow(position: ReadPosition): Buffer | undefined {
  const { offset, guardLength } = position;
  if (!Number.isSafeInteger(offset) || offset <= 0) return undefined;
  if (guardLength !== Math.min(GUARD_LENGTH, offset)) return undefined;
  return Buffer.alloc(guardLength);
}

/**
 * Tests raw line bytes for any marker. One marker is searched from the line's end, where Claude
 * Code writes `"entrypoint"`. Several become latin1 strings of their UTF-8 bytes, so one regex
 * over a latin1 view matches bytes exactly, without decoding the line.
 */
export function lineGate(markers: readonly [string, ...string[]]): (line: Buffer) => boolean {
  if (markers.length === 1) {
    const marker = Buffer.from(markers[0]);
    return (line) => line.lastIndexOf(marker) !== -1;
  }
  const pattern = new RegExp(
    markers
      .map((marker) =>
        Buffer.from(marker)
          .toString("latin1")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("|"),
  );
  return (line) => pattern.test(line.toString("latin1"));
}

const gates = new WeakMap<LineFormat<unknown, unknown>, (line: Buffer) => boolean>();
const gateOf = (format: LineFormat<unknown, unknown>): ((line: Buffer) => boolean) => {
  let gate = gates.get(format);
  if (gate === undefined) gates.set(format, (gate = lineGate(format.markers)));
  return gate;
};

/** `includes` needles as bytes, so a search does not encode its string each time. */
const needles = new Map<string, Buffer>();
const MAX_NEEDLES = 256;

/** The line `skip` sees: one object per read, pointed at each line in turn. */
class LineView implements LineBytes {
  bytes: Buffer = Buffer.alloc(0);
  get length(): number {
    return this.bytes.length;
  }
  includes(ascii: string): boolean {
    let needle = needles.get(ascii);
    if (needle === undefined) {
      needle = Buffer.from(ascii);
      if (needles.size < MAX_NEEDLES) needles.set(ascii, needle);
    }
    return this.bytes.includes(needle);
  }
  slice(start: number, end?: number): string {
    return this.bytes.toString("latin1", start, end);
  }
}

/** A read buffer and the buffer a line that spans reads collects in, reused from read to read. */
interface Buffers {
  read: Buffer;
  carry: Buffer;
}
const spareBuffers: Buffers[] = [];
/** A carry grown past this by a long line is let go rather than kept for the next read. */
const KEPT_CARRY_BYTES = 1024 * 1024;
const MIN_CARRY_BYTES = 64 * 1024;

const takeBuffers = (chunkBytes: number): Buffers => {
  const buffers = spareBuffers.pop() ?? { read: Buffer.alloc(0), carry: Buffer.alloc(0) };
  if (buffers.read.length < chunkBytes) buffers.read = Buffer.allocUnsafe(chunkBytes);
  return buffers;
};
const giveBack = (buffers: Buffers): void => {
  if (buffers.carry.length > KEPT_CARRY_BYTES) buffers.carry = Buffer.alloc(0);
  spareBuffers.push(buffers);
};

/**
 * Splits the bytes pushed into it into lines and parses them. Each chunk pushed may be reused by
 * the caller once `push` returns: a line that spans chunks is copied into the carry buffer.
 */
class LineSplitter<State, Entry> {
  readonly records: Entry[] = [];
  skippedLines = 0;
  /** Where the line after the last complete one starts, in the file. */
  offset: number;
  readonly #format: LineFormat<State, Entry>;
  readonly #state: State;
  readonly #gate: (line: Buffer) => boolean;
  readonly #maxLineBytes: number;
  readonly #buffers: Buffers;
  readonly #view = new LineView();
  /** File bytes before the chunk being pushed. */
  #scanned: number;
  /** Bytes of the unfinished line held in the carry buffer. */
  #carried = 0;
  /** The unfinished line is past `maxLineBytes`: it is dropped and counted at its newline. */
  #oversized = false;

  constructor(
    format: LineFormat<State, Entry>,
    state: State,
    start: number,
    maxLineBytes: number,
    buffers: Buffers,
  ) {
    this.#format = format;
    this.#state = state;
    this.#gate = gateOf(format as LineFormat<unknown, unknown>);
    this.#maxLineBytes = maxLineBytes;
    this.#buffers = buffers;
    this.offset = start;
    this.#scanned = start;
  }

  push(chunk: Buffer): void {
    const { length } = chunk;
    let lineStart = 0;
    while (lineStart < length) {
      const newline = chunk.indexOf(NEWLINE, lineStart);
      if (newline === -1) {
        this.#hold(chunk, lineStart, length);
        break;
      }
      if (this.#carried > 0 || this.#oversized) {
        this.#hold(chunk, lineStart, newline);
        if (this.#oversized) this.skippedLines += 1;
        else this.#parse(this.#buffers.carry.subarray(0, this.#carried));
        this.#carried = 0;
        this.#oversized = false;
      } else if (newline - lineStart > this.#maxLineBytes) {
        this.skippedLines += 1;
      } else {
        this.#parse(chunk.subarray(lineStart, newline));
      }
      lineStart = newline + 1;
      this.offset = this.#scanned + lineStart;
    }
    this.#scanned += length;
  }

  /**
   * Parses an unterminated last line into `tail`, against a copy of the state so the state
   * returned covers complete lines only.
   */
  finish(): { tail: Entry[]; state: State } {
    const tail: Entry[] = [];
    if (this.#oversized || this.#carried === 0) return { tail, state: this.#state };
    const text = this.#decode(this.#buffers.carry.subarray(0, this.#carried));
    if (text === undefined) return { tail, state: this.#state };
    const state = structuredClone(this.#state);
    for (const record of this.#format.parse(text, state)) tail.push(record);
    return { tail, state: this.#state };
  }

  /** Copies bytes of an unfinished line into the carry buffer, until it passes the cap. */
  #hold(chunk: Buffer, from: number, to: number): void {
    if (this.#oversized) return;
    const carried = this.#carried + to - from;
    if (carried > this.#maxLineBytes) {
      this.#oversized = true;
      this.#carried = 0;
      return;
    }
    let { carry } = this.#buffers;
    if (carry.length < carried) {
      const size = Math.min(
        this.#maxLineBytes,
        Math.max(carried, 2 * carry.length, MIN_CARRY_BYTES),
      );
      const grown = Buffer.allocUnsafe(size);
      carry.copy(grown, 0, 0, this.#carried);
      this.#buffers.carry = carry = grown;
    }
    chunk.copy(carry, this.#carried, from, to);
    this.#carried = carried;
  }

  /** The line's text without its carriage return, or undefined when `skip` or the gate drops it. */
  #decode(line: Buffer): string | undefined {
    const content =
      line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
    if (this.#format.skip !== undefined) {
      this.#view.bytes = content;
      if (this.#format.skip(this.#view, this.#state)) return undefined;
    }
    if (!this.#gate(content)) return undefined;
    return content.toString("utf8");
  }

  #parse(line: Buffer): void {
    const text = this.#decode(line);
    if (text === undefined) return;
    for (const record of this.#format.parse(text, this.#state)) this.records.push(record);
  }
}

type ZstdDecompress = () => Transform & { readonly bytesWritten: number };

/** `zlib.createZstdDecompress` landed in Node 22.15 and 23.8; older runtimes cannot read `.zst`. */
const createZstdDecompress = (NodeZlib as { createZstdDecompress?: ZstdDecompress })
  .createZstdDecompress;

/** One zstd decoder, and what its events said since: `wake` runs on each of them. */
function openZstdDecoder() {
  const decoder = createZstdDecompress!();
  const state = {
    decoder,
    ended: false,
    failure: undefined as unknown,
    wake: (): void => undefined,
  };
  decoder.on("readable", () => state.wake());
  decoder.on("end", () => {
    state.ended = true;
    state.wake();
  });
  decoder.on("error", (error: unknown) => {
    state.failure ??= error;
    state.wake();
  });
  return state;
}

const ZSTD_MAGIC = 0xfd2fb528;
/** The first of the sixteen magic numbers a skippable frame may start with. */
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

/**
 * Follows a zstd stream's frames and blocks without decoding them, to tell whether the stream
 * stops where a frame does. Node 24's decoder throws on a frame cut short; Node 22's ends as if
 * the frame were whole. The layout is RFC 8878, section 3.1.
 */
function zstdFrameTracker() {
  type Field = "magic" | "descriptor" | "skippable" | "block" | "unknown";
  const bytes = Buffer.alloc(4);
  let field: Field = "magic";
  let want = 4;
  let have = 0;
  /** Bytes to pass over before the field starts. */
  let skip = 0;
  let checksum = 0;
  let frames = 0;
  const expect = (next: Field, size: number, after: number) => {
    field = next;
    want = size;
    have = 0;
    skip = after;
  };
  const read = () => {
    if (field === "magic") {
      const magic = bytes.readUInt32LE(0);
      if (magic === ZSTD_MAGIC) expect("descriptor", 1, 0);
      else if (magic >>> 4 === ZSTD_SKIPPABLE_MAGIC >>> 4) expect("skippable", 4, 0);
      else return expect("unknown", 0, 0);
      frames += 1;
    } else if (field === "skippable") {
      expect("magic", 4, bytes.readUInt32LE(0));
    } else if (field === "descriptor") {
      const descriptor = bytes[0]!;
      const singleSegment = (descriptor >> 5) & 1;
      const contentSize = descriptor >> 6 === 0 ? singleSegment : 1 << (descriptor >> 6);
      const dictionaryId = [0, 1, 2, 4][descriptor & 3]!;
      checksum = (descriptor >> 2) & 1 ? 4 : 0;
      expect("block", 3, (singleSegment ? 0 : 1) + dictionaryId + contentSize);
    } else {
      const header = bytes.readUIntLE(0, 3);
      const type = (header >> 1) & 3;
      if (type === 3) return expect("unknown", 0, 0);
      // A run-length block stores its one byte, whatever size it decodes to.
      const stored = type === 1 ? 1 : header >> 3;
      if (header & 1) expect("magic", 4, stored + checksum);
      else expect("block", 3, stored);
    }
  };
  return {
    write(chunk: Buffer) {
      let at = 0;
      while (at < chunk.length && field !== "unknown") {
        const passed = Math.min(skip, chunk.length - at);
        skip -= passed;
        at += passed;
        const taken = Math.min(want - have, chunk.length - at);
        chunk.copy(bytes, have, at, at + taken);
        have += taken;
        at += taken;
        if (skip === 0 && have === want) read();
      }
    },
    /** At least one frame, and nothing after the last one's end. */
    whole: () => field === "magic" && have === 0 && skip === 0 && frames > 0,
  };
}

/**
 * Decodes every frame of a zstd stream, reading the output as it comes so the decoder never
 * holds more than its own buffer. Node's decoder closes when a frame ends inside a chunk and
 * drops the rest of that chunk, so the rest goes to a new decoder. Throws on a stream that is
 * empty or stops inside a frame.
 */
async function* zstdFrames(input: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const tracker = zstdFrameTracker();
  let current = openZstdDecoder();
  async function* decodedUntil(reached: () => boolean): AsyncGenerator<Buffer> {
    for (;;) {
      if (current.failure !== undefined) throw current.failure;
      const piece = current.decoder.read() as Buffer | null;
      if (piece !== null) yield piece;
      else if (reached()) return;
      else await new Promise<void>((resolve) => (current.wake = resolve));
    }
  }
  try {
    for await (const chunk of input) {
      tracker.write(chunk);
      let rest = chunk;
      while (rest.length > 0) {
        const { decoder } = current;
        const before = decoder.bytesWritten;
        let written = false;
        decoder.write(rest, () => {
          written = true;
          current.wake();
        });
        yield* decodedUntil(() => written);
        const used = decoder.bytesWritten - before;
        if (used === 0) throw new Error("the zstd decoder read nothing");
        rest = rest.subarray(used);
        if (rest.length > 0) {
          yield* decodedUntil(() => current.ended);
          decoder.destroy();
          current = openZstdDecoder();
        }
      }
    }
    if (!tracker.whole()) throw new Error("the zstd stream is empty or stops inside a frame");
    current.decoder.end();
    yield* decodedUntil(() => current.ended);
  } finally {
    current.decoder.destroy();
  }
}

/**
 * Reads a JSONL transcript from `resumeFrom` when its guard still matches, else from the start.
 * `.jsonl.zst` files are read in full each time. Returns null when the file cannot be read.
 */
export async function readTranscript<State, Entry>(
  path: string,
  format: LineFormat<State, Entry>,
  resumeFrom?: ReadPosition,
  options?: ReadOptions,
): Promise<ReadResult<Entry> | null> {
  const maxLineBytes = options?.maxLineBytes ?? MAX_LINE_BYTES;
  const chunkBytes = options?.chunkBytes ?? CHUNK_BYTES;
  if (path.endsWith(".jsonl.zst")) return readCompressed(path, format, maxLineBytes, chunkBytes);
  if (options?.sync) return readPlainSync(path, format, resumeFrom, maxLineBytes, chunkBytes);
  return readPlain(path, format, resumeFrom, maxLineBytes, chunkBytes);
}

/** The state to start from: the resumed position's, or the format's initial one, copied either way. */
const startState = <State>(format: LineFormat<State, unknown>, resumeFrom?: ReadPosition): State =>
  structuredClone(resumeFrom === undefined ? format.initial() : (resumeFrom.state as State));

const plainResult = <State, Entry>(
  lines: LineSplitter<State, Entry>,
  resumed: boolean,
  guardHash: number,
): ReadResult<Entry> => {
  const { tail, state } = lines.finish();
  const { offset } = lines;
  return {
    records: lines.records,
    tail,
    position: { offset, guardLength: Math.min(GUARD_LENGTH, offset), guardHash, state },
    resumed,
    skippedLines: lines.skippedLines,
  };
};

/** Reads with blocking calls into this thread's reused buffers, so nothing yields until it returns. */
function readPlainSync<State, Entry>(
  path: string,
  format: LineFormat<State, Entry>,
  resumeFrom: ReadPosition | undefined,
  maxLineBytes: number,
  chunkBytes: number,
): ReadResult<Entry> | null {
  let fd: number;
  try {
    fd = NodeFS.openSync(path, "r");
  } catch {
    return null;
  }
  const buffers = takeBuffers(chunkBytes);
  try {
    const window = resumeFrom && guardWindow(resumeFrom);
    const resumed =
      window !== undefined &&
      NodeFS.readSync(fd, window, 0, window.length, resumeFrom!.offset - window.length) ===
        window.length &&
      fnv1a(window) === resumeFrom!.guardHash;
    const start = resumed ? resumeFrom!.offset : 0;
    const state = startState(format, resumed ? resumeFrom : undefined);
    const lines = new LineSplitter(format, state, start, maxLineBytes, buffers);
    for (let at = start; ;) {
      const bytesRead = NodeFS.readSync(fd, buffers.read, 0, chunkBytes, at);
      if (bytesRead === 0) break;
      at += bytesRead;
      lines.push(buffers.read.subarray(0, bytesRead));
    }
    const guard = Buffer.alloc(Math.min(GUARD_LENGTH, lines.offset));
    if (guard.length > 0) NodeFS.readSync(fd, guard, 0, guard.length, lines.offset - guard.length);
    return plainResult(lines, resumed, guard.length > 0 ? fnv1a(guard) : 0);
  } catch {
    return null;
  } finally {
    giveBack(buffers);
    NodeFS.closeSync(fd);
  }
}

async function readPlain<State, Entry>(
  path: string,
  format: LineFormat<State, Entry>,
  resumeFrom: ReadPosition | undefined,
  maxLineBytes: number,
  chunkBytes: number,
): Promise<ReadResult<Entry> | null> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(path, "r");
  } catch {
    return null;
  }
  const buffers = takeBuffers(chunkBytes);
  try {
    const window = resumeFrom && guardWindow(resumeFrom);
    const resumed =
      window !== undefined &&
      (await handle.read(window, 0, window.length, resumeFrom!.offset - window.length))
        .bytesRead === window.length &&
      fnv1a(window) === resumeFrom!.guardHash;
    const start = resumed ? resumeFrom!.offset : 0;
    const state = startState(format, resumed ? resumeFrom : undefined);
    const lines = new LineSplitter(format, state, start, maxLineBytes, buffers);
    for (let at = start; ;) {
      const { bytesRead } = await handle.read(buffers.read, 0, chunkBytes, at);
      if (bytesRead === 0) break;
      at += bytesRead;
      lines.push(buffers.read.subarray(0, bytesRead));
    }
    const guard = Buffer.alloc(Math.min(GUARD_LENGTH, lines.offset));
    if (guard.length > 0) await handle.read(guard, 0, guard.length, lines.offset - guard.length);
    return plainResult(lines, resumed, guard.length > 0 ? fnv1a(guard) : 0);
  } catch {
    return null;
  } finally {
    giveBack(buffers);
    await handle.close().catch(() => undefined);
  }
}

/** Reads a `.jsonl.zst` file in full through its decoder; its position is never resumed from. */
async function readCompressed<State, Entry>(
  path: string,
  format: LineFormat<State, Entry>,
  maxLineBytes: number,
  chunkBytes: number,
): Promise<ReadResult<Entry> | null> {
  if (createZstdDecompress === undefined) return null;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(path, "r");
  } catch {
    return null;
  }
  const buffers = takeBuffers(0);
  try {
    const lines = new LineSplitter(format, startState(format), 0, maxLineBytes, buffers);
    const input = handle.createReadStream({ autoClose: false, highWaterMark: chunkBytes });
    for await (const chunk of zstdFrames(input)) lines.push(chunk);
    const { tail, state } = lines.finish();
    return {
      records: lines.records,
      tail,
      position: { offset: 0, guardLength: 0, guardHash: 0, state },
      resumed: false,
      skippedLines: lines.skippedLines,
    };
  } catch {
    return null;
  } finally {
    giveBack(buffers);
    await handle.close().catch(() => undefined);
  }
}

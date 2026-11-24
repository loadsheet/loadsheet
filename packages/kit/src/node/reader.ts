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

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { Transform } from "node:stream";
import * as NodeZlib from "node:zlib";

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

async function guardMatches(handle: NodeFSP.FileHandle, position: ReadPosition): Promise<boolean> {
  const { offset, guardLength, guardHash } = position;
  if (!Number.isSafeInteger(offset) || offset <= 0) return false;
  if (guardLength !== Math.min(GUARD_LENGTH, offset)) return false;
  const window = Buffer.alloc(guardLength);
  const { bytesRead } = await handle.read(window, 0, guardLength, offset - guardLength);
  return bytesRead === guardLength && fnv1a(window) === guardHash;
}

/**
 * Tests raw line bytes for any marker. Markers become latin1 strings of their UTF-8 bytes,
 * so one regex over a latin1 view matches bytes exactly, without decoding the line.
 */
export function lineGate(markers: readonly [string, ...string[]]): (line: Buffer) => boolean {
  if (markers.length === 1) {
    const marker = Buffer.from(markers[0]);
    return (line) => line.includes(marker);
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
  const compressed = path.endsWith(".jsonl.zst");
  if (compressed && createZstdDecompress === undefined) return null;

  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(path, "r");
  } catch {
    return null;
  }

  try {
    let state: State;
    let start = 0;
    let resumed = false;
    if (!compressed && resumeFrom !== undefined && (await guardMatches(handle, resumeFrom))) {
      state = structuredClone(resumeFrom.state) as State;
      start = resumeFrom.offset;
      resumed = true;
    } else {
      state = structuredClone(format.initial());
    }

    const passesGate = lineGate(format.markers);
    const parseLine = (line: Buffer, lineState: State, out: Entry[]): void => {
      if (!passesGate(line)) return;
      const content =
        line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
      for (const record of format.parse(content.toString("utf8"), lineState)) out.push(record);
    };

    const records: Entry[] = [];
    let skippedLines = 0;
    // A line that spans chunks collects here until its newline; past the cap it is dropped and only counted.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let oversized = false;
    let offset = start;
    let scanned = start;

    const input = handle.createReadStream({
      start,
      autoClose: false,
      highWaterMark: chunkBytes,
    });
    const stream: AsyncIterable<Buffer> = compressed ? zstdFrames(input) : input;

    for await (const chunk of stream) {
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newline = chunk.indexOf(NEWLINE, lineStart);
        const end = newline === -1 ? chunk.length : newline;
        if (!oversized) {
          if (pendingBytes + end - lineStart > maxLineBytes) {
            oversized = true;
            pending = [];
            pendingBytes = 0;
          } else if (newline === -1 || pendingBytes > 0) {
            pending.push(chunk.subarray(lineStart, end));
            pendingBytes += end - lineStart;
          }
        }
        if (newline === -1) break;
        if (oversized) skippedLines += 1;
        else if (pendingBytes > 0) parseLine(Buffer.concat(pending, pendingBytes), state, records);
        else parseLine(chunk.subarray(lineStart, newline), state, records);
        pending = [];
        pendingBytes = 0;
        oversized = false;
        lineStart = newline + 1;
        offset = scanned + lineStart;
      }
      scanned += chunk.length;
    }

    // The tail parses against a copy so `position.state` covers committed lines only.
    const committedState = structuredClone(state);
    const tail: Entry[] = [];
    if (!oversized && pendingBytes > 0) {
      parseLine(Buffer.concat(pending, pendingBytes), structuredClone(state), tail);
    }

    if (compressed) {
      return {
        records,
        tail,
        position: { offset: 0, guardLength: 0, guardHash: 0, state: committedState },
        resumed: false,
        skippedLines,
      };
    }
    const guardLength = Math.min(GUARD_LENGTH, offset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, offset - guardLength);
      guardHash = fnv1a(window);
    }
    return {
      records,
      tail,
      position: { offset, guardLength, guardHash, state: committedState },
      resumed,
      skippedLines,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

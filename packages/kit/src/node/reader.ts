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
          found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
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

/** One zstd frame's decoder: what it decoded so far, and whether it finished or failed. */
function openZstdFrame() {
  const decoder = createZstdDecompress!();
  const decoded: Buffer[] = [];
  decoder.on("data", (chunk: Buffer) => decoded.push(chunk));
  const failed = new Promise<never>((_, reject) => decoder.once("error", reject));
  const done = Promise.race([new Promise((resolve) => decoder.once("end", resolve)), failed]);
  failed.catch(() => undefined);
  done.catch(() => undefined);
  return { decoder, decoded, failed, done };
}

/**
 * Decodes every frame of a zstd stream. Node's decoder closes when a frame ends inside a chunk
 * and drops the rest of that chunk, so the rest goes to a new decoder.
 */
async function* zstdFrames(input: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let frame = openZstdFrame();
  try {
    for await (const chunk of input) {
      let rest = chunk;
      while (rest.length > 0) {
        const { decoder } = frame;
        const before = decoder.bytesWritten;
        const written = new Promise<void>((resolve) => decoder.write(rest, () => resolve()));
        await Promise.race([written, frame.failed]);
        const used = decoder.bytesWritten - before;
        if (used === 0) throw new Error("the zstd decoder read nothing");
        rest = rest.subarray(used);
        if (rest.length > 0) await frame.done;
        yield* frame.decoded.splice(0);
        if (rest.length > 0) frame = openZstdFrame();
      }
    }
    frame.decoder.end();
    await frame.done;
    yield* frame.decoded.splice(0);
  } finally {
    frame.decoder.destroy();
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

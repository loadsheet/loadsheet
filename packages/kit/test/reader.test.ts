import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  listTranscriptFiles,
  readTranscript,
  type LineFormat,
  type ReadOptions,
  type ReadPosition,
} from "../src/node/index.ts";

interface Entry {
  n: number;
  text: string;
  seq: number;
}

// A running counter in State, so a resume that loses or doubles state shows in `seq`.
const counting: LineFormat<{ count: number }, Entry> = {
  markers: ['"k":"rec"', '"k":"rèc"'],
  initial: () => ({ count: 0 }),
  parse(line, state) {
    let value: { n?: unknown; text?: unknown };
    try {
      value = JSON.parse(line);
    } catch {
      return [];
    }
    if (typeof value.n !== "number" || typeof value.text !== "string") return [];
    state.count += 1;
    return [{ n: value.n, text: value.text, seq: state.count }];
  },
};

// mulberry32: seeded, so a failing split reproduces from the seed in the test name.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "b", " ", "é", "日本", "🙂", '"', "\\", "\t", "ß"];

function generate(seed: number, lines: number, longLine: number): Buffer {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const text = (length: number) => Array.from({ length }, () => pick(ALPHABET)).join("");
  let out = "";
  for (let n = 0; n < lines; n += 1) {
    const roll = next();
    const line =
      roll < 0.2
        ? JSON.stringify({ k: "noise", text: text(8) })
        : roll < 0.3
          ? JSON.stringify({ k: "rèc", n, text: text(longLine) })
          : JSON.stringify({ k: "rec", n, text: text(1 + Math.floor(next() * 12)) });
    const last = n === lines - 1;
    out += line + (last && next() < 0.5 ? "" : pick(["\n", "\r\n"]));
  }
  return Buffer.from(out);
}

let dir: string;
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-reader-"));
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

async function read(
  path: string,
  resumeFrom?: ReadPosition,
  options?: ReadOptions,
): Promise<NonNullable<Awaited<ReturnType<typeof readTranscript<{ count: number }, Entry>>>>> {
  const result = await readTranscript(path, counting, resumeFrom, options);
  expect(result).not.toBeNull();
  return result!;
}

// Reads `content` up to each split in turn, resuming from the previous position each time,
// and checks the pieces add up to one read of the whole.
async function expectResumeMatchesFull(content: Buffer, splits: number[], options: ReadOptions) {
  const path = NodePath.join(dir, "t.jsonl");
  await NodeFSP.writeFile(path, content);
  const full = await read(path, undefined, options);

  await NodeFSP.writeFile(path, "");
  let written = 0;
  let position: ReadPosition | undefined;
  const records: Entry[] = [];
  let skipped = 0;
  let last = full;
  for (const split of [...splits, content.length]) {
    await NodeFSP.appendFile(path, content.subarray(written, split));
    written = split;
    // A cache round-trips the position through JSON.
    const resumeFrom = position && (JSON.parse(JSON.stringify(position)) as ReadPosition);
    last = await read(path, resumeFrom, options);
    if (position !== undefined && position.offset > 0) expect(last.resumed).toBe(true);
    records.push(...last.records);
    skipped += last.skippedLines;
    position = last.position;
  }
  expect(records).toEqual(full.records);
  expect(last.tail).toEqual(full.tail);
  expect(last.position).toEqual(full.position);
  expect(skipped).toBe(full.skippedLines);
}

describe("resume property", () => {
  it.each([1, 2, 3])(
    "every split of a small transcript, seed %i",
    async (seed) => {
      const content = generate(seed, 8, 40);
      const options = { chunkBytes: 16, maxLineBytes: 90 };
      for (let split = 0; split <= content.length; split += 1) {
        await expectResumeMatchesFull(content, [split], options);
      }
    },
    60_000,
  );

  it.each([11, 12, 13])(
    "random splits of a larger transcript, seed %i",
    async (seed) => {
      const content = generate(seed, 600, 700);
      const next = random(seed * 7919);
      const options = { chunkBytes: 1024, maxLineBytes: 1500 };
      for (let round = 0; round < 25; round += 1) {
        const splits = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
          Math.floor(next() * content.length),
        ).sort((a, b) => a - b);
        await expectResumeMatchesFull(content, splits, options);
      }
    },
    60_000,
  );

  it("the generated transcripts exercise what the property claims to cover", () => {
    const small = generate(1, 8, 40).toString("utf8").split("\n");
    expect(Math.max(...small.map((line) => Buffer.byteLength(line)))).toBeGreaterThan(90);
    const content = generate(11, 600, 700);
    const text = content.toString("utf8");
    expect(text).toContain("\r\n");
    expect(text).toContain('"k":"noise"');
    expect(text).toMatch(/[日本🙂é]/u);
    const longest = Math.max(...text.split("\n").map((line) => Buffer.byteLength(line)));
    expect(longest).toBeGreaterThan(1500);
  });
});

describe("readTranscript", () => {
  const line = (n: number, text = "x") => JSON.stringify({ k: "rec", n, text }) + "\n";

  it("reads a file rewritten before the offset in full", async () => {
    const path = NodePath.join(dir, "t.jsonl");
    await NodeFSP.writeFile(path, line(1) + line(2));
    const first = await read(path);
    await NodeFSP.writeFile(path, line(1, "y") + line(2) + line(3));
    const second = await read(path, first.position);
    expect(second.resumed).toBe(false);
    expect(second.records.map((entry) => [entry.n, entry.seq])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("reads a truncated file in full", async () => {
    const path = NodePath.join(dir, "t.jsonl");
    await NodeFSP.writeFile(path, line(1) + line(2));
    const first = await read(path);
    await NodeFSP.writeFile(path, line(1));
    const second = await read(path, first.position);
    expect(second.resumed).toBe(false);
    expect(second.records.map((entry) => entry.n)).toEqual([1]);
  });

  it("resumes an appended file and parses only the new lines", async () => {
    const path = NodePath.join(dir, "t.jsonl");
    await NodeFSP.writeFile(path, line(1) + line(2));
    const first = await read(path);
    await NodeFSP.appendFile(path, line(3));
    const second = await read(path, first.position);
    expect(second.resumed).toBe(true);
    expect(second.records).toEqual([{ n: 3, text: "x", seq: 3 }]);
  });

  it("reports an unterminated line in tail and counts it once after it is completed", async () => {
    const path = NodePath.join(dir, "t.jsonl");
    const third = Buffer.from(line(3, "工具").trimEnd());
    const split = third.indexOf(Buffer.from("工")) + 1;
    await NodeFSP.writeFile(path, Buffer.concat([Buffer.from(line(1)), third.subarray(0, split)]));
    const partial = await read(path);
    expect(partial.records.map((entry) => entry.n)).toEqual([1]);
    expect(partial.tail).toEqual([]);
    expect(partial.position.offset).toBe(Buffer.byteLength(line(1)));

    await NodeFSP.appendFile(path, third.subarray(split));
    const whole = await read(path, partial.position);
    expect(whole.records).toEqual([]);
    expect(whole.tail).toEqual([{ n: 3, text: "工具", seq: 2 }]);
    expect(whole.position).toEqual(partial.position);

    await NodeFSP.appendFile(path, "\r\n" + line(4));
    const done = await read(path, whole.position);
    expect(done.records.map((entry) => [entry.n, entry.seq])).toEqual([
      [3, 2],
      [4, 3],
    ]);
    expect(done.tail).toEqual([]);
    expect(done.position.offset).toBe((await NodeFSP.stat(path)).size);
  });

  it("skips and counts an oversized line without corrupting its neighbours", async () => {
    const path = NodePath.join(dir, "t.jsonl");
    const big = line(2, "z".repeat(5000));
    await NodeFSP.writeFile(path, line(1) + big + line(3) + big.trimEnd());
    const options = { maxLineBytes: 1000, chunkBytes: 64 };
    const result = await read(path, undefined, options);
    expect(result.records.map((entry) => [entry.n, entry.seq])).toEqual([
      [1, 1],
      [3, 2],
    ]);
    expect(result.skippedLines).toBe(1);
    expect(result.tail).toEqual([]);

    await NodeFSP.appendFile(path, "\n" + line(4));
    const resumed = await read(path, result.position, options);
    expect(resumed.skippedLines).toBe(1);
    expect(resumed.records.map((entry) => [entry.n, entry.seq])).toEqual([[4, 3]]);
  });

  it("skips lines without a marker before decoding them", async () => {
    const path = NodePath.join(dir, "t.jsonl");
    await NodeFSP.writeFile(path, '{"k":"other","n":1,"text":"x"}\nnot json\n' + line(2));
    const seen: string[] = [];
    const format: LineFormat<{ count: number }, Entry> = {
      ...counting,
      parse(raw, state) {
        seen.push(raw);
        return counting.parse(raw, state);
      },
    };
    const result = await readTranscript(path, format);
    expect(seen).toEqual([line(2).trimEnd()]);
    expect(result?.records.map((entry) => entry.n)).toEqual([2]);
  });

  it("does not share state with format.initial() or a saved position", async () => {
    const path = NodePath.join(dir, "t.jsonl");
    const initial = { count: 0 };
    const format = { ...counting, initial: () => initial };
    await NodeFSP.writeFile(path, line(1));
    const first = await readTranscript(path, format);
    expect(initial).toEqual({ count: 0 });
    const saved = first!.position.state;
    await NodeFSP.appendFile(path, line(2));
    await readTranscript(path, format, first!.position);
    expect(saved).toEqual({ count: 1 });
  });

  it.runIf(typeof NodeZlib.zstdCompressSync === "function")(
    "reads a .jsonl.zst file in full each time",
    async () => {
      const plainPath = NodePath.join(dir, "t.jsonl");
      const path = NodePath.join(dir, "t.jsonl.zst");
      const content = line(1) + line(2, "日本") + line(3).trimEnd();
      await NodeFSP.writeFile(plainPath, content);
      await NodeFSP.writeFile(path, NodeZlib.zstdCompressSync(content));
      const plain = await read(plainPath);
      const first = await read(path);
      expect(first.records).toEqual(plain.records);
      expect(first.tail).toEqual(plain.tail);
      expect(first.resumed).toBe(false);
      expect(first.position.offset).toBe(0);

      await NodeFSP.writeFile(path, NodeZlib.zstdCompressSync(content + "\n" + line(4)));
      const second = await read(path, plain.position);
      expect(second.resumed).toBe(false);
      expect(second.records.map((entry) => entry.n)).toEqual([1, 2, 3, 4]);
    },
  );

  it.runIf(typeof NodeZlib.zstdCompressSync === "function")(
    "reads every frame of a .jsonl.zst file, wherever a chunk ends",
    async () => {
      const path = NodePath.join(dir, "t.jsonl.zst");
      const frames = [line(1) + line(2), line(3, "日本"), line(4) + line(5)];
      const file = Buffer.concat(frames.map((frame) => NodeZlib.zstdCompressSync(frame)));
      await NodeFSP.writeFile(path, file);
      for (const chunkBytes of [file.length, 7, 1]) {
        const result = await readTranscript(path, counting, undefined, { chunkBytes });
        expect(result!.records.map((entry) => entry.n)).toEqual([1, 2, 3, 4, 5]);
      }

      for (const broken of [file.subarray(0, -3), Buffer.concat([file, Buffer.from("junk")])]) {
        await NodeFSP.writeFile(path, broken);
        expect(await readTranscript(path, counting)).toBeNull();
        expect(await readTranscript(path, counting, undefined, { chunkBytes: 7 })).toBeNull();
      }
    },
  );

  it("returns null for a corrupt .zst file", async () => {
    const path = NodePath.join(dir, "t.jsonl.zst");
    await NodeFSP.writeFile(path, "not a zstd frame");
    expect(await readTranscript(path, counting)).toBeNull();
  });

  it("returns null for a missing file", async () => {
    expect(await readTranscript(NodePath.join(dir, "missing.jsonl"), counting)).toBeNull();
  });
});

describe("listTranscriptFiles", () => {
  it("finds nested .jsonl and .jsonl.zst files modified since the cutoff", async () => {
    const nested = NodePath.join(dir, "nested");
    await NodeFSP.mkdir(nested);
    const plain = NodePath.join(dir, "a.jsonl");
    const compressed = NodePath.join(nested, "b.jsonl.zst");
    const old = NodePath.join(nested, "old.jsonl");
    for (const path of [plain, compressed, old]) await NodeFSP.writeFile(path, "{}\n");
    await NodeFSP.writeFile(NodePath.join(nested, "c.zst"), "");
    await NodeFSP.writeFile(NodePath.join(nested, "d.jsonl.tmp"), "");
    await NodeFSP.utimes(old, 1, 1);

    const listed = await listTranscriptFiles(dir, Date.parse("2026-01-01T00:00:00Z"));
    expect(listed.files.map((file) => file.path).sort()).toEqual([plain, compressed].sort());
    expect(listed.files[0]?.size).toBe(3);
    expect(listed.failedPaths).toBe(0);
  });

  it("counts a missing root as failed", async () => {
    expect((await listTranscriptFiles(NodePath.join(dir, "none"), 0)).failedPaths).toBe(1);
  });
});

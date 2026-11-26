import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineHarness, type Harness } from "../src/index.ts";
import {
  MIN_POOLED_BYTES,
  openTranscriptPool,
  scanMachine,
  workersFor,
  type ScanProgress,
} from "../src/node/index.ts";
import { countingFormat } from "./workers/format.ts";

const worker = new URL("./workers/worker.ts", import.meta.url);
const NOW = new Date("2026-11-24T15:00:00.000Z");

const harness = (id: string): Harness =>
  defineHarness({
    id,
    signals: {
      listing: "none",
      modelUse: "exact",
      userUse: "none",
      instructions: "none",
      mcp: "none",
      tokens: "none",
    },
    inventory: async () => [],
    machine: {
      home: (place) => `${place.home}/.counting`,
      sources: () => [],
      roots: (place) => [`${place.home}/.counting/sessions`],
      inventory: async () => [],
      transcripts: countingFormat,
    },
  }) as Harness;

let home: string;

beforeEach(async () => {
  home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-workers-"));
  const dir = `${home}/.counting/sessions`;
  await NodeFSP.mkdir(dir, { recursive: true });
  // More files than the pool's minimum, and one cut off mid-line, which is read again next run.
  for (let index = 0; index < 20; index += 1) {
    const day = `2026-11-${String(18 + (index % 7)).padStart(2, "0")}`;
    const uses = Array.from({ length: index + 1 }, (_, n) => ({
      t: "use",
      item: `skill:s${n % 3}`,
    }));
    const lines = [{ t: "start", day }, ...uses].map((line) => JSON.stringify(line));
    const cut = index === 0 ? '{"t":"use","item":"skill:s9"' : "";
    await NodeFSP.writeFile(`${dir}/${index}.jsonl`, `${lines.join("\n")}\n${cut}`);
  }
});

afterEach(async () => {
  await NodeFSP.rm(home, { recursive: true, force: true });
});

const scan = (options: {
  worker?: URL;
  workers?: number;
  cacheDir: string | false;
  id?: string;
  onProgress?: (progress: ScanProgress) => void;
}) =>
  scanMachine({
    harnesses: [harness(options.id ?? "counting")],
    days: 7,
    tool: "loadsheet@0.0.0-test",
    machine: "test-machine",
    now: NOW,
    place: { home, env: {} },
    cacheDir: options.cacheDir,
    // One file read at a time on this thread, so reads end in the order they start.
    concurrency: 1,
    ...(options.worker
      ? { worker: options.worker, workers: options.workers ?? 3, minPooledBytes: 0 }
      : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

const sizes = async () => {
  const dir = `${home}/.counting/sessions`;
  const names = await NodeFSP.readdir(dir);
  return Promise.all(names.map(async (name) => (await NodeFSP.stat(`${dir}/${name}`)).size));
};

describe("scanMachine on worker threads", () => {
  it("gives the Scan this thread gives, and a cache this thread reads", async () => {
    const inline = await scan({ cacheDir: false });
    expect(inline.sessions.length).toBeGreaterThan(0);
    const cacheDir = NodePath.join(home, "cache");
    expect(await scan({ worker, cacheDir })).toEqual(inline);
    expect(await scan({ cacheDir })).toEqual(inline);
  });

  it("fails the scan when a worker has no format for the harness", async () => {
    await expect(scan({ worker, cacheDir: false, id: "unknown" })).rejects.toThrow(
      "No transcript format for unknown",
    );
  });
});

describe("scheduling reads", () => {
  // One thread holds two reads at once and ends them in the order it got them.
  it.each([
    ["on this thread", {}],
    ["on one worker thread", { worker, workers: 1 }],
  ])("reads the largest files first, %s, and counts progress in bytes", async (_, threads) => {
    const seen: ScanProgress[] = [];
    await scan({ ...threads, cacheDir: false, onProgress: (progress) => seen.push(progress) });
    const all = await sizes();
    const total = all.reduce((sum, size) => sum + size, 0);
    expect(seen[0]).toEqual({ done: 0, total: 20, doneBytes: 0, totalBytes: total });
    expect(seen.at(-1)).toEqual({ done: 20, total: 20, doneBytes: total, totalBytes: total });
    const read = seen
      .slice(1)
      .map((progress, index) => progress.doneBytes - seen[index]!.doneBytes);
    expect(read).toEqual(all.sort((a, b) => b - a));
  });

  it("counts the bytes the cache holds as read at once", async () => {
    const dir = `${home}/.counting/sessions`;
    // Complete lines only, so every file is cached.
    await NodeFSP.writeFile(`${dir}/0.jsonl`, '{"t":"start","day":"2026-11-18"}\n');
    const cacheDir = NodePath.join(home, "cache");
    await scan({ cacheDir });
    const appended = '{"t":"use","item":"skill:s1"}\n';
    await NodeFSP.appendFile(`${dir}/5.jsonl`, appended);
    const total = (await sizes()).reduce((sum, size) => sum + size, 0);
    const seen: ScanProgress[] = [];
    await scan({ cacheDir, onProgress: (progress) => seen.push(progress) });
    expect(seen).toEqual([
      { done: 19, total: 20, doneBytes: total - appended.length, totalBytes: total },
      { done: 20, total: 20, doneBytes: total, totalBytes: total },
    ]);
  });

  it("starts reads queued before a thread largest first, and ties in the order they came", async () => {
    const pool = openTranscriptPool(worker);
    const dir = `${home}/.counting/sessions`;
    const ended: string[] = [];
    const reads = [3, 7, 1, 7, 5].map((bytes, index) =>
      pool
        .read({ harness: "counting", path: `${dir}/${index}.jsonl` }, bytes)
        .then(() => ended.push(`${index}`)),
    );
    expect(pool.size).toBe(0);
    pool.grow(1);
    try {
      await Promise.all(reads);
    } finally {
      await pool.close();
    }
    expect(ended).toEqual(["1", "3", "4", "0", "2"]);
  });

  it("starts no worker thread for little to read, and more as the bytes grow, up to the most allowed", () => {
    const MB = 1024 * 1024;
    expect(workersFor(2_000, MIN_POOLED_BYTES - 1, 15)).toBe(0);
    expect(workersFor(2_000, MIN_POOLED_BYTES, 15)).toBe(2);
    expect(workersFor(30, 100 * MB, 15)).toBe(3);
    expect(workersFor(2_000, 1350 * MB, 15)).toBe(7);
    expect(workersFor(2_000, 8 * 1024 * MB, 15)).toBe(11);
    expect(workersFor(2_000, 1024 * 1024 * MB, 15)).toBe(15);
    expect(workersFor(2, 8 * 1024 * MB, 15)).toBe(2);
    expect(workersFor(2_000, 8 * 1024 * MB, 0)).toBe(0);
    expect(workersFor(3, 100, 15, 0)).toBe(1);
  });
});

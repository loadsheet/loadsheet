import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineHarness, type Harness } from "../src/index.ts";
import { scanMachine } from "../src/node/index.ts";
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

const scan = (options: { worker?: URL; cacheDir: string | false; id?: string }) =>
  scanMachine({
    harnesses: [harness(options.id ?? "counting")],
    days: 7,
    tool: "loadsheet@0.0.0-test",
    machine: "test-machine",
    now: NOW,
    place: { home, env: {} },
    cacheDir: options.cacheDir,
    ...(options.worker ? { worker: options.worker, workers: 3 } : {}),
  });

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

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Fact, TranscriptFormat } from "../src/index.ts";
import { openCache, type CachedFile } from "../src/node/cache.ts";

const format: TranscriptFormat<unknown> = {
  markers: ['"t":"'],
  initial: () => ({ listed: {} }),
  parse: (): Fact[] => [],
};

const TOOL = "loadsheet@0.0.0-test";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-cache-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const open = () => openCache(dir, "fake", TOOL, format);

const cell = (day: string, via: string, item: string, n: number) => ({
  day,
  harness: "fake",
  via,
  item,
  sessions: n,
  bare: n % 2,
  chars: n * 31,
  byModel: n * 2,
  byUser: 0,
});

/** A cached file with cells in several groups and a state that uses every JSON type. */
const cachedFile = (seed: number): CachedFile => ({
  size: 1000 + seed,
  mtimeMs: 1763980000000.5 + seed,
  hasTail: seed % 2 === 1,
  position: {
    offset: 900 + seed,
    guardLength: 64,
    guardHash: 4294967295 - seed,
    state: {
      day: "2026-11-22",
      started: true,
      tokens: false,
      nothing: null,
      listed: { "skill:alpha": true, "mcp:files": true, "12": true },
      mcp: { files: 11, other: -2.5, big: 1e21 },
      order: ["skill:alpha", 3, [], {}, [null, false, ["deep", { x: "skill:alpha" }]]],
      empty: {},
      ...JSON.parse('{"__proto__": {"polluted": true}}'),
      seed,
    },
  },
  tally: {
    sessions: [
      {
        day: "2026-11-22",
        harness: "fake",
        via: "cli",
        sessions: 1,
        fixedTokens: 1200,
        measured: 1,
      },
      {
        day: "2026-11-23",
        harness: "fake",
        via: "app",
        sessions: seed,
        fixedTokens: 0,
        measured: 0,
      },
    ],
    cells: [
      cell("2026-11-22", "cli", "mcp:files", 1),
      cell("2026-11-22", "cli", "skill:alpha", 2 + seed),
      cell("2026-11-23", "app", "skill:alpha", 3),
      cell("2026-11-23", "cli", "skill:alpha", 4),
    ],
    versions: [{ harness: "fake", day: "2026-11-22", version: "1.2.0" }],
  },
});

const cacheFile = () => NodePath.join(dir, "fake.json");

const readStored = async () =>
  JSON.parse(await NodeFSP.readFile(cacheFile(), "utf8")) as {
    strings: string[];
    files: Record<string, unknown[]>;
  };

describe("the scan cache file", () => {
  it("gives back the CachedFiles it saved, state included", async () => {
    const first = await open();
    const one = cachedFile(1);
    await first.save(new Map([["one", one]]));

    // An entry kept from the file is saved again beside a new one.
    const second = await open();
    const kept = second.get("one")!;
    expect(kept).toEqual(one);
    expect(Object.getPrototypeOf(kept.position.state)).toBe(Object.prototype);
    const two = cachedFile(2);
    await second.save(
      new Map([
        ["one", kept],
        ["two", two],
      ]),
    );

    const third = await open();
    expect(third.get("one")).toEqual(one);
    expect(third.get("two")).toEqual(two);
    expect(third.get("three")).toBeUndefined();
    // Each name is stored once.
    const stored = await readStored();
    expect(new Set(stored.strings).size).toBe(stored.strings.length);
    expect(stored.strings.filter((text) => text === "skill:alpha")).toHaveLength(1);
  });

  it("does not rewrite the file when every entry is the one it opened", async () => {
    await (
      await open()
    ).save(
      new Map([
        ["one", cachedFile(1)],
        ["two", cachedFile(2)],
      ]),
    );
    const before = await NodeFSP.stat(cacheFile());

    const cache = await open();
    await cache.save(
      new Map([
        ["one", cache.get("one")!],
        ["two", cache.get("two")!],
      ]),
    );
    const after = await NodeFSP.stat(cacheFile());
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);

    // Dropping an entry rewrites it.
    const dropped = await open();
    await dropped.save(new Map([["one", dropped.get("one")!]]));
    expect((await NodeFSP.stat(cacheFile())).ino).not.toBe(before.ino);
    expect((await open()).get("two")).toBeUndefined();
  });

  it("opens a damaged entry as a miss and keeps the others", async () => {
    const damages: Array<(entry: unknown[], strings: string[]) => void> = [
      (entry) => entry.pop(),
      (entry) => (entry[0] = -1),
      (entry) => (entry[2] = true),
      (entry, strings) => ((entry[7] as unknown[][])[1]![0] = strings.length),
      (entry) => (((entry[7] as unknown[][])[1]![3] as unknown[])[1] = 1.5),
      (entry) => (entry[7] as unknown[][])[0]!.push(1),
      (entry) => (entry[6] = [0]),
      (entry) => (entry[6] = { a: [], b: [] }),
      (entry) => (entry[6] = "NaN"),
      (entry) => (entry[6] = { a: ["01"] }),
      (entry) => (entry[7] = "tally"),
      // A day that is a string but not YYYY-MM-DD, in sessions, a cell group and versions.
      (entry, strings) => ((entry[7] as unknown[][])[0]![0] = strings.indexOf("fake")),
      (entry, strings) => ((entry[7] as unknown[][])[1]![0] = strings.indexOf("cli")),
      (entry, strings) => ((entry[7] as unknown[][])[2]![1] = strings.indexOf("1.2.0")),
    ];
    for (const damage of damages) {
      await (
        await open()
      ).save(
        new Map([
          ["good", cachedFile(1)],
          ["bad", cachedFile(2)],
        ]),
      );
      const stored = await readStored();
      damage(stored.files.bad!, stored.strings);
      await NodeFSP.writeFile(cacheFile(), JSON.stringify(stored));

      const cache = await open();
      expect(cache.get("bad"), damage.toString()).toBeUndefined();
      expect(cache.get("good")).toEqual(cachedFile(1));
    }
  });
});

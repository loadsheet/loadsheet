import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { sumTallies, type Fact, type TranscriptFormat } from "../src/index.ts";
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

const usageSession = (day: string, project: string, thread: "main" | "subagent", n: number) => ({
  day,
  harness: "fake",
  via: "cli",
  project,
  thread,
  sessions: n,
  compacted: n % 2,
  compactions: n * 2,
  manualCompactions: n % 3,
});

const usageTokens = (
  day: string,
  project: string,
  thread: "main" | "subagent",
  model: string,
  n: number,
) => ({
  day,
  harness: "fake",
  via: "cli",
  project,
  thread,
  model,
  requests: n,
  input: n * 10,
  output: n * 20,
  reasoning: n * 5,
  cacheRead: n * 1000,
  cacheWrite: n * 300,
  cacheWrite5m: n * 100,
  cacheWrite1h: n * 150,
  cacheRewrite: n * 40,
});

/** A cached file with cells in several groups and a state that uses every JSON type. */
const cachedFile = (seed: number): CachedFile => ({
  size: 1000 + seed,
  mtimeMs: 1763980000000.5 + seed,
  ctimeMs: 1763980000001.25 + seed,
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
    windows: [{ harness: "fake", day: "2026-11-23", tokens: 200_000 + seed }],
    usage: {
      sessions: [
        usageSession("2026-11-22", "acme/web", "main", 1),
        usageSession("2026-11-22", "acme/web", "subagent", 2 + seed),
        usageSession("2026-11-23", "~/scratch", "main", seed),
      ],
      tokens: [
        usageTokens("2026-11-22", "acme/web", "main", "model-a", 1),
        usageTokens("2026-11-22", "acme/web", "main", "model-b", seed),
        usageTokens("2026-11-23", "unknown", "subagent", "model-a", 3),
      ],
    },
  },
});

const cacheFile = () => NodePath.join(dir, "fake.json");

interface Stored {
  tool: string;
  format: string;
  salt: string;
  strings: string[];
  files: Record<string, unknown[]>;
}

/** The cache file's layout, sum and document. */
const readFile = async () =>
  JSON.parse(await NodeFSP.readFile(cacheFile(), "utf8")) as {
    layout: number;
    sum: string;
    doc: Stored;
  };

const readStored = async () => (await readFile()).doc;

/** Writes `doc` the way loadsheet would have, with the sum of its text, or with `sum` when given. */
const writeStored = async (stored: Stored, sum?: string) => {
  const doc = JSON.stringify(stored);
  sum ??= NodeCrypto.createHash("sha256").update(doc).digest("hex");
  const { layout } = await readFile();
  await NodeFSP.writeFile(cacheFile(), `{"layout":${layout},"sum":"${sum}","doc":${doc}}`);
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
      (entry) => (entry[2] = "then"),
      (entry) => (entry[3] = true),
      (entry, strings) => ((entry[8] as unknown[][])[1]![0] = strings.length),
      (entry) => (((entry[8] as unknown[][])[1]![3] as unknown[])[1] = 1.5),
      (entry) => (entry[8] as unknown[][])[0]!.push(1),
      (entry) => (entry[7] = [0]),
      (entry) => (entry[7] = { a: [], b: [] }),
      (entry) => (entry[7] = "NaN"),
      (entry) => (entry[7] = { a: ["01"] }),
      (entry) => (entry[8] = "tally"),
      // A day that is a string but not YYYY-MM-DD, in sessions, a cell group and versions.
      (entry, strings) => ((entry[8] as unknown[][])[0]![0] = strings.indexOf("fake")),
      (entry, strings) => ((entry[8] as unknown[][])[1]![0] = strings.indexOf("cli")),
      (entry, strings) => ((entry[8] as unknown[][])[2]![1] = strings.indexOf("1.2.0")),
      // A day no calendar has, which parseScan would refuse.
      (entry, strings) => ((entry[8] as unknown[][])[0]![0] = strings.push("2026-11-31") - 1),
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
      await writeStored(stored);

      const cache = await open();
      expect(cache.get("bad"), damage.toString()).toBeUndefined();
      expect(cache.get("good")).toEqual(cachedFile(1));
    }
  });

  it("opens empty a file whose contents are not the ones it saved", async () => {
    await (await open()).save(new Map([["one", cachedFile(1)]]));
    const stored = await readStored();
    expect((await open()).get("one")).toEqual(cachedFile(1));

    // A well-formed entry with one counter changed, which no check of its shape would catch.
    const { sum } = await readFile();
    (stored.files.one![8] as number[][])[0]![3] = 7;
    await writeStored(stored, sum);
    expect((await open()).get("one")).toBeUndefined();

    // The same text spelled with other whitespace.
    await writeStored(await readStored());
    const text = await NodeFSP.readFile(cacheFile(), "utf8");
    await NodeFSP.writeFile(cacheFile(), text.replace('"doc":', '"doc": '));
    expect((await open()).get("one")).toBeUndefined();
  });

  it("opens empty a file saved in another layout", async () => {
    await (await open()).save(new Map([["one", cachedFile(1)]]));
    const file = await readFile();
    expect(file.layout).toBe(5);
    // Layout 2 kept the document's fields beside its sum.
    await NodeFSP.writeFile(cacheFile(), JSON.stringify({ layout: 2, ...file.doc, sum: file.sum }));
    expect((await open()).get("one")).toBeUndefined();

    await NodeFSP.writeFile(cacheFile(), JSON.stringify(file));
    expect((await open()).get("one")).toEqual(cachedFile(1));
    const text = await NodeFSP.readFile(cacheFile(), "utf8");
    await NodeFSP.writeFile(cacheFile(), text.replace('"layout":5', '"layout":4'));
    expect((await open()).get("one")).toBeUndefined();
  });

  it("opens empty a file another tool version saved, renamed to this one", async () => {
    await openCache(dir, "fake", "loadsheet@0.0.0-older", format).then((cache) =>
      cache.save(new Map([["one", cachedFile(1)]])),
    );
    const { sum, doc } = await readFile();
    await writeStored({ ...doc, tool: TOOL }, sum);
    expect((await open()).get("one")).toBeUndefined();
  });

  it("opens an entry nested too deep to decode as a miss", async () => {
    await (await open()).save(new Map([["one", cachedFile(1)]]));
    const depth = 20_000;
    const stored = await readStored();
    // JSON.stringify overflows on a state this deep, so the document is spliced together.
    const doc = JSON.stringify(stored).replace(
      '"files":{',
      `"files":{"deep":${JSON.stringify(stored.files.one!.with(7, null)).replace(
        ",null,",
        `,${'{"a":['.repeat(depth)}${"]}".repeat(depth)},`,
      )},`,
    );
    const sum = NodeCrypto.createHash("sha256").update(doc).digest("hex");
    const { layout } = await readFile();
    await NodeFSP.writeFile(cacheFile(), `{"layout":${layout},"sum":"${sum}","doc":${doc}}`);
    const cache = await open();
    expect(cache.get("deep")).toBeUndefined();
    expect(cache.get("one")).toEqual(cachedFile(1));
  });

  it("sums cached tallies as summing their Tallies would, inside a window", async () => {
    const seeds = [1, 2, 3, 4];
    await (await open()).save(new Map(seeds.map((seed) => [`f${seed}`, cachedFile(seed)])));
    const cache = await open();
    // Opened entries and one the cache file does not hold yet.
    const files = [...seeds.map((seed) => cache.get(`f${seed}`)!), cachedFile(5)];
    const tallies = [...seeds, 5].map((seed) => cachedFile(seed).tally);
    for (const window of [
      ["2026-11-01", "2026-11-30"],
      ["2026-11-23", "2026-11-23"],
      ["2026-12-01", "2026-12-07"],
    ] as const) {
      expect(cache.sum(files, window)).toEqual(sumTallies(tallies, window));
    }
    expect(cache.sum([], ["2026-11-01", "2026-11-30"])).toEqual(sumTallies([]));
  });

  it("opens as a miss an entry whose usage thread is neither main nor subagent", async () => {
    await (await open()).save(new Map([["one", cachedFile(1)]]));
    const stored = await readStored();
    const tally = stored.files.one![8] as number[][];
    // The first usage session's thread, swapped for the string its via names.
    tally[4]![4] = tally[4]![2]!;
    await writeStored(stored);
    expect((await open()).get("one")).toBeUndefined();
  });

  it("opens empty a file saved for a format with another skip", async () => {
    const skipping = { ...format, skip: () => false } as TranscriptFormat<unknown>;
    await (await open()).save(new Map([["one", cachedFile(1)]]));
    expect((await openCache(dir, "fake", TOOL, skipping)).get("one")).toBeUndefined();
    await (await openCache(dir, "fake", TOOL, skipping)).save(new Map([["one", cachedFile(1)]]));
    expect((await openCache(dir, "fake", TOOL, skipping)).get("one")).toEqual(cachedFile(1));
    const other = { ...format, skip: () => true } as TranscriptFormat<unknown>;
    expect((await openCache(dir, "fake", TOOL, other)).get("one")).toBeUndefined();
  });

  it("makes a cache directory that was already there private", async () => {
    await NodeFSP.chmod(dir, 0o755);
    await (await open()).save(new Map([["one", cachedFile(1)]]));
    expect((await NodeFSP.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await NodeFSP.stat(cacheFile())).mode & 0o777).toBe(0o600);
  });
});

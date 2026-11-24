import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CANARY, findCanary, findCanaryInDir } from "@loadsheet/fixtures";
import { parseScan, type Cell, type Item, type Scan, type SessionCell } from "@loadsheet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineHarness, mergeScans, sha256, type Fact, type Harness } from "../src/index.ts";
import { scanMachine, scanWindow } from "../src/node/index.ts";

// A harness made up for these tests: its transcripts are JSONL under ~/.fake/sessions, and every
// line carries the session id and canary text that must stay out of the Scan and the cache.
interface FakeState {
  day?: string;
  via?: string;
  measured: boolean;
  listed: string[];
}

let parsed = 0;

const fake: Harness<FakeState> = defineHarness({
  id: "fake",
  signals: {
    listing: "exact",
    modelUse: "exact",
    userUse: "exact",
    instructions: "none",
    mcp: "exact",
    tokens: "exact",
  },
  inventory: async () => [],
  machine: {
    home: (place) => `${place.home}/.fake`,
    sources: (place) => [`${place.home}/.fake/skills`, `${place.home}/.fake/AGENTS.md`],
    roots: (place) => [`${place.home}/.fake/sessions`],
    async inventory(files) {
      const items: Item[] = [];
      for (const path of files.paths) {
        const text = (await files.text(path)) ?? "";
        const name = path.endsWith("AGENTS.md") ? "AGENTS.md" : path.split("/").at(-2)!;
        const kind = path.endsWith("AGENTS.md") ? "instructions" : "skill";
        items.push({
          id: `${kind}:${name}`,
          ref: { kind, name },
          harnesses: ["fake"],
          scope: "user",
          managedBy: "hand",
          path,
          digest: await sha256(text),
          chars: { listed: text.length, body: 0 },
          modelInvocable: true,
        });
      }
      return items;
    },
    transcripts: {
      markers: ['"t":"'],
      initial: (): FakeState => ({ measured: false, listed: [] }),
      parse(line, state): Fact[] {
        parsed += 1;
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line);
        } catch {
          return [];
        }
        if (value.t === "start") {
          state.day = String(value.day);
          state.via = String(value.via);
          const version = typeof value.v === "string" ? { version: value.v } : {};
          return [{ type: "session", day: state.day, via: state.via, ...version }];
        }
        if (state.day === undefined || state.via === undefined) return [];
        const at = { day: state.day, via: state.via };
        if (value.t === "usage" && !state.measured) {
          state.measured = true;
          return [{ type: "tokens", ...at, tokens: Number(value.tokens) }];
        }
        if (value.t === "list") {
          const facts: Fact[] = [];
          for (const entry of value.items as Array<{ id: string; chars: number; bare: boolean }>) {
            if (state.listed.includes(entry.id)) continue;
            state.listed.push(entry.id);
            facts.push({
              type: "listed",
              ...at,
              item: entry.id,
              chars: entry.chars,
              bare: entry.bare,
            });
          }
          return facts;
        }
        if (value.t === "use") {
          return [
            { type: "used", ...at, item: String(value.item), by: value.by as "model" | "user" },
          ];
        }
        return [];
      },
    },
  },
});

interface SessionSpec {
  sid: string;
  day: string;
  via?: string;
  version?: string;
  tokens?: number;
  listed?: Array<[id: string, chars: number, bare: boolean]>;
  used?: Array<[id: string, by: "model" | "user"]>;
}

/** A session's transcript: every Fact the spec names, plus lines the parser must ignore. */
const transcript = (spec: SessionSpec): string => {
  const sid = spec.sid;
  const lines: unknown[] = [
    { x: "no marker", sid, text: `${CANARY} before the session` },
    { t: "start", sid, day: spec.day, via: spec.via ?? "cli", v: spec.version, cwd: "/secret" },
  ];
  if (spec.tokens !== undefined) {
    lines.push({ t: "usage", sid, tokens: spec.tokens }, { t: "usage", sid, tokens: 99999 });
  }
  const listing = (spec.listed ?? []).map(([id, chars, bare]) => ({ id, chars, bare }));
  lines.push({ t: "list", sid, items: listing, text: CANARY });
  lines.push({ t: "list", sid, items: listing });
  for (const [item, by] of spec.used ?? []) {
    lines.push({ t: "use", sid, item, by, input: `${CANARY} tool input` });
  }
  lines.push({ t: "text", sid, text: `${CANARY} assistant text` });
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
};

const NOW = new Date("2026-11-24T15:00:00.000Z");
const DAYS = 7;
const RECENT = new Date("2026-11-23T08:00:00.000Z");
const LATER = new Date("2026-11-24T09:00:00.000Z");
const OLD = new Date("2026-10-01T00:00:00.000Z");

let tmp: string;

beforeEach(async () => {
  parsed = 0;
  tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-scan-"));
});

afterEach(async () => {
  await NodeFSP.rm(tmp, { recursive: true, force: true });
});

/** A home with the fake harness's sources and `sessions`, one transcript file each. */
const makeHome = async (name: string, sessions: SessionSpec[]): Promise<string> => {
  const home = NodePath.join(tmp, `home-${name}-private`);
  await NodeFSP.mkdir(`${home}/.fake/skills/alpha`, { recursive: true });
  await NodeFSP.mkdir(`${home}/.fake/sessions/project-private`, { recursive: true });
  await NodeFSP.writeFile(`${home}/.fake/skills/alpha/SKILL.md`, "---\nname: alpha\n---\n");
  await NodeFSP.writeFile(`${home}/.fake/AGENTS.md`, "Be brief.\n");
  for (const spec of sessions) await writeTranscript(home, spec.sid, transcript(spec), RECENT);
  return home;
};

const transcriptPath = (home: string, sid: string) =>
  `${home}/.fake/sessions/project-private/${sid}.jsonl`;

const writeTranscript = async (home: string, sid: string, text: string, mtime: Date) => {
  const path = transcriptPath(home, sid);
  await NodeFSP.writeFile(path, text);
  await NodeFSP.utimes(path, mtime, mtime);
};

const appendTranscript = async (home: string, sid: string, text: string, mtime: Date) => {
  const path = transcriptPath(home, sid);
  await NodeFSP.appendFile(path, text);
  await NodeFSP.utimes(path, mtime, mtime);
};

const scan = (home: string, cacheDir: string | false, tool = "loadsheet@0.0.0-test") =>
  scanMachine({
    harnesses: [fake as Harness],
    days: DAYS,
    tool,
    machine: "test-machine",
    now: NOW,
    place: { home, env: {} },
    cacheDir,
  });

const cold = (home: string) => scan(home, false);

const SESSIONS: SessionSpec[] = [
  {
    sid: "sid-1a2b3c4d-private",
    day: "2026-11-22",
    version: "1.2.0",
    tokens: 1200,
    listed: [
      ["skill:alpha", 30, false],
      ["mcp:files", 11, false],
    ],
    used: [
      ["skill:alpha", "model"],
      ["skill:alpha", "user"],
      ["mcp:files", "model"],
    ],
  },
  {
    sid: "sid-5e6f7a8b-private",
    day: "2026-11-22",
    version: "1.3.0",
    tokens: 800,
    listed: [["skill:alpha", 9, true]],
  },
  {
    sid: "sid-9c0d1e2f-private",
    day: "2026-11-23",
    via: "app",
    listed: [["skill:alpha", 30, false]],
    used: [["skill:alpha", "model"]],
  },
  // Started before the window, though its file changed inside it.
  {
    sid: "sid-old0old0-private",
    day: "2026-11-01",
    tokens: 5,
    listed: [["skill:alpha", 30, false]],
  },
];

/**
 * Every numeric field of `merged`'s SessionCells and Cells totals the parts' sum, and is above 0
 * in each part. It reads fields generically, so a counter added later is checked too.
 */
const expectSummed = (merged: Scan, parts: Scan[]) => {
  const total = (rows: readonly object[], field: string) =>
    rows.reduce((sum, row) => sum + ((row as Record<string, unknown>)[field] as number), 0);
  for (const list of ["sessions", "cells"] as const) {
    const fields = Object.entries(merged[list][0]!)
      .filter(([, value]) => typeof value === "number")
      .map(([field]) => field);
    expect(fields.length).toBeGreaterThan(2);
    for (const field of fields) {
      for (const part of parts)
        expect(total(part[list], field), `${list}.${field}`).toBeGreaterThan(0);
      const sum = parts.reduce((acc, part) => acc + total(part[list], field), 0);
      expect(total(merged[list], field), `${list}.${field}`).toBe(sum);
    }
  }
};

const forbidden = (home: string, sessions: SessionSpec[]) => [
  home,
  tmp,
  "private",
  "/secret",
  ...sessions.flatMap((spec) => [spec.sid, `${spec.sid}.jsonl`]),
];

describe("scanMachine", () => {
  it("folds a machine's transcripts into a Scan that matches a hand count and parseScan", async () => {
    const home = await makeHome("one", SESSIONS);
    // A transcript that last changed before the window is not read.
    await writeTranscript(
      home,
      "sid-stale-private",
      transcript({ sid: "sid-stale-private", day: "2026-11-23", tokens: 1 }),
      OLD,
    );
    const result = await scan(home, NodePath.join(tmp, "cache"));

    expect(parseScan(result)).toEqual(result);
    expect(scanWindow(NOW, DAYS).window).toEqual(["2026-11-18", "2026-11-24"]);
    expect(result.window).toEqual(["2026-11-18", "2026-11-24"]);
    expect(result.coverage).toEqual([
      {
        machine: "test-machine",
        harness: "fake",
        installed: true,
        sessions: 3,
        versions: ["1.2.0", "1.3.0"],
        firstDay: "2026-11-22",
        lastDay: "2026-11-23",
        signals: fake.signals,
      },
    ]);
    expect(result.items.map((item) => [item.id, item.path])).toEqual([
      ["instructions:AGENTS.md", "~/.fake/AGENTS.md"],
      ["skill:alpha", "~/.fake/skills/alpha/SKILL.md"],
    ]);
    const session = (
      day: string,
      via: string,
      sessions: number,
      fixedTokens: number,
      measured: number,
    ): SessionCell => ({
      day,
      harness: "fake",
      via,
      sessions,
      fixedTokens,
      measured,
    });
    expect(result.sessions).toEqual([
      session("2026-11-22", "cli", 2, 2000, 2),
      session("2026-11-23", "app", 1, 0, 0),
    ]);
    const cell = (day: string, via: string, item: string, counts: Partial<Cell>): Cell => ({
      day,
      harness: "fake",
      via,
      item,
      sessions: 0,
      bare: 0,
      chars: 0,
      byModel: 0,
      byUser: 0,
      ...counts,
    });
    expect(result.cells).toEqual([
      cell("2026-11-22", "cli", "mcp:files", { sessions: 1, chars: 11, byModel: 1 }),
      cell("2026-11-22", "cli", "skill:alpha", {
        sessions: 2,
        bare: 1,
        chars: 39,
        byModel: 1,
        byUser: 1,
      }),
      cell("2026-11-23", "app", "skill:alpha", { sessions: 1, chars: 30, byModel: 1 }),
    ]);
    expect(findCanary(result, forbidden(home, SESSIONS))).toEqual([]);
  });

  it("reports a harness whose home is missing as not installed", async () => {
    const result = await scan(NodePath.join(tmp, "empty-home"), false);
    expect(parseScan(result).coverage).toEqual([
      expect.objectContaining({ harness: "fake", installed: false, sessions: 0, versions: [] }),
    ]);
    expect(result.items).toEqual([]);
  });

  it("merging the Scans of two sets of sessions equals the Scan of both", async () => {
    const first = SESSIONS.slice(0, 2);
    // The second half shares a day and entrypoint with the first, so the merge sums cells with
    // the same key, and gives every counter a value, so a counter the merge drops shows.
    const second: SessionSpec[] = [
      ...SESSIONS.slice(2),
      {
        sid: "sid-3a4b5c6d-private",
        day: "2026-11-22",
        version: "2.0.0",
        tokens: 70,
        listed: [
          ["skill:alpha", 9, true],
          ["mcp:files", 5, true],
        ],
        used: [
          ["skill:alpha", "user"],
          ["mcp:files", "model"],
        ],
      },
    ];
    const a = await cold(await makeHome("a", first));
    const b = await cold(await makeHome("b", second));
    const ab = await cold(await makeHome("ab", [...first, ...second]));

    const merged = mergeScans(a, b);
    expect(merged).toEqual(ab);
    expect(parseScan(merged)).toEqual(ab);
    expectSummed(merged, [a, b]);
    expect(merged.coverage[0]!.versions).toEqual(["1.2.0", "1.3.0", "2.0.0"]);
  });
});

describe("the scan cache", () => {
  const cacheDir = () => NodePath.join(tmp, "cache");

  it("reads only the lines appended since the last run, and gives the cold Scan", async () => {
    const home = await makeHome("warm", SESSIONS);
    await scan(home, cacheDir());

    parsed = 0;
    const unchanged = await scan(home, cacheDir());
    expect(parsed).toBe(0);
    expect(unchanged).toEqual(await cold(home));

    const appended = [
      { t: "use", sid: SESSIONS[0]!.sid, item: "skill:alpha", by: "model" },
      { t: "use", sid: SESSIONS[0]!.sid, item: "mcp:files", by: "user" },
      { t: "text", sid: SESSIONS[0]!.sid, text: CANARY },
    ];
    await appendTranscript(
      home,
      SESSIONS[0]!.sid,
      appended.map((line) => `${JSON.stringify(line)}\n`).join(""),
      LATER,
    );
    parsed = 0;
    const warm = await scan(home, cacheDir());
    expect(parsed).toBe(appended.length);
    expect(warm).toEqual(await cold(home));
    expect(warm.cells.find((cell) => cell.item === "skill:alpha")!.byModel).toBe(2);
  });

  it("counts an unterminated last line in this run only, and once it is complete, once", async () => {
    const home = await makeHome("tail", SESSIONS.slice(0, 1));
    const sid = SESSIONS[0]!.sid;
    const use = JSON.stringify({ t: "use", sid, item: "skill:alpha", by: "user" });
    await appendTranscript(home, sid, use, LATER);

    const first = await scan(home, cacheDir());
    expect(first).toEqual(await cold(home));
    expect(first.cells.find((cell) => cell.item === "skill:alpha")!.byUser).toBe(2);

    parsed = 0;
    expect(await scan(home, cacheDir())).toEqual(first);
    expect(parsed).toBe(1);

    await appendTranscript(home, sid, "\n", new Date(LATER.getTime() + 1000));
    parsed = 0;
    const completed = await scan(home, cacheDir());
    expect(parsed).toBe(1);
    expect(completed).toEqual(first);
  });

  it("gives the cold Scan after a transcript is rewritten, truncated or deleted", async () => {
    const home = await makeHome("change", SESSIONS);
    await scan(home, cacheDir());

    // Rewritten: same session, other counters, different bytes before the cached offset.
    await writeTranscript(
      home,
      SESSIONS[0]!.sid,
      transcript({ ...SESSIONS[0]!, tokens: 4321, used: [["mcp:files", "user"]] }),
      LATER,
    );
    const rewritten = await scan(home, cacheDir());
    expect(rewritten).toEqual(await cold(home));
    expect(rewritten.sessions[0]!.fixedTokens).toBe(4321 + 800);

    // Truncated: only the first lines are left.
    const path = transcriptPath(home, SESSIONS[1]!.sid);
    const text = await NodeFSP.readFile(path, "utf8");
    await writeTranscript(
      home,
      SESSIONS[1]!.sid,
      text.split("\n").slice(0, 3).join("\n") + "\n",
      LATER,
    );
    const truncated = await scan(home, cacheDir());
    expect(truncated).toEqual(await cold(home));

    await NodeFSP.rm(transcriptPath(home, SESSIONS[2]!.sid));
    const deleted = await scan(home, cacheDir());
    expect(deleted).toEqual(await cold(home));
    expect(deleted.sessions.map((cell) => cell.via)).toEqual(["cli"]);
  });

  it("starts cold on a corrupt cache or a new tool version", async () => {
    const home = await makeHome("corrupt", SESSIONS);
    const expected = await cold(home);
    const all = parsed;
    await scan(home, cacheDir());
    for (const name of await NodeFSP.readdir(cacheDir())) {
      await NodeFSP.writeFile(NodePath.join(cacheDir(), name), '{"layout":1,"files":');
    }
    parsed = 0;
    expect(await scan(home, cacheDir())).toEqual(expected);
    expect(parsed).toBe(all);

    parsed = 0;
    expect(await scan(home, cacheDir(), "loadsheet@9.9.9")).toEqual({
      ...expected,
      tool: "loadsheet@9.9.9",
    });
    expect(parsed).toBe(all);
  });

  it("holds no transcript text, session id, file name or home path", async () => {
    const home = await makeHome("clean", SESSIONS);
    const sid = SESSIONS[0]!.sid;
    await appendTranscript(home, sid, JSON.stringify({ t: "text", sid, text: CANARY }), LATER);
    await scan(home, cacheDir());
    await appendTranscript(home, sid, "\n", new Date(LATER.getTime() + 1000));
    await scan(home, cacheDir());

    expect((await NodeFSP.readdir(cacheDir())).length).toBeGreaterThan(0);
    expect(await findCanaryInDir(cacheDir(), forbidden(home, SESSIONS))).toEqual([]);
  });
});

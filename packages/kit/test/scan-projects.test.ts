import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findCanary, findCanaryInDir } from "@loadsheet/fixtures";
import { parseScan, type Scan } from "@loadsheet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineHarness, type Fact, type Harness } from "../src/index.ts";
import { resolveProjects, scanMachine } from "../src/node/index.ts";

// A harness made up for these tests: each transcript names its cwd as an absolute path, which the
// parser keys as the Files keys paths, and its tokens. Hints come from `~/.proj/hints.json`.
interface ProjState {
  day?: string;
  project?: string;
}

const proj: Harness<ProjState> = defineHarness({
  id: "proj",
  signals: {
    listing: "none",
    modelUse: "none",
    userUse: "none",
    instructions: "none",
    mcp: "none",
    tokens: "none",
    usage: "exact",
    cacheTtl: "none",
  },
  inventory: async () => [],
  machine: {
    home: (place) => `${place.home}/.proj`,
    sources: (place) => [`${place.home}/.proj/hints.json`],
    inventory: async () => [],
    async projects(files) {
      const text = await files.text("~/.proj/hints.json");
      return text ? JSON.parse(text) : [];
    },
    roots: (place) => [`${place.home}/.proj/sessions`],
    transcripts: {
      markers: ['"t":"'],
      initial: (): ProjState => ({}),
      parse(line, state, place): Fact[] {
        const value = JSON.parse(line) as Record<string, string | number>;
        if (value.t === "start") {
          const cwd = String(value.cwd);
          const home = place?.home;
          state.day = String(value.day);
          state.project =
            home && cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
          return [
            { type: "session", day: state.day, via: "cli" },
            {
              type: "usage-session",
              day: state.day,
              via: "cli",
              project: state.project,
              thread: "main",
            },
          ];
        }
        if (value.t === "tokens" && state.day && state.project) {
          return [
            {
              type: "usage-tokens",
              day: state.day,
              via: "cli",
              project: state.project,
              thread: "main",
              model: "m",
              input: Number(value.input),
              output: 10,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              cacheRewrite: 0,
            },
          ];
        }
        return [];
      },
    },
  },
});

const NOW = new Date("2026-11-24T15:00:00.000Z");
const RECENT = new Date("2026-11-23T08:00:00.000Z");

let tmp: string;
let home: string;

beforeEach(async () => {
  tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-projects-"));
  home = NodePath.join(tmp, "home");
});

afterEach(async () => {
  await NodeFSP.rm(tmp, { recursive: true, force: true });
});

const write = async (path: string, text: string) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, text);
};

const session = async (sid: string, cwd: string, input: number) => {
  const path = `${home}/.proj/sessions/${sid}.jsonl`;
  const lines = [
    { t: "start", day: "2026-11-23", cwd },
    { t: "tokens", input },
  ];
  await write(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  await NodeFSP.utimes(path, RECENT, RECENT);
};

const origin = (url: string) =>
  `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

/** A repository at ~/code/app, a worktree of it at ~/wt/app-feat, a plain ~/notes, and hints. */
const makeHome = async () => {
  await write(`${home}/code/app/.git/config`, origin("git@github.com:Acme/App.git"));
  await write(`${home}/code/app/.git/worktrees/app-feat/commondir`, "../..\n");
  await write(`${home}/wt/app-feat/.git`, `gitdir: ${home}/code/app/.git/worktrees/app-feat\n`);
  await NodeFSP.mkdir(`${home}/notes`, { recursive: true });
  // The worktree ~/gone/wt was deleted; only the harness remembers its repository.
  await write(
    `${home}/.proj/hints.json`,
    JSON.stringify([{ prefix: `${home}/gone/wt`, project: "Acme/Gone" }]),
  );
  await session("s1", `${home}/code/app`, 100);
  await session("s2", `${home}/wt/app-feat/packages/ui`, 20);
  await session("s3", `${home}/notes`, 3);
  await session("s4", `${home}/gone/wt`, 4);
  await session("s5", "/srv/shared", 5);
};

const cacheDir = () => NodePath.join(tmp, "cache");

const scan = () =>
  scanMachine({
    harnesses: [proj as Harness],
    days: 7,
    tool: "loadsheet@0.0.0-test",
    machine: "test-machine",
    now: NOW,
    place: { home, env: {} },
    cacheDir: cacheDir(),
  });

const projects = (result: Scan) =>
  Object.fromEntries(
    (result.usage?.tokens ?? []).map((cell) => [cell.project, [cell.requests, cell.input]]),
  );

describe("scanMachine's projects", () => {
  it("names each project by its repository and sums the worktrees of one", async () => {
    await makeHome();
    const result = await scan();

    expect(parseScan(result)).toEqual(result);
    expect(projects(result)).toEqual({
      "/srv/shared": [1, 5],
      "acme/app": [2, 120],
      "acme/gone": [1, 4],
      "~/notes": [1, 3],
    });
    expect(
      Object.fromEntries(result.usage!.sessions.map((cell) => [cell.project, cell.sessions])),
    ).toEqual({ "/srv/shared": 1, "acme/app": 2, "acme/gone": 1, "~/notes": 1 });
    expect(findCanary(result, [tmp])).toEqual([]);
  });

  it("keeps the folders in the cache and resolves them again on the next run", async () => {
    await makeHome();
    await scan();
    expect(await findCanaryInDir(cacheDir(), [tmp, "acme/"])).toEqual([]);

    await write(`${home}/code/app/.git/config`, origin("https://github.com/Other/Renamed"));
    const again = await scan();
    expect(projects(again)["other/renamed"]).toEqual([2, 120]);
    expect(projects(again)["acme/app"]).toBeUndefined();
  });
});

describe("resolveProjects", () => {
  it("never names an absolute path under the home", async () => {
    await NodeFSP.mkdir(`${home}/notes`, { recursive: true });
    const cell = { day: "2026-11-23", harness: "proj", via: "cli", thread: "main" } as const;
    const tokens = {
      ...cell,
      model: "m",
      requests: 1,
      input: 1,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRewrite: 0,
    };
    const base: Scan = {
      schema: 1,
      tool: "t",
      machine: "m",
      scannedAt: NOW.toISOString(),
      window: ["2026-11-18", "2026-11-24"],
      coverage: [],
      items: [],
      sessions: [],
      cells: [],
      usage: {
        sessions: [],
        tokens: [
          { ...tokens, project: `${home}/notes` },
          { ...tokens, project: "~/notes" },
        ],
      },
    };
    const result = resolveProjects(base, [], { home, env: {} });
    expect(result.usage!.tokens.map((entry) => [entry.project, entry.input])).toEqual([
      ["~/notes", 2],
    ]);
    expect(findCanary(result, [tmp])).toEqual([]);
  });
});

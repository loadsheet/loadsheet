import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findCanary } from "@loadsheet/fixtures";
import { parseScan, type Signal, type Grade } from "@loadsheet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  defineHarness,
  type FolderStore,
  type Harness,
  type SqliteStore,
  type StoreFact,
} from "../src/index.ts";
import { readStore, scanMachine } from "../src/node/index.ts";

const NOW = new Date("2026-11-24T15:00:00.000Z");
// The 7-day window ending on NOW starts on 2026-11-18.
const SINCE = Date.parse("2026-11-18T00:00:00.000Z");
const IN = Date.parse("2026-11-20T10:00:00.000Z");
const BEFORE = Date.parse("2026-11-10T10:00:00.000Z");

let tmp: string;
let home: string;

beforeEach(async () => {
  tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-stores-"));
  home = NodePath.join(tmp, "home");
  await NodeFSP.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await NodeFSP.rm(tmp, { recursive: true, force: true });
});

const place = () => ({ home, env: {} });

const tokens = (day: string, project: string, input: number, output: number): StoreFact => ({
  type: "usage-tokens",
  day,
  via: "cli",
  project,
  thread: "main",
  model: "m",
  input,
  output,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRewrite: 0,
});

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A store over `<home>/.db/sessions.db`: one row per session, its start, folder and tokens. */
const sqliteStore = (overrides: Partial<SqliteStore> = {}): SqliteStore => ({
  kind: "sqlite",
  name: "sessions.db",
  path: (at) => `${at.home}/.db/sessions.db`,
  query: "SELECT at, cwd, input, output FROM sessions WHERE at >= $since ORDER BY at",
  since: "ms",
  facts: (rows) =>
    rows.flatMap((row) => {
      const day = dayOf(Number(row.at));
      const project = String(row.cwd);
      return [
        { type: "usage-session", day, via: "cli", project, thread: "main" } as const,
        tokens(day, project, Number(row.input), Number(row.output)),
      ];
    }),
  ...overrides,
});

const makeDb = (wal: boolean) => {
  const path = `${home}/.db/sessions.db`;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA synchronous = OFF");
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE sessions (at INTEGER, cwd TEXT, input INTEGER, output INTEGER, title TEXT)",
  );
  const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)");
  insert.run(IN, "~/code/app", 100, 10, "a private title");
  insert.run(IN + 1000, "~/code/app", 20, 2, "a private title");
  insert.run(BEFORE, "~/old", 999, 999, "a private title");
  return db;
};

const listing = async () => (await NodeFSP.readdir(`${home}/.db`)).sort();

describe("readStore on SQLite", () => {
  it("reads a closed database and creates no file beside it", async () => {
    await NodeFSP.mkdir(`${home}/.db`, { recursive: true });
    makeDb(false).close();
    const before = await listing();
    expect(before).toEqual(["sessions.db"]);

    const read = await readStore(sqliteStore(), place(), SINCE);

    expect(read && "facts" in read && read.facts.filter((f) => f.type === "usage-tokens")).toEqual([
      tokens("2026-11-20", "~/code/app", 100, 10),
      tokens("2026-11-20", "~/code/app", 20, 2),
    ]);
    expect(await listing()).toEqual(before);
  });

  it("reads the rows a writer holds in its WAL and leaves its files as they were", async () => {
    await NodeFSP.mkdir(`${home}/.db`, { recursive: true });
    // The writer stays open, so its rows are in sessions.db-wal, not yet in sessions.db.
    const writer = makeDb(true);
    try {
      const before = await listing();
      expect(before).toEqual(["sessions.db", "sessions.db-shm", "sessions.db-wal"]);
      const sizes = await Promise.all(
        before.map(async (name) => (await NodeFSP.stat(`${home}/.db/${name}`)).size),
      );

      const read = await readStore(sqliteStore(), place(), SINCE);

      expect(read && "facts" in read && read.facts.length).toBe(4);
      expect(await listing()).toEqual(before);
      expect(
        await Promise.all(
          before.map(async (name) => (await NodeFSP.stat(`${home}/.db/${name}`)).size),
        ),
      ).toEqual(sizes);
    } finally {
      writer.close();
    }
  });

  it("reports a WAL without its shared-memory index as unread without changing files", async () => {
    const dir = `${home}/.db`;
    await NodeFSP.mkdir(dir, { recursive: true });
    const writer = makeDb(true);
    try {
      await NodeFSP.copyFile(`${dir}/sessions.db`, `${dir}/copy.db`);
      await NodeFSP.copyFile(`${dir}/sessions.db-wal`, `${dir}/copy.db-wal`);
      const before = await listing();
      const copy = sqliteStore({ path: () => `${dir}/copy.db` });
      expect(await readStore(copy, place(), SINCE)).toEqual({ unread: true });
      expect(await listing()).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("binds the window's start as an ISO timestamp", async () => {
    await NodeFSP.mkdir(`${home}/.db`, { recursive: true });
    const db = new DatabaseSync(`${home}/.db/sessions.db`);
    db.exec("PRAGMA synchronous = OFF");
    db.exec("CREATE TABLE sessions (at TEXT)");
    db.prepare("INSERT INTO sessions VALUES (?)").run(new Date(IN).toISOString());
    db.prepare("INSERT INTO sessions VALUES (?)").run(new Date(BEFORE).toISOString());
    db.close();
    const seen: unknown[] = [];
    const store = sqliteStore({
      query: "SELECT at FROM sessions WHERE at >= $since",
      since: "iso",
      facts: (rows) => {
        seen.push(...rows.map((row) => row.at));
        return [];
      },
    });
    expect(await readStore(store, place(), SINCE)).toEqual({ facts: [] });
    expect(seen).toEqual([new Date(IN).toISOString()]);
  });

  it("is unread when the file is not a database or the query does not fit it", async () => {
    await NodeFSP.mkdir(`${home}/.db`, { recursive: true });
    await NodeFSP.writeFile(`${home}/.db/sessions.db`, "not a database at all, just text\n");
    expect(await readStore(sqliteStore(), place(), SINCE)).toEqual({ unread: true });

    await NodeFSP.rm(`${home}/.db/sessions.db`);
    makeDb(false).close();
    const wrong = sqliteStore({ query: "SELECT nothing FROM elsewhere WHERE $since" });
    expect(await readStore(wrong, place(), SINCE)).toEqual({ unread: true });
    expect(await listing()).toEqual(["sessions.db"]);
  });

  it("gives nothing for a database that is not there", async () => {
    expect(await readStore(sqliteStore(), place(), SINCE)).toBeUndefined();
  });
});

/** A store over `<home>/.fold/<project>/<id>/`: `meta.json` holds the day and tokens. */
const folderStore: FolderStore = {
  kind: "folder",
  name: "fold-sessions",
  root: (at) => `${at.home}/.fold`,
  depth: 2,
  files: ["meta.json", "extra.json"],
  facts: ({ folder, files }) => {
    const meta = JSON.parse(files["meta.json"] ?? "{}") as { day: string; input: number };
    const project = `~/${decodeURIComponent(folder.split("/")[0]!)}`;
    return [
      { type: "usage-session", day: meta.day, via: "cli", project, thread: "main" },
      {
        type: "compaction",
        day: meta.day,
        via: "cli",
        project,
        thread: "main",
        manual: false,
        first: true,
      },
      tokens(meta.day, project, meta.input, files["extra.json"] === undefined ? 0 : 1),
    ];
  },
};

const session = async (cwd: string, id: string, meta: object, mtime: number, extra = true) => {
  const dir = `${home}/.fold/${encodeURIComponent(cwd)}/${id}`;
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(`${dir}/meta.json`, JSON.stringify(meta));
  if (extra) await NodeFSP.writeFile(`${dir}/extra.json`, "{}");
  await NodeFSP.utimes(`${dir}/meta.json`, mtime / 1000, mtime / 1000);
};

describe("readStore on a folder", () => {
  it("reads the session folders changed in the window, in folder order", async () => {
    await session("code/b", "s2", { day: "2026-11-21", input: 7 }, IN);
    await session("code/a", "s1", { day: "2026-11-20", input: 5 }, IN, false);
    await session("code/a", "s0", { day: "2026-11-09", input: 9 }, BEFORE);
    await NodeFSP.writeFile(`${home}/.fold/stray.json`, "{}");

    const read = await readStore(folderStore, place(), SINCE);

    expect(read && "facts" in read && read.facts.filter((f) => f.type === "usage-tokens")).toEqual([
      tokens("2026-11-20", "~/code/a", 5, 0),
      tokens("2026-11-21", "~/code/b", 7, 1),
    ]);
  });

  it("gives nothing when the folder is not there", async () => {
    expect(await readStore(folderStore, place(), SINCE)).toBeUndefined();
  });
});

const NONE = {
  listing: "none",
  modelUse: "none",
  userUse: "none",
  instructions: "none",
  mcp: "none",
  tokens: "none",
  usage: "exact",
  cacheTtl: "none",
  turns: "none",
  hours: "none",
  tools: "none",
  limits: "none",
} satisfies Record<Signal, Grade>;

/** A harness known only by its stores: a folder that reads, and a database that does not. */
const stored: Harness = defineHarness({
  id: "stored",
  signals: NONE,
  inventory: async () => [],
  machine: {
    home: (at) => `${at.home}/.fold`,
    sources: () => [],
    inventory: async () => [],
    stores: () => [folderStore, sqliteStore({ name: "broken.db" })],
  },
});

describe("scanMachine's stores", () => {
  it("adds their usage, never their sessions, and lists the stores it could not read", async () => {
    await session("code/a", "s1", { day: "2026-11-20", input: 5 }, IN);
    await session("code/a", "s2", { day: "2026-11-21", input: 6 }, IN);
    await NodeFSP.mkdir(`${home}/.db`, { recursive: true });
    await NodeFSP.writeFile(`${home}/.db/sessions.db`, "not a database\n");
    // A store no harness owns, whose Facts name their harness, and one that cannot be read.
    const other: FolderStore & { harness: string } = {
      ...folderStore,
      harness: "driver",
      name: "driver-sessions",
      facts: (session, at) =>
        folderStore.facts(session, at).map((fact) => ({ ...fact, harness: "driven" })),
    };
    const broken = { ...sqliteStore({ name: "driver.db" }), harness: "driver" };

    const scan = await scanMachine({
      harnesses: [stored],
      stores: [other, broken],
      days: 7,
      tool: "loadsheet@0.0.0-test",
      machine: "test-machine",
      now: NOW,
      place: place(),
      cacheDir: false,
    });

    expect(parseScan(scan)).toEqual(scan);
    expect(scan.sessions).toEqual([]);
    expect(scan.coverage.map((row) => [row.harness, row.installed, row.unread])).toEqual([
      ["driver", false, ["driver.db"]],
      ["stored", true, ["broken.db"]],
    ]);
    const sessions = Object.fromEntries(
      scan.usage!.sessions.map((cell) => [
        `${cell.harness} ${cell.day}`,
        [cell.sessions, cell.compactions],
      ]),
    );
    expect(sessions).toEqual({
      "driven 2026-11-20": [1, 1],
      "driven 2026-11-21": [1, 1],
      "stored 2026-11-20": [1, 1],
      "stored 2026-11-21": [1, 1],
    });
    expect(
      scan.usage!.tokens.map((cell) => [cell.harness, cell.project, cell.input, cell.output]),
    ).toEqual([
      ["driven", "~/code/a", 5, 1],
      ["stored", "~/code/a", 5, 1],
      ["driven", "~/code/a", 6, 1],
      ["stored", "~/code/a", 6, 1],
    ]);
    expect(findCanary(scan, [tmp, home, "private title"])).toEqual([]);
  });
});

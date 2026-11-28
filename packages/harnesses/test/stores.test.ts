import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findCanary } from "@loadsheet/fixtures";
import type { Harness } from "@loadsheet/kit";
import { scanMachine } from "@loadsheet/kit/node";
import { parseScan, type Scan } from "@loadsheet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { claudeCode, grok, opencode, sessionStores, t3Code } from "../src/index.ts";
import { noTokens, tokensOf } from "../src/store-facts.ts";

// Every session below is invented for these tests; nothing comes from a real machine.

const NOW = new Date("2026-11-24T15:00:00.000Z");
const IN = new Date("2026-11-22T10:00:00.000Z");
const OLD = new Date("2026-11-01T10:00:00.000Z");
const SECRET = "a private title canary";

let tmp: string;
let home: string;

beforeEach(async () => {
  tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-harness-stores-"));
  home = NodePath.join(tmp, "home");
  await NodeFSP.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await NodeFSP.rm(tmp, { recursive: true, force: true });
});

const write = async (path: string, value: unknown) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};

const scan = (harnesses: Harness[], stores: typeof sessionStores | [] = []) =>
  scanMachine({
    harnesses,
    stores,
    days: 7,
    // Bounded as `loadsheet usage --days 7` bounds it, so a row before the window is not read.
    usageDays: 7,
    tool: "loadsheet@0.0.0-test",
    machine: "test-machine",
    now: NOW,
    place: { home, env: {} },
    cacheDir: false,
  });

type TokenCell = NonNullable<Scan["usage"]>["tokens"][number];
const tokenRows = (result: Scan) =>
  result.usage!.tokens.map((cell: TokenCell) => ({
    key: `${cell.harness} ${cell.via} ${cell.day} ${cell.project} ${cell.thread} ${cell.model}`,
    counts: [
      cell.requests,
      cell.input,
      cell.output,
      cell.reasoning,
      cell.cacheRead,
      cell.cacheWrite,
    ],
  }));
const sessionRows = (result: Scan) =>
  Object.fromEntries(
    result.usage!.sessions.map((cell) => [
      `${cell.harness} ${cell.via} ${cell.day} ${cell.project} ${cell.thread}`,
      [cell.sessions, cell.compactions, cell.compacted],
    ]),
  );

const grokSession = async (
  cwd: string,
  id: string,
  files: { summary: object; usage: object; signals?: object },
  mtime = IN,
) => {
  const dir = `${home}/.grok/sessions/${encodeURIComponent(cwd)}/${id}`;
  await write(`${dir}/summary.json`, { info: { id, cwd }, ...files.summary });
  await write(`${dir}/usage.json`, { sessionId: id, ...files.usage });
  await write(`${dir}/signals.json`, files.signals ?? {});
  await NodeFSP.utimes(`${dir}/usage.json`, mtime, mtime);
};

const modelUsage = (
  input: number,
  cachedRead: number,
  creation: number,
  output: number,
  reasoning: number,
  calls: number,
) => ({
  inputTokens: input,
  cachedReadTokens: cachedRead,
  cacheCreationTokens: creation,
  outputTokens: output,
  reasoningTokens: reasoning,
  modelCalls: calls,
});

describe("store token counters", () => {
  it("carry a total with no split as unsplit, in no other counter", () => {
    const none = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    const total = tokensOf({ ...none, unsplit: 900 });
    expect(total).toMatchObject({ input: 0, output: 0, cacheRead: 0, unsplit: 900 });
    expect(noTokens(total)).toBe(false);
    expect("unsplit" in tokensOf(none)).toBe(false);
    expect(noTokens(tokensOf(none))).toBe(true);
  });
});

describe("Grok's session folders", () => {
  it("counts sessions, compactions and tokens per turn and model, by the day each turn ended", async () => {
    await grokSession(`${home}/code/app`, "id-canary-1", {
      summary: {
        created_at: "2026-11-20T23:50:00.123456789Z",
        current_model_id: "grok-4",
        generated_title: SECRET,
        git_remotes: ["git@github.com:Acme/App.git", "https://github.com/acme/app"],
      },
      usage: {
        turns: [
          {
            endedAt: "2026-11-20T23:59:00.500000000+00:00",
            modelUsage: { "grok-4": modelUsage(1000, 600, 100, 50, 20, 3) },
          },
          {
            endedAt: "2026-11-21T00:10:00.123456789+00:00",
            modelUsage: {
              "grok-4": modelUsage(500, 400, 0, 10, 0, 1),
              "grok-mini": modelUsage(200, 0, 0, 5, 0, 2),
            },
          },
          // A turn without tokens, as when it was cancelled before the model answered.
          { endedAt: "2026-11-21T00:20:00Z", inputTokens: 0, outputTokens: 0, modelCalls: 0 },
        ],
      },
      signals: { compactionCount: 2, contextTokensUsed: 1234 },
    });
    // No remotes: its folder is its project. No `modelUsage`: the turn's totals, under its model.
    await grokSession(`${home}/notes`, "id-canary-2", {
      summary: { created_at: "2026-11-22T08:00:00Z", session_kind: "headless" },
      usage: {
        turns: [
          {
            endedAt: "2026-11-22T08:01:00Z",
            primaryModelId: "grok-code",
            inputTokens: 10,
            outputTokens: 1,
          },
        ],
      },
    });
    // Last written before the window: not read.
    await grokSession(
      `${home}/old`,
      "id-canary-3",
      {
        summary: { created_at: "2026-10-30T08:00:00Z" },
        usage: {
          turns: [
            { endedAt: "2026-10-30T08:01:00Z", modelUsage: { m: modelUsage(9, 0, 0, 9, 0, 1) } },
          ],
        },
      },
      OLD,
    );

    const result = await scan([grok]);

    expect(parseScan(result)).toEqual(result);
    expect(result.sessions).toEqual([]);
    expect(tokenRows(result)).toEqual([
      { key: "grok cli 2026-11-20 acme/app main grok-4", counts: [3, 300, 50, 20, 600, 100] },
      { key: "grok cli 2026-11-21 acme/app main grok-4", counts: [1, 100, 10, 0, 400, 0] },
      { key: "grok cli 2026-11-21 acme/app main grok-mini", counts: [2, 200, 5, 0, 0, 0] },
      { key: "grok headless 2026-11-22 ~/notes main grok-code", counts: [1, 10, 1, 0, 0, 0] },
    ]);
    expect(sessionRows(result)).toEqual({
      "grok cli 2026-11-20 acme/app main": [1, 2, 1],
      "grok headless 2026-11-22 ~/notes main": [1, 0, 0],
    });
    expect(findCanary(result, [tmp, SECRET, "id-canary"])).toEqual([]);
  });
});

const sqlite = async (path: string, sql: string) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // A test database needs no sync to the disk after each insert.
  db.exec("PRAGMA synchronous = OFF");
  db.exec(sql);
  return db;
};

describe("OpenCode's database", () => {
  it("counts each session's sums on the day it was created, with its reasoning in its output", async () => {
    const db = await sqlite(
      `${home}/.local/share/opencode/opencode.db`,
      `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
        title TEXT, model TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER,
        time_updated INTEGER, time_compacting INTEGER)`,
    );
    const insert = db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const at = IN.getTime();
    const app = `${home}/code/app`;
    const model = JSON.stringify({ id: "claude-x", providerID: "anthropic", variant: "high" });
    insert.run("id-canary-1", "p", null, app, SECRET, model, 100, 10, 5, 50, 20, at, at, at + 1);
    insert.run(
      "id-canary-2",
      "p",
      "id-canary-1",
      app,
      SECRET,
      "gpt-y",
      7,
      3,
      0,
      0,
      0,
      at + 2,
      at,
      null,
    );
    insert.run("id-canary-3", "p", null, app, SECRET, model, 0, 0, 0, 0, 0, at + 3, at, null);
    insert.run(
      "id-canary-4",
      "p",
      null,
      app,
      SECRET,
      model,
      9,
      9,
      9,
      9,
      9,
      OLD.getTime(),
      at,
      null,
    );
    db.close();

    const result = await scan([opencode]);

    expect(parseScan(result)).toEqual(result);
    expect(tokenRows(result)).toEqual([
      { key: "opencode cli 2026-11-22 ~/code/app main claude-x", counts: [1, 100, 15, 5, 50, 20] },
      { key: "opencode cli 2026-11-22 ~/code/app subagent gpt-y", counts: [1, 7, 3, 0, 0, 0] },
    ]);
    expect(sessionRows(result)).toEqual({
      "opencode cli 2026-11-22 ~/code/app main": [2, 1, 1],
      "opencode cli 2026-11-22 ~/code/app subagent": [1, 0, 0],
    });
    expect(result.coverage.find((row) => row.harness === "opencode")?.unread).toBeUndefined();
    expect(findCanary(result, [tmp, SECRET, "id-canary"])).toEqual([]);
  });

  it("lists the database as unread when it cannot be read", async () => {
    await write(`${home}/.local/share/opencode/opencode.db`, "not a database\n");
    const result = await scan([opencode]);
    expect(result.coverage.find((row) => row.harness === "opencode")?.unread).toEqual([
      "opencode.db",
    ]);
    expect(result.usage).toBeUndefined();
  });
});

const T3_SCHEMA = `
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT);
CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT,
  default_provider TEXT, created_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY,
  thread_id TEXT, provider TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY,
  thread_id TEXT, provider_thread_id TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_turn_items (item_id TEXT PRIMARY KEY, thread_id TEXT,
  provider_thread_id TEXT, type TEXT, payload_json TEXT);
CREATE INDEX provider_turns_thread_idx ON orchestration_v2_projection_provider_turns(thread_id);
CREATE INDEX turn_items_thread_type_idx ON orchestration_v2_projection_turn_items(thread_id, type);
CREATE UNIQUE INDEX provider_turns_provider_thread_idx
  ON orchestration_v2_projection_provider_turns(provider_thread_id, provider_turn_id);
CREATE INDEX threads_provider_idx ON orchestration_v2_projection_threads(default_provider);`;

const usage = (input: number, cached: number, output: number, reasoning: number, creation = 0) =>
  JSON.stringify({
    text: SECRET,
    turnTokenUsage: {
      inputTokens: input,
      cachedInputTokens: cached,
      cacheCreationTokens: creation,
      outputTokens: output,
      reasoningTokens: reasoning,
    },
    tokenUsage: { inputTokens: 999_999 },
  });

const makeT3 = async () => {
  const db = await sqlite(`${home}/.t3/userdata/statev2.sqlite`, T3_SCHEMA);
  const project = db.prepare("INSERT INTO projection_projects VALUES (?,?,?)");
  project.run("id-canary-p1", SECRET, `${home}/code/app`);
  const thread = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?)");
  const providerThread = db.prepare(
    "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?)",
  );
  const turn = db.prepare(
    "INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?,?)",
  );
  const itemRow = db.prepare(
    "INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?)",
  );
  const item = (id: string, threadId: string, type: string, payloadJson: string) =>
    itemRow.run(id, threadId, `${threadId}-pt`, type, payloadJson);
  let turns = 0;
  /** A provider thread of a T3 thread, and its turns. */
  const addProviderThread = (
    threadId: string,
    providerThreadId: string,
    provider: string,
    payload: object,
    turnList: [string, string | null][],
  ) => {
    providerThread.run(
      providerThreadId,
      threadId,
      provider,
      JSON.stringify({ text: SECRET, ...payload }),
    );
    for (const [completed, payloadJson] of turnList) {
      turns += 1;
      turn.run(
        `id-canary-turn-${turns}`,
        threadId,
        providerThreadId,
        completed,
        completed,
        payloadJson ?? "{}",
      );
    }
  };
  const add = (
    id: string,
    provider: string,
    created: string,
    payload: object,
    projectId: string | null,
    turnList: [string, string | null][],
    providerPayload: object = {},
  ) => {
    thread.run(id, projectId, provider, created, JSON.stringify({ title: SECRET, ...payload }));
    addProviderThread(id, `${id}-pt`, provider, providerPayload, turnList);
  };
  const model = { modelSelection: { model: "gemini-x" } };
  add("id-canary-t1", "antigravity", "2026-11-20T10:00:00.000Z", model, "id-canary-p1", [
    ["2026-11-20T11:00:00.000Z", usage(1000, 700, 100, 40, 100)],
    ["2026-11-21T11:00:00.000Z", usage(300, 100, 20, 0)],
    // A turn T3 has no usage for.
    ["2026-11-21T12:00:00.000Z", null],
  ]);
  item("id-canary-i1", "id-canary-t1", "compaction", JSON.stringify({ text: SECRET }));
  item("id-canary-i2", "id-canary-t1", "compaction", "{}");
  item("id-canary-i3", "id-canary-t1", "assistant_message", JSON.stringify({ text: SECRET }));
  add(
    "id-canary-t2",
    "antigravity",
    "2026-11-21T10:00:00.000Z",
    { ...model, lineage: { parentThreadId: "id-canary-t1" }, worktreePath: `${home}/wt/x` },
    "id-canary-p1",
    [["2026-11-21T10:30:00.000Z", usage(50, 0, 5, 0)]],
  );
  // Started before the window; its turn in the window counts, its session does not.
  add("id-canary-t3", "antigravity", "2026-11-10T10:00:00.000Z", model, null, [
    ["2026-11-19T10:00:00.000Z", usage(40, 0, 4, 0)],
  ]);
  // A provider loadsheet has an adapter for, but no reader of the sessions of.
  add("id-canary-t4", "cursor", "2026-11-22T10:00:00.000Z", {}, "id-canary-p1", [
    ["2026-11-22T10:05:00.000Z", usage(10, 0, 2, 0)],
  ]);
  // Agents whose own files loadsheet reads: never counted from T3's copy. The Claude one names no
  // session, so it is never counted in place of its transcript either.
  for (const provider of ["claudeAgent", "codex", "grok", "opencode"]) {
    add(`id-canary-${provider}`, provider, "2026-11-22T10:00:00.000Z", model, "id-canary-p1", [
      ["2026-11-22T10:05:00.000Z", usage(5000, 0, 500, 0)],
    ]);
  }
  return { db, add, addProviderThread, item };
};

describe("T3 Code's database", () => {
  it("counts the threads of the agents loadsheet does not read, per turn", async () => {
    // Open while read, as T3 keeps it: its newest rows are in the WAL.
    const { db } = await makeT3();
    db.exec("PRAGMA journal_mode = WAL");
    try {
      const result = await scan([], sessionStores);

      expect(parseScan(result)).toEqual(result);
      expect(result.sessions).toEqual([]);
      expect(result.coverage).toEqual([]);
      expect(tokenRows(result)).toEqual([
        {
          key: "antigravity t3-code 2026-11-19 unknown main gemini-x",
          counts: [1, 40, 4, 0, 0, 0],
        },
        {
          key: "antigravity t3-code 2026-11-20 ~/code/app main gemini-x",
          counts: [1, 200, 100, 40, 700, 100],
        },
        {
          key: "antigravity t3-code 2026-11-21 ~/code/app main gemini-x",
          counts: [1, 200, 20, 0, 100, 0],
        },
        {
          key: "antigravity t3-code 2026-11-21 ~/wt/x subagent gemini-x",
          counts: [1, 50, 5, 0, 0, 0],
        },
        { key: "cursor t3-code 2026-11-22 ~/code/app main unknown", counts: [1, 10, 2, 0, 0, 0] },
      ]);
      expect(sessionRows(result)).toEqual({
        "antigravity t3-code 2026-11-20 ~/code/app main": [1, 2, 1],
        "antigravity t3-code 2026-11-21 ~/wt/x subagent": [1, 0, 0],
        "cursor t3-code 2026-11-22 ~/code/app main": [1, 0, 0],
      });
      expect(findCanary(result, [tmp, SECRET, "id-canary", "999999"])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("reaches each thread's turns and items through their indexes", async () => {
    const { db } = await makeT3();
    try {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${t3Code.query}`)
        .all({ $since: "2026-11-18T00:00:00.000Z", $native: "[]" })
        .map((row) => String(row.detail));
      expect(plan.some((detail) => /provider_turns_thread_idx/u.test(detail))).toBe(true);
      expect(plan.some((detail) => /turn_items_thread_type_idx/u.test(detail))).toBe(true);
      expect(plan.some((detail) => /provider_turns_provider_thread_idx/u.test(detail))).toBe(true);
      expect(plan.some((detail) => /^SCAN (pt|ti)\b/u.test(detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("backfills a Claude session whose transcript is gone, skips a listed one", async () => {
    const { db, add, addProviderThread, item } = await makeT3();
    const claude = { modelSelection: { model: "claude-x" } };
    const ref = (nativeId: string, createdAt: string) => ({
      nativeThreadRef: { driver: "claudeAgent", nativeId },
      createdAt,
    });
    // Its transcript is gone: its turns, session and compaction count, via T3.
    add(
      "id-canary-c1",
      "claudeAgent",
      "2026-11-20T08:00:00.000Z",
      claude,
      "id-canary-p1",
      [
        ["2026-11-21T09:30:00.000Z", usage(1000, 600, 50, 10, 100)],
        ["2026-11-22T09:30:00.000Z", usage(400, 300, 20, 0)],
      ],
      ref("id-canary-gone-1", "2026-11-21T09:00:00.000Z"),
    );
    item("id-canary-i4", "id-canary-c1", "compaction", "{}");
    // Its transcript is listed below: the transcript counts it, not T3.
    add(
      "id-canary-c2",
      "claudeAgent",
      "2026-11-21T08:00:00.000Z",
      claude,
      "id-canary-p1",
      [["2026-11-21T08:30:00.000Z", usage(7000, 0, 700, 0)]],
      ref("id-canary-listed", "2026-11-21T08:00:00.000Z"),
    );
    // A subagent's thread.
    add(
      "id-canary-c3",
      "claudeAgent",
      "2026-11-22T08:00:00.000Z",
      { ...claude, lineage: { parentThreadId: "id-canary-c1" } },
      "id-canary-p1",
      [["2026-11-22T08:30:00.000Z", usage(80, 0, 8, 0)]],
      ref("id-canary-gone-2", "2026-11-22T08:00:00.000Z"),
    );
    // A Codex thread switched to Claude: only its Claude provider thread counts, under no model,
    // since the thread's model is Codex's.
    add(
      "id-canary-s1",
      "codex",
      "2026-11-22T11:00:00.000Z",
      { modelSelection: { model: "gpt-x" } },
      "id-canary-p1",
      [["2026-11-22T11:05:00.000Z", usage(9000, 0, 900, 0)]],
    );
    addProviderThread(
      "id-canary-s1",
      "id-canary-s1-claude",
      "claudeAgent",
      ref("id-canary-gone-3", "2026-11-22T12:00:00.000Z"),
      [["2026-11-22T12:05:00.000Z", usage(30, 10, 3, 0)]],
    );
    db.close();
    const transcript = `${home}/.claude/projects/-code-app/id-canary-listed.jsonl`;
    await write(transcript, '{"type":"summary"}\n');
    await NodeFSP.utimes(transcript, IN, IN);

    const result = await scan([claudeCode], sessionStores);

    expect(parseScan(result)).toEqual(result);
    expect(tokenRows(result).filter((row) => row.key.startsWith("claude-code"))).toEqual([
      {
        key: "claude-code t3-code 2026-11-21 ~/code/app main claude-x",
        counts: [1, 300, 50, 10, 600, 100],
      },
      {
        key: "claude-code t3-code 2026-11-22 ~/code/app main claude-x",
        counts: [1, 100, 20, 0, 300, 0],
      },
      {
        key: "claude-code t3-code 2026-11-22 ~/code/app main unknown",
        counts: [1, 20, 3, 0, 10, 0],
      },
      {
        key: "claude-code t3-code 2026-11-22 ~/code/app subagent claude-x",
        counts: [1, 80, 8, 0, 0, 0],
      },
    ]);
    const sessions = sessionRows(result);
    expect(
      Object.fromEntries(Object.entries(sessions).filter(([key]) => key.startsWith("claude-code"))),
    ).toEqual({
      "claude-code t3-code 2026-11-21 ~/code/app main": [1, 1, 1],
      "claude-code t3-code 2026-11-22 ~/code/app main": [1, 0, 0],
      "claude-code t3-code 2026-11-22 ~/code/app subagent": [1, 0, 0],
    });
    expect(findCanary(result, [tmp, SECRET, "id-canary", "999999"])).toEqual([]);

    // Without Claude Code's transcripts listed, T3 does not stand in for them.
    const unlisted = await scan([], sessionStores);
    expect(tokenRows(unlisted).some((row) => row.key.startsWith("claude-code"))).toBe(false);
  });

  it("gets a Coverage row only to say it could not be read", async () => {
    await write(`${home}/.t3/userdata/statev2.sqlite`, "not a database\n");
    const result = await scan([], sessionStores);
    expect(parseScan(result)).toEqual(result);
    expect(result.coverage).toEqual([
      expect.objectContaining({ harness: "t3-code", installed: false, unread: ["statev2.sqlite"] }),
    ]);
  });
});

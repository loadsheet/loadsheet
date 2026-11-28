import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findCanary } from "@loadsheet/fixtures";
import type { Harness } from "@loadsheet/kit";
import { scanMachine } from "@loadsheet/kit/node";
import { parseScan, type Scan } from "@loadsheet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { claudeCode, codex, grok, opencode, sessionStores, t3Code } from "../src/index.ts";
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
CREATE INDEX threads_provider_idx ON orchestration_v2_projection_threads(default_provider);
CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT,
  resume_cursor_json TEXT, runtime_payload_json TEXT);`;

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

/** T3 Code's usage cache: each file's records, `[at, model, session, uncached, cached, creation, output, reasoning, key, cost, speed, rate model, tier, 1h, calls]`. */
const scanCache = (
  files: Record<string, { r?: unknown[]; t?: unknown[]; p?: string }>,
  version = 17,
) =>
  write(`${home}/.t3/userdata/usage-scan-cache-v${version}.json`, {
    files: Object.fromEntries(
      Object.entries(files).map(([path, { r = [], t = [], p = "claude" }]) => [
        path,
        { s: 1, m: 1, p, r, t, mr: 0, o: 0, gl: 0, gh: 0, cs: null },
      ]),
    ),
    version,
    models: ["claude-x", "<synthetic>", "gpt-z"],
    sessions: ["id-canary-session"],
  });
const request = (
  iso: string,
  [uncached, cached, creation, output]: number[],
  key: string | null,
  { hour = 0, calls = 1, model = 0 } = {},
) => [
  Date.parse(iso),
  model,
  0,
  uncached,
  cached,
  creation,
  output,
  0,
  key,
  null,
  0,
  null,
  null,
  hour,
  calls,
];

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
        .all({ $since: "2026-11-18T00:00:00.000Z", $native: "[]", $scanCache: "[]" })
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

  const claudeRef = (nativeId: string) => ({
    nativeThreadRef: { driver: "claudeAgent", nativeId },
    createdAt: "2026-11-20T08:00:00.000Z",
  });
  /** Claude Code's folder for a project: every character but a letter or digit as `-`. */
  const folderOf = (path: string) => path.replace(/[^a-zA-Z0-9]/gu, "-");
  const claudeRows = (result: Scan) =>
    tokenRows(result).filter((row) => row.key.startsWith("claude-code"));
  const claudeSessions = (result: Scan) =>
    Object.fromEntries(
      Object.entries(sessionRows(result)).filter(([key]) => key.startsWith("claude-code")),
    );
  const listTranscript = async (id: string) => {
    const transcript = `${home}/.claude/projects/-code-app/${id}.jsonl`;
    await write(transcript, '{"type":"summary"}\n');
    await NodeFSP.utimes(transcript, IN, IN);
  };

  it("backfills a gone Claude session from T3's scan cache with its subagents", async () => {
    const { db, add } = await makeT3();
    const claude = { modelSelection: { model: "claude-x" } };
    // T3 drove it: its project and compactions come from T3, its tokens from the cache.
    add(
      "id-canary-c1",
      "claudeAgent",
      "2026-11-20T08:00:00.000Z",
      claude,
      "id-canary-p1",
      [["2026-11-21T09:30:00.000Z", usage(9000, 0, 900, 0)]],
      claudeRef("id-canary-gone-1"),
    );
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?)").run(
      "id-canary-i9",
      "id-canary-c1",
      "id-canary-c1-pt",
      "compaction",
      "{}",
    );
    // Its runtime record names the resumed session's folder.
    db.prepare("INSERT INTO provider_session_runtime VALUES (?,?,?,?)").run(
      "id-canary-r1",
      "claudeAgent",
      JSON.stringify({ resume: "id-canary-gone-3", threadId: SECRET }),
      JSON.stringify({ cwd: `${home}/code/other`, lastError: SECRET }),
    );
    db.close();
    const app = `${home}/.claude/projects/${folderOf(`${home}/code/app`)}`;
    await scanCache({
      [`${app}/id-canary-gone-1.jsonl`]: {
        r: [
          request("2026-11-21T09:00:00.000Z", [10, 600, 50, 100], "id-canary-k1", { hour: 20 }),
          // Ten minutes later on the same model: its 5-minute write is written again.
          request("2026-11-21T09:10:00.000Z", [5, 700, 30, 40], "id-canary-k2"),
          // A local placeholder that never reached the API.
          request("2026-11-21T09:11:00.000Z", [1, 1, 1, 1], "id-canary-k0", { model: 1 }),
        ],
      },
      [`${app}/id-canary-gone-1/subagents/agent-id-canary-a.jsonl`]: {
        r: [request("2026-11-21T09:05:00.000Z", [3, 100, 10, 20], "id-canary-k3", { calls: 2 })],
      },
      // A workflow's subagent, its last record in the unterminated tail.
      [`${app}/id-canary-gone-1/subagents/workflows/id-canary-w/agent-id-canary-b.jsonl`]: {
        t: [request("2026-11-22T09:05:00.000Z", [2, 0, 0, 2], null)],
      },
      // A resumed copy: the copied request counts once, at its largest, in the first file.
      [`${app}/id-canary-gone-2.jsonl`]: {
        r: [
          request("2026-11-21T09:00:00.000Z", [10, 600, 50, 130], "id-canary-k1", { hour: 20 }),
          request("2026-11-22T10:00:00.000Z", [1, 2, 3, 4], "id-canary-k5"),
        ],
      },
      // A listed transcript's request, and a gone file's copy of it, which the transcript counts.
      [`${home}/.claude/projects/-code-app/id-canary-listed.jsonl`]: {
        r: [request("2026-11-22T08:00:00.000Z", [7, 7, 7, 7], "id-canary-k6")],
      },
      [`${home}/.claude/projects/-elsewhere/id-canary-gone-3.jsonl`]: {
        r: [
          request("2026-11-22T08:00:00.000Z", [7, 7, 7, 7], "id-canary-k6"),
          request("2026-11-22T08:01:00.000Z", [1, 0, 0, 1], "id-canary-k7"),
        ],
      },
      [`${home}/.claude/projects/-elsewhere/id-canary-gone-4.jsonl`]: {
        r: [request("2026-11-22T08:00:00.000Z", [1, 0, 0, 1], "id-canary-k8")],
      },
      // Another provider's file is left to that provider.
      [`${home}/.codex/sessions/rollout-id-canary-x.jsonl`]: {
        p: "codex",
        r: [request("2026-11-22T08:00:00.000Z", [5, 5, 0, 5], "id-canary-k9")],
      },
    });
    await listTranscript("id-canary-listed");

    const result = await scan([claudeCode], sessionStores);

    expect(parseScan(result)).toEqual(result);
    expect(claudeRows(result)).toEqual([
      {
        key: "claude-code t3-code 2026-11-21 ~/code/app main claude-x",
        counts: [2, 15, 170, 0, 1300, 80],
      },
      {
        key: "claude-code t3-code 2026-11-21 ~/code/app subagent claude-x",
        counts: [2, 3, 20, 0, 100, 10],
      },
      {
        key: "claude-code t3-code 2026-11-22 ~/code/app subagent claude-x",
        counts: [1, 2, 2, 0, 0, 0],
      },
      {
        key: "claude-code t3-code 2026-11-22 ~/code/other main claude-x",
        counts: [1, 1, 1, 0, 0, 0],
      },
      { key: "claude-code unknown 2026-11-22 unknown main claude-x", counts: [1, 1, 1, 0, 0, 0] },
      {
        key: "claude-code unknown 2026-11-22 ~/code/app main claude-x",
        counts: [1, 1, 4, 0, 2, 3],
      },
    ]);
    const split = result.usage!.tokens.find(
      (cell) =>
        cell.harness === "claude-code" && cell.thread === "main" && cell.day === "2026-11-21",
    );
    expect([split?.cacheWrite5m, split?.cacheWrite1h, split?.cacheRewrite]).toEqual([60, 20, 30]);
    expect(claudeSessions(result)).toEqual({
      "claude-code t3-code 2026-11-21 ~/code/app main": [1, 1, 1],
      "claude-code t3-code 2026-11-21 ~/code/app subagent": [1, 0, 0],
      "claude-code t3-code 2026-11-22 ~/code/app subagent": [1, 0, 0],
      "claude-code t3-code 2026-11-22 ~/code/other main": [1, 0, 0],
      "claude-code unknown 2026-11-21 ~/code/app main": [1, 0, 0],
      "claude-code unknown 2026-11-22 unknown main": [1, 0, 0],
    });
    expect(findCanary(result, [tmp, SECRET, "id-canary", "999999"])).toEqual([]);
  });

  it("prefers the transcript, then the scan cache, then T3's turns", async () => {
    const { db, add } = await makeT3();
    const claude = { modelSelection: { model: "claude-x" } };
    const turns: [string, string][] = [["2026-11-21T09:30:00.000Z", usage(9000, 0, 900, 0)]];
    for (const [id, session] of [
      ["id-canary-a", "id-canary-listed"],
      ["id-canary-b", "id-canary-cached"],
      ["id-canary-c", "id-canary-turns"],
    ] as const) {
      add(
        id,
        "claudeAgent",
        "2026-11-20T08:00:00.000Z",
        claude,
        "id-canary-p1",
        turns,
        claudeRef(session),
      );
    }
    db.close();
    const app = `${home}/.claude/projects/-code-app`;
    await scanCache({
      [`${app}/id-canary-listed.jsonl`]: {
        r: [request("2026-11-21T09:00:00.000Z", [7, 0, 0, 7], "id-canary-k1")],
      },
      [`${app}/id-canary-cached.jsonl`]: {
        r: [request("2026-11-21T09:00:00.000Z", [5, 0, 0, 5], "id-canary-k2")],
      },
    });
    await listTranscript("id-canary-listed");

    const result = await scan([claudeCode], sessionStores);

    // The cached session's tokens are the cache's, the third's T3's turn; the listed one is neither.
    expect(claudeRows(result)).toEqual([
      {
        key: "claude-code t3-code 2026-11-21 ~/code/app main claude-x",
        counts: [2, 5 + 9000, 5 + 900, 0, 0, 0],
      },
    ]);
    expect(claudeSessions(result)).toEqual({
      "claude-code t3-code 2026-11-20 ~/code/app main": [1, 0, 0],
      "claude-code t3-code 2026-11-21 ~/code/app main": [1, 0, 0],
    });
    expect(findCanary(result, [tmp, SECRET, "id-canary", "999999"])).toEqual([]);
  });

  it("a missing scan cache leaves T3's turns", async () => {
    const { db, add } = await makeT3();
    add(
      "id-canary-c1",
      "claudeAgent",
      "2026-11-20T08:00:00.000Z",
      { modelSelection: { model: "claude-x" } },
      "id-canary-p1",
      [["2026-11-21T09:30:00.000Z", usage(400, 300, 20, 0)]],
      claudeRef("id-canary-gone-1"),
    );
    db.close();
    await listTranscript("id-canary-listed");
    const expected = [
      {
        key: "claude-code t3-code 2026-11-21 ~/code/app main claude-x",
        counts: [1, 100, 20, 0, 300, 0],
      },
    ];

    const missing = await scan([claudeCode], sessionStores);
    expect(claudeRows(missing)).toEqual(expected);
    expect(missing.coverage.find((row) => row.harness === "claude-code")?.unread).toBeUndefined();
    // One that cannot be parsed leaves them too, and says the store was not wholly read.
    await write(`${home}/.t3/userdata/usage-scan-cache-v17.json`, '{"files":{');
    const broken = await scan([claudeCode], sessionStores);
    expect(claudeRows(broken)).toEqual(expected);
    expect(broken.coverage.map((row) => [row.harness, row.unread])).toEqual([
      ["claude-code", ["statev2.sqlite"]],
      ["t3-code", ["statev2.sqlite"]],
    ]);
  });

  it("reads the scan cache's versions 17 and 18, and lists another as unread", async () => {
    const { db } = await makeT3();
    db.close();
    await listTranscript("id-canary-listed");
    const files = {
      [`${home}/.claude/projects/-code-app/id-canary-gone.jsonl`]: {
        r: [request("2026-11-21T09:00:00.000Z", [5, 0, 0, 5], "id-canary-k1")],
      },
    };
    const read = async (version: number) => {
      for (const name of await NodeFSP.readdir(`${home}/.t3/userdata`)) {
        if (name.startsWith("usage-scan-cache")) await NodeFSP.rm(`${home}/.t3/userdata/${name}`);
      }
      await scanCache(files, version);
      const result = await scan([claudeCode], sessionStores);
      return [
        claudeRows(result).map((row) => row.counts),
        result.coverage.find((row) => row.harness === "claude-code")?.unread,
      ];
    };

    expect(await read(17)).toEqual([[[1, 5, 5, 0, 0, 0]], undefined]);
    expect(await read(18)).toEqual([[[1, 5, 5, 0, 0, 0]], undefined]);
    expect(await read(19)).toEqual([[], ["statev2.sqlite"]]);
    expect(await read(16)).toEqual([[], ["statev2.sqlite"]]);
  });

  it("counts a gone main transcript from the cache and its listed subagent from its file", async () => {
    const { db } = await makeT3();
    db.close();
    const app = `${home}/.claude/projects/-code-app`;
    await scanCache({
      [`${app}/id-canary-s.jsonl`]: {
        r: [request("2026-11-21T09:00:00.000Z", [5, 0, 0, 5], "id-canary-k1")],
      },
      [`${app}/id-canary-s/subagents/agent-id-canary-a.jsonl`]: {
        r: [request("2026-11-21T09:05:00.000Z", [70, 0, 0, 70], "id-canary-k2")],
      },
    });
    // The subagent's transcript is listed; it holds no usage, so any here would be the cache's.
    await listTranscript("id-canary-s/subagents/agent-id-canary-a");

    const result = await scan([claudeCode], sessionStores);

    expect(claudeRows(result)).toEqual([
      { key: "claude-code unknown 2026-11-21 unknown main claude-x", counts: [1, 5, 5, 0, 0, 0] },
    ]);
    expect(findCanary(result, [tmp, "id-canary"])).toEqual([]);
  });

  it("counts a listed main transcript from its file and its gone subagent from the cache", async () => {
    const { db } = await makeT3();
    db.close();
    const app = `${home}/.claude/projects/-code-app`;
    await scanCache({
      [`${app}/id-canary-s.jsonl`]: {
        r: [request("2026-11-21T09:00:00.000Z", [5, 0, 0, 5], "id-canary-k1")],
      },
      [`${app}/id-canary-s/subagents/agent-id-canary-a.jsonl`]: {
        r: [request("2026-11-21T09:05:00.000Z", [70, 0, 0, 70], "id-canary-k2")],
      },
    });
    await listTranscript("id-canary-s");

    const result = await scan([claudeCode], sessionStores);

    expect(claudeRows(result)).toEqual([
      {
        key: "claude-code unknown 2026-11-21 unknown subagent claude-x",
        counts: [1, 70, 70, 0, 0, 0],
      },
    ]);
    expect(findCanary(result, [tmp, "id-canary"])).toEqual([]);
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

/** A Codex state database with the columns the store reads, and the ids, titles and messages it must not. */
const makeCodexState = async (file = "state_5.sqlite") => {
  const db = await sqlite(
    `${home}/.codex/${file}`,
    `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
      source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
      git_origin_url TEXT, first_user_message TEXT NOT NULL DEFAULT '', model TEXT,
      created_at_ms INTEGER, thread_source TEXT, originator TEXT)`,
  );
  const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const row = (
    id: string,
    at: Date,
    thread: { source: string; threadSource: string | null; originator: string | null },
    tokens: number,
    remote: string | null,
  ) =>
    insert.run(
      id,
      `${home}/.codex/sessions/rollout-${id}.jsonl`,
      Math.floor(at.getTime() / 1000),
      thread.source,
      `${home}/code/app`,
      SECRET,
      tokens,
      remote,
      SECRET,
      "gpt-z",
      at.getTime(),
      thread.threadSource,
      thread.originator,
    );
  return { db, row };
};

const codexRollout = async (id: string, iso: string) => {
  const stamp = iso.slice(0, 19).replaceAll(":", "-");
  const lines = [
    {
      timestamp: iso,
      type: "session_meta",
      payload: {
        id,
        timestamp: iso,
        cwd: `${home}/code/app`,
        originator: "codex_cli_rs",
        source: "cli",
      },
    },
    {
      timestamp: iso,
      type: "event_msg",
      payload: { type: "task_started", started_at: Math.floor(Date.parse(iso) / 1000) },
    },
    {
      timestamp: iso,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: 110,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: 110,
          },
        },
      },
    },
  ];
  await write(
    `${home}/.codex/sessions/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/rollout-${stamp}-${id}.jsonl`,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
};

const unsplitRows = (result: Scan) =>
  result.usage!.tokens.map(
    (cell: TokenCell) =>
      `${cell.harness} ${cell.via} ${cell.day} ${cell.project} ${cell.thread} ${cell.model} ${cell.requests} ${cell.input + cell.output + cell.cacheRead + cell.cacheWrite} ${cell.unsplit ?? 0}`,
  );

describe("Codex's state database", () => {
  const plain = { source: "vscode", threadSource: null, originator: "T3 Code" };
  const spawned = {
    source: JSON.stringify({
      subagent: { thread_spawn: { parent_thread_id: "id-canary-parent", depth: 1 } },
    }),
    threadSource: "subagent",
    originator: "codex_exec",
  };

  it("counts a thread whose rollout is gone as unsplit on its created day, with originator as via", async () => {
    const { db, row } = await makeCodexState();
    row("id-canary-gone-1", IN, plain, 5000, "git@github.com:acme/app.git");
    row("id-canary-gone-2", new Date("2026-11-21T23:59:00.000Z"), spawned, 700, null);
    row(
      "id-canary-gone-3",
      new Date("2026-11-21T08:00:00.000Z"),
      { ...plain, originator: null },
      0,
      null,
    );
    row("id-canary-old", OLD, plain, 9999, null);
    db.close();

    const result = await scan([codex]);

    expect(parseScan(result)).toEqual(result);
    expect(result.sessions).toEqual([]);
    expect(unsplitRows(result)).toEqual([
      "codex codex_exec 2026-11-21 ~/code/app subagent gpt-z 0 0 700",
      "codex T3 Code 2026-11-22 acme/app main gpt-z 0 0 5000",
    ]);
    expect(sessionRows(result)).toEqual({
      "codex codex_exec 2026-11-21 ~/code/app subagent": [1, 0, 0],
      "codex vscode 2026-11-21 ~/code/app main": [1, 0, 0],
      "codex T3 Code 2026-11-22 acme/app main": [1, 0, 0],
    });
    expect(findCanary(result, [tmp, SECRET, "id-canary"])).toEqual([]);
  });

  it("skips a thread whose rollout is listed", async () => {
    const id = "019a0000-0000-7000-8000-00000000c0de";
    await codexRollout(id, "2026-11-22T10:00:00.000Z");
    const { db, row } = await makeCodexState();
    row(id, IN, { source: "cli", threadSource: "user", originator: "codex_cli_rs" }, 110, null);
    row("id-canary-gone", IN, plain, 5000, null);
    db.close();

    const result = await scan([codex]);

    expect(parseScan(result)).toEqual(result);
    expect(unsplitRows(result)).toEqual([
      "codex T3 Code 2026-11-22 ~/code/app main gpt-z 0 0 5000",
      "codex codex_cli_rs 2026-11-22 ~/code/app main unknown 1 110 0",
    ]);
    expect(sessionRows(result)).toEqual({
      "codex codex_cli_rs 2026-11-22 ~/code/app main": [1, 0, 0],
      "codex T3 Code 2026-11-22 ~/code/app main": [1, 0, 0],
    });
    expect(findCanary(result, [tmp, SECRET, "id-canary", id])).toEqual([]);
  });

  it("reads the newest Codex state database", async () => {
    const old = await makeCodexState("state_4.sqlite");
    old.row("id-canary-stale", IN, plain, 4444, null);
    old.db.close();
    const newest = await makeCodexState("state_5.sqlite");
    newest.row("id-canary-gone", IN, plain, 5000, null);
    newest.db.close();
    // A name that only looks like a version is not read.
    await write(`${home}/.codex/state_9.sqlite.bak`, "not a database\n");

    const result = await scan([codex]);

    expect(unsplitRows(result)).toEqual([
      "codex T3 Code 2026-11-22 ~/code/app main gpt-z 0 0 5000",
    ]);
    expect(result.coverage.find((row) => row.harness === "codex")?.unread).toBeUndefined();
  });

  it("no state database is not unread", async () => {
    await write(`${home}/.codex/config.toml`, "");
    const result = await scan([codex]);
    expect(result.usage?.tokens ?? []).toEqual([]);
    expect(result.coverage.find((row) => row.harness === "codex")?.unread).toBeUndefined();
  });

  it("backfills nothing when Codex's rollouts were not listed", async () => {
    const { db, row } = await makeCodexState();
    row("id-canary-gone", IN, plain, 5000, null);
    db.close();
    const result = await scan([]);
    expect(result.usage?.tokens ?? []).toEqual([]);
  });
});

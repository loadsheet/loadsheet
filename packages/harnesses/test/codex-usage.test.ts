import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findCanary } from "@loadsheet/fixtures";
import { memoryFiles, type Fact, type Place } from "@loadsheet/kit";
import { readTranscript, scanMachine, type ReadPosition } from "@loadsheet/kit/node";
import { parseScan } from "@loadsheet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { codex, codexTranscripts, readCodexConfig } from "../src/index.ts";

const place: Place = { home: "/home/u", env: {} };
const at = (time: string, day = "2026-11-10") => `${day}T${time}.000Z`;

/** Runs lines through the format the way readTranscript does, markers and place included. */
const parseAll = (lines: unknown[]) => {
  const state = codexTranscripts.initial();
  const facts: Fact[] = [];
  for (const value of lines) {
    const line = typeof value === "string" ? value : JSON.stringify(value);
    if (!codexTranscripts.markers.some((marker) => line.includes(marker))) continue;
    facts.push(...codexTranscripts.parse(line, state, place));
  }
  return { facts, state };
};

const meta = (payload: Record<string, unknown> = {}) => ({
  timestamp: at("09:59:00"),
  type: "session_meta",
  payload: {
    id: "session-id-1234",
    timestamp: at("09:59:00"),
    cwd: "/home/u/work/app",
    originator: "codex_cli_rs",
    cli_version: "0.171.0",
    source: "cli",
    ...payload,
  },
});
const started = (iso: string) => ({
  timestamp: iso,
  type: "event_msg",
  payload: { type: "task_started", turn_id: "t", started_at: Math.floor(Date.parse(iso) / 1000) },
});
const context = (model: string, time = "10:00:00") => ({
  timestamp: at(time),
  type: "turn_context",
  payload: { cwd: "/home/u/work/app", model, user_instructions: "Secret instructions." },
});
const usage = (input: number, cached: number, output: number, reasoning = 0, write?: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  ...(write === undefined ? {} : { cache_write_input_tokens: write }),
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
type Usage = ReturnType<typeof usage>;
const tokens = (timestamp: string, total: Usage | undefined, last?: Usage) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last, model_context_window: 258_400 },
    rate_limits: {},
  },
});
const compacted = (time: string, day?: string) => ({
  timestamp: at(time, day),
  type: "compacted",
  payload: { message: "Summary of secret work.", replacement_history: [meta().payload] },
});

const usageOf = (facts: readonly Fact[]) =>
  facts.flatMap((fact) => (fact.type === "usage-tokens" ? [fact] : []));
const sum = (facts: readonly Fact[]) => {
  const out = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  for (const fact of usageOf(facts)) {
    out.input += fact.input;
    out.cacheRead += fact.cacheRead;
    out.cacheWrite += fact.cacheWrite;
    out.output += fact.output;
    out.reasoning += fact.reasoning;
  }
  return out;
};

/**
 * A main session over two UTC days, counted by hand: 1,000 then 2,000 then 500 input tokens, of
 * them 200, 1,000 and 400 read from the cache and 100 written to it; a repeated event; a model
 * switch; two compactions.
 */
const SESSION = [
  meta({ git: { repository_url: "https://user:token@github.com/Owner/Repo.git" } }),
  started(at("10:00:00")),
  tokens(at("10:00:01"), undefined),
  context("gpt-6"),
  tokens(at("10:00:05"), usage(1000, 200, 50, 10), usage(1000, 200, 50, 10)),
  tokens(at("10:00:09"), usage(3000, 1200, 120, 30), usage(2000, 1000, 70, 20)),
  // Codex writes the same totals again after a turn ends.
  tokens(at("10:00:09"), usage(3000, 1200, 120, 30), usage(2000, 1000, 70, 20)),
  compacted("23:00:00"),
  context("gpt-6-mini", "23:59:59"),
  context("not a model name"),
  tokens(
    at("00:00:05", "2026-11-11"),
    usage(3500, 1600, 150, 30, 100),
    usage(500, 400, 30, 0, 100),
  ),
  compacted("00:10:00", "2026-11-11"),
];

const base = { via: "codex_cli_rs", project: "owner/repo", thread: "main" };
const zero = { cacheWrite5m: 0, cacheWrite1h: 0, cacheRewrite: 0 };

const call = (time: string, payload: Record<string, unknown>) => ({
  timestamp: at(time),
  type: "response_item",
  payload: {
    type: "function_call",
    arguments: '{"cmd":"cat secret.txt"}',
    call_id: "c",
    ...payload,
  },
});
const ended = (iso: string, type: string, extra: Record<string, unknown> = {}) => ({
  timestamp: iso,
  type: "event_msg",
  payload: { type, turn_id: "t", ...extra },
});
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const limits = (
  timestamp: string,
  total: Usage,
  last: Usage,
  rateLimits: Record<string, unknown>,
) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last, model_context_window: 258_400 },
    rate_limits: {
      plan_type: "secret-plan",
      credits: { balance: "secret-credits" },
      ...rateLimits,
    },
  },
});
const window = (used: number, minutes: number, resets: string) => ({
  used_percent: used,
  window_minutes: minutes,
  resets_at: seconds(resets),
});

/**
 * Two tasks: the first completes after 65 s with seven tool calls (two MCP tools, one name that is
 * not a tool's, two subagent starts and a local shell); the second starts before midnight, reaches
 * the five-hour limit after it, and is stopped by the user.
 */
const TURNS = [
  meta(),
  context("gpt-6"),
  started(at("10:00:00")),
  call("10:00:01", { name: "exec_command" }),
  call("10:00:02", { name: "search", namespace: "mcp__executor" }),
  call("10:00:03", { name: "mcp__linear__list_issues" }),
  call("10:00:04", { name: "cat ~/secret" }),
  call("10:00:05", { name: "spawn_agent" }),
  call("10:00:06", { name: "spawn_agent" }),
  {
    timestamp: at("10:00:06"),
    type: "response_item",
    payload: { type: "local_shell_call", call_id: "c", action: { command: ["ls", "secret"] } },
  },
  limits(at("10:00:07"), usage(100, 0, 10), usage(100, 0, 10), {
    primary: window(40, 300, at("14:00:00")),
    secondary: window(10, 10_080, at("00:00:00", "2026-11-14")),
    rate_limit_reached_type: null,
  }),
  ended(at("10:01:05"), "task_complete", { duration_ms: 65_000 }),
  started(at("23:59:30")),
  limits(at("00:00:10", "2026-11-11"), usage(300, 0, 30), usage(200, 0, 20), {
    primary: window(100, 300, at("04:00:00", "2026-11-11")),
    secondary: window(12, 10_080, at("00:00:00", "2026-11-14")),
    rate_limit_reached_type: "primary",
  }),
  // The limit still holds: the same totals and the same reach, read again.
  limits(at("00:00:20", "2026-11-11"), usage(300, 0, 30), usage(200, 0, 20), {
    primary: window(100, 300, at("04:00:00", "2026-11-11")),
    secondary: window(12, 10_080, at("00:00:00", "2026-11-14")),
    rate_limit_reached_type: "primary",
  }),
  ended(at("00:00:30", "2026-11-11"), "turn_aborted", { reason: "interrupted" }),
];

const ofType = <T extends Fact["type"]>(facts: readonly Fact[], type: T) =>
  facts.filter((fact): fact is Extract<Fact, { type: T }> => fact.type === type);

/** Adds the counters of Facts that share a key, as the Accumulator does. */
const summed = (facts: readonly Fact[], key: (fact: Fact) => string) => {
  const out: Record<string, Record<string, number>> = {};
  for (const fact of facts) {
    const cell = (out[key(fact)] ??= {});
    for (const [name, value] of Object.entries(fact)) {
      if (typeof value === "number" && name !== "hour" && name !== "windowMinutes")
        cell[name] = (cell[name] ?? 0) + value;
    }
  }
  return out;
};

describe("codex turns, hours, tools and limits", () => {
  it("counts each task on the day it started, timed, interrupted, with its tool calls", () => {
    const turns = ofType(parseAll(TURNS).facts, "usage-turn");
    expect(turns.every((fact) => fact.day === "2026-11-10")).toBe(true);
    expect(turns.every((fact) => fact.project === "~/work/app" && fact.thread === "main")).toBe(
      true,
    );
    expect(summed(turns, (fact) => fact.type)).toEqual({
      "usage-turn": {
        turns: 2,
        timed: 1,
        durationMs: 65_000,
        interrupted: 1,
        toolCalls: 7,
        withSubagents: 1,
      },
    });
  });

  it("times a task by its start and end when it has no duration", () => {
    const turns = ofType(
      parseAll([
        meta(),
        started(at("10:00:00")),
        ended(at("10:00:09"), "task_complete", {
          started_at: seconds(at("10:00:00")),
          completed_at: seconds(at("10:00:09")),
        }),
        started(at("10:01:00")),
        ended(at("10:01:09"), "task_complete"),
      ]).facts,
      "usage-turn",
    );
    expect(summed(turns, () => "all")).toEqual({ all: { turns: 2, timed: 1, durationMs: 9000 } });
  });

  it("counts requests and turns by the UTC hour they happened in", () => {
    const hours = ofType(parseAll(TURNS).facts, "usage-hour");
    expect(summed(hours, (fact) => `${fact.day} ${(fact as { hour: number }).hour}`)).toEqual({
      "2026-11-10 10": { turns: 1, requests: 1 },
      "2026-11-10 23": { turns: 1 },
      "2026-11-11 0": { requests: 1 },
    });
  });

  it("counts calls by tool, an MCP tool under its server and any other name as other", () => {
    const tools = ofType(parseAll(TURNS).facts, "usage-tool");
    expect(tools.every((fact) => fact.day === "2026-11-10" && fact.calls === undefined)).toBe(true);
    const calls: Record<string, number> = {};
    for (const fact of tools) calls[fact.tool] = (calls[fact.tool] ?? 0) + 1;
    expect(calls).toEqual({
      exec_command: 1,
      "mcp:executor": 1,
      "mcp:linear": 1,
      other: 1,
      spawn_agent: 2,
      local_shell: 1,
    });
  });

  it("names a listed server's tool by the longest server it starts with", () => {
    const tools = ofType(
      parseAll([
        meta(),
        {
          timestamp: at("10:00:00"),
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "<tools>\n- mcp__my__server: x\n</tools>" }],
          },
        },
        started(at("10:00:01")),
        call("10:00:02", { name: "mcp__my__server__read" }),
      ]).facts,
      "usage-tool",
    );
    expect(tools.map((fact) => fact.tool)).toEqual(["mcp:my__server"]);
  });

  it("reads each window's gauge, and the limit reached once, on the fuller window", () => {
    const facts = ofType(parseAll(TURNS).facts, "usage-limit");
    const five = { windowMinutes: 300, resetsAt: seconds(at("04:00:00", "2026-11-11")) };
    const week = { windowMinutes: 10_080, resetsAt: seconds(at("00:00:00", "2026-11-14")) };
    const next = { type: "usage-limit", day: "2026-11-11" } as const;
    expect(facts).toEqual([
      {
        type: "usage-limit",
        day: "2026-11-10",
        at: seconds(at("10:00:07")),
        usedPercent: 40,
        windowMinutes: 300,
        resetsAt: seconds(at("14:00:00")),
      },
      {
        type: "usage-limit",
        day: "2026-11-10",
        at: seconds(at("10:00:07")),
        usedPercent: 10,
        ...week,
      },
      { ...next, at: seconds(at("00:00:10", "2026-11-11")), usedPercent: 100, ...five, reached: 1 },
      { ...next, at: seconds(at("00:00:10", "2026-11-11")), usedPercent: 12, ...week },
      { ...next, at: seconds(at("00:00:20", "2026-11-11")), usedPercent: 100, ...five },
      { ...next, at: seconds(at("00:00:20", "2026-11-11")), usedPercent: 12, ...week },
    ]);
  });

  it("counts none of a fork's copied tasks or calls", () => {
    const { facts } = parseAll([
      meta({ forked_from_id: "parent-id", thread_source: "subagent" }),
      started(at("09:00:00")),
      call("09:00:01", { name: "exec_command" }),
      ended(at("09:00:02"), "task_complete", { duration_ms: 2000 }),
      started(at("10:00:00")),
      call("10:00:01", { name: "apply_patch" }),
    ]);
    expect(summed(ofType(facts, "usage-turn"), () => "all")).toEqual({
      all: { turns: 1, toolCalls: 1 },
    });
    expect(ofType(facts, "usage-tool")).toEqual([
      { type: "usage-tool", day: "2026-11-10", thread: "subagent", tool: "apply_patch" },
    ]);
  });

  it("keeps tool input, plan type and credits out of every Fact and the State", () => {
    const { facts, state } = parseAll(TURNS);
    const forbidden = ["secret", "/home/u", "session-id"];
    expect(findCanary(facts, forbidden)).toEqual([]);
    expect(findCanary(state, forbidden)).toEqual([]);
  });
});

describe("codex usage", () => {
  it("counts each step of the running totals once, by the request's UTC day and model", () => {
    const { facts } = parseAll(SESSION);
    expect(facts.find((fact) => fact.type === "usage-session")).toEqual({
      type: "usage-session",
      day: "2026-11-10",
      ...base,
    });
    expect(usageOf(facts)).toEqual([
      {
        type: "usage-tokens",
        day: "2026-11-10",
        ...base,
        model: "gpt-6",
        input: 800,
        output: 50,
        reasoning: 10,
        cacheRead: 200,
        cacheWrite: 0,
        ...zero,
      },
      {
        type: "usage-tokens",
        day: "2026-11-10",
        ...base,
        model: "gpt-6",
        input: 1000,
        output: 70,
        reasoning: 20,
        cacheRead: 1000,
        cacheWrite: 0,
        ...zero,
      },
      {
        type: "usage-tokens",
        day: "2026-11-11",
        ...base,
        model: "gpt-6-mini",
        input: 0,
        output: 30,
        reasoning: 0,
        cacheRead: 400,
        cacheWrite: 100,
        ...zero,
      },
    ]);
    // The steps add up to the last totals, uncached input apart from cached.
    expect(sum(facts)).toEqual({
      input: 3500 - 1600 - 100,
      cacheRead: 1600,
      cacheWrite: 100,
      output: 150,
      reasoning: 30,
    });
  });

  it("counts a compaction on the session's day, the first one flagged, none as the user's", () => {
    const { facts } = parseAll(SESSION);
    expect(facts.filter((fact) => fact.type === "compaction")).toEqual([
      { type: "compaction", day: "2026-11-10", ...base, manual: false, first: true },
      { type: "compaction", day: "2026-11-10", ...base, manual: false, first: false },
    ]);
  });

  it("names the model unknown before any turn_context", () => {
    const { facts } = parseAll([meta(), tokens(at("10:00:05"), usage(10, 0, 1), usage(10, 0, 1))]);
    expect(usageOf(facts)).toMatchObject([{ model: "unknown", input: 10, output: 1 }]);
  });

  it("counts totals that went back by the event's own last usage", () => {
    const { facts } = parseAll([
      meta(),
      context("gpt-6"),
      tokens(at("10:00:05"), usage(1000, 0, 10), usage(1000, 0, 10)),
      tokens(at("10:00:06"), usage(300, 100, 5), usage(300, 100, 5)),
      tokens(at("10:00:07"), usage(500, 100, 7), usage(200, 0, 2)),
    ]);
    expect(
      usageOf(facts).map(({ input, cacheRead, output }) => [input, cacheRead, output]),
    ).toEqual([
      [1000, 0, 10],
      [200, 100, 5],
      [200, 0, 2],
    ]);
  });

  it("counts no more cached or written tokens than the input, nor more reasoning than output", () => {
    const { facts } = parseAll([
      meta(),
      tokens(at("10:00:05"), usage(100, 150, 10, 40, 30), usage(100, 150, 10, 40, 30)),
      tokens(at("10:00:06"), usage(200, 210, 20, 40, 60), usage(100, 60, 10, 0, 30)),
    ]);
    expect(usageOf(facts)).toMatchObject([
      { input: 0, cacheRead: 100, cacheWrite: 0, output: 10, reasoning: 10 },
      { input: 10, cacheRead: 60, cacheWrite: 30, output: 10, reasoning: 0 },
    ]);
  });

  describe("a fork or subagent", () => {
    const copy = [
      started(at("09:00:00")),
      context("gpt-5"),
      tokens(at("09:00:05"), usage(5000, 1000, 200), usage(5000, 1000, 200)),
      compacted("09:30:00"),
      tokens(at("09:40:00"), usage(6000, 1500, 250), usage(1000, 500, 50)),
    ];
    const subagent = meta({
      forked_from_id: "parent-id",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent-id" } } },
      thread_source: "subagent",
      timestamp: at("09:59:00"),
    });

    it("counts none of the parent's copied history, only the steps after its own first task", () => {
      const { facts } = parseAll([
        subagent,
        ...copy,
        started(at("10:00:00")),
        context("gpt-6"),
        tokens(at("10:00:05"), usage(6400, 1800, 260), usage(400, 300, 10)),
      ]);
      expect(facts.filter((fact) => fact.type === "compaction")).toEqual([]);
      expect(usageOf(facts)).toEqual([
        {
          type: "usage-tokens",
          day: "2026-11-10",
          via: "codex_cli_rs",
          project: "~/work/app",
          thread: "subagent",
          model: "gpt-6",
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 300,
          cacheWrite: 0,
          ...zero,
        },
      ]);
    });

    it("counts its own totals when they start again from zero", () => {
      const { facts } = parseAll([
        subagent,
        ...copy,
        started(at("10:00:00")),
        tokens(at("10:00:05"), usage(400, 300, 10), usage(400, 300, 10)),
        compacted("10:10:00"),
      ]);
      expect(usageOf(facts)).toMatchObject([{ input: 100, cacheRead: 300, output: 10 }]);
      expect(facts.filter((fact) => fact.type === "compaction")).toMatchObject([
        { thread: "subagent", first: true },
      ]);
    });

    it("is a subagent's conversation when only its thread source says so", () => {
      const { facts } = parseAll([meta({ thread_source: "subagent" })]);
      expect(facts.find((fact) => fact.type === "usage-session")).toMatchObject({
        thread: "subagent",
      });
    });
  });

  it("names the project by its remote, else by its folder keyed as Files keys it", () => {
    const project = (payload: Record<string, unknown>) =>
      parseAll([meta(payload)]).facts.find((fact) => fact.type === "usage-session");
    expect(project({ git: { repository_url: "git@github.com:Owner/Repo.git" } })).toMatchObject({
      project: "owner/repo",
    });
    expect(project({ git: { repository_url: "/srv/repos/app" } })).toMatchObject({
      project: "~/work/app",
    });
    expect(project({ git: { repository_url: "https://x/a/b?token=t" } })).toMatchObject({
      project: "a/b",
    });
    expect(project({ cwd: "/home/u" })).toMatchObject({ project: "~" });
    expect(project({ cwd: "/home/u/../u/work/./site/" })).toMatchObject({
      project: "~/work/site",
    });
    expect(project({ cwd: "/home/user2/app" })).toMatchObject({ project: "unknown" });
    expect(project({ cwd: "\\home\\u\\work\\app" })).toMatchObject({ project: "~/work/app" });
    expect(project({ cwd: "/srv/app" })).toMatchObject({ project: "/srv/app" });
    expect(project({ cwd: "relative/app" })).toMatchObject({ project: "unknown" });
    expect(project({ cwd: undefined })).toMatchObject({ project: "unknown" });
  });

  it("keeps remote credentials and foreign home paths out of a scan and its cache", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-project-"));
    try {
      const sessions = NodePath.join(home, ".codex", "sessions", "2026", "11", "10");
      const cacheDir = NodePath.join(home, "cache");
      const forbidden = ["query-secret", "/home/foreign-user"];
      await NodeFSP.mkdir(sessions, { recursive: true });
      for (const [index, payload] of [
        { git: { repository_url: "https://host/Good/Repo.git?token=query-secret#fragment" } },
        { git: { repository_url: "git@host:invalid_owner/repo" }, cwd: `${forbidden[1]}/app` },
      ].entries()) {
        await NodeFSP.writeFile(
          NodePath.join(sessions, `rollout-${index}.jsonl`),
          `${JSON.stringify(meta(payload))}\n`,
        );
      }
      const scan = parseScan(
        await scanMachine({
          harnesses: [codex],
          place: { home, env: {} },
          cacheDir,
          days: 1,
          tool: "loadsheet@test",
          now: new Date(at("23:00:00")),
        }),
      );
      expect(scan.usage?.sessions.map((cell) => cell.project).sort()).toEqual([
        "good/repo",
        "unknown",
      ]);
      expect(findCanary(scan, forbidden)).toEqual([]);
      const cacheFiles = await NodeFSP.readdir(cacheDir);
      expect(cacheFiles).not.toHaveLength(0);
      for (const file of cacheFiles) {
        const text = await NodeFSP.readFile(NodePath.join(cacheDir, file), "utf8");
        for (const secret of forbidden) expect(text).not.toContain(secret);
      }
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps ids, the home folder, credentials and text out of every Fact and the State", () => {
    const { facts, state } = parseAll(SESSION);
    const forbidden = ["/home/u", "session-id", "user:token", "Secret", "secret", "Summary"];
    expect(findCanary(facts, forbidden)).toEqual([]);
    expect(findCanary(state, forbidden)).toEqual([]);
  });

  describe("read in parts", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-codex-usage-"));
    });
    afterEach(async () => {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    });

    it.each([
      ["tokens and compactions", SESSION, 3],
      ["turns, tools and limits", TURNS, 2],
    ])("gives the same %s and State when it resumes after any line", async (_, session, steps) => {
      const lines = session.map((value) => `${JSON.stringify(value)}\n`);
      const path = NodePath.join(dir, "rollout.jsonl");
      await NodeFSP.writeFile(path, lines.join(""));
      const whole = await readTranscript(path, codexTranscripts, undefined, { place });
      expect(usageOf(whole!.records)).toHaveLength(steps);
      for (let split = 1; split < lines.length; split++) {
        await NodeFSP.writeFile(path, lines.slice(0, split).join(""));
        const first = await readTranscript(path, codexTranscripts, undefined, { place });
        await NodeFSP.appendFile(path, lines.slice(split).join(""));
        const saved = JSON.parse(JSON.stringify(first!.position)) as ReadPosition;
        const second = await readTranscript(path, codexTranscripts, saved, { place });
        expect(second!.resumed, `split ${split}`).toBe(true);
        expect([...first!.records, ...second!.records], `split ${split}`).toEqual(whole!.records);
        expect(second!.position, `split ${split}`).toEqual(whole!.position);
      }
    });
  });
});

describe("codex settings", () => {
  const settings = (config?: string) =>
    codex.machine!.settings!(
      memoryFiles(config === undefined ? {} : { "~/.codex/config.toml": config }),
    );

  it("records Codex's 32 KiB AGENTS.md limit when config.toml sets none", async () => {
    expect(await settings()).toEqual({ docMaxBytes: 32_768 });
    expect(await settings('model = "gpt-6"\n')).toEqual({ docMaxBytes: 32_768 });
  });

  it("reads the AGENTS.md limit and the auto-compact limit, and no other value", async () => {
    const config = [
      'model = "gpt-6"',
      "project_doc_max_bytes = 65_536 # bigger docs",
      "model_auto_compact_token_limit = 200000",
      'api_key = "SECRET-1"',
      "[mcp_servers.x]",
      'env = { TOKEN = "SECRET-2" }',
    ].join("\n");
    const read = await settings(config);
    expect(read).toEqual({ docMaxBytes: 65_536, autoCompactWindow: 200_000 });
    expect(findCanary(read, ["SECRET", "gpt-6"])).toEqual([]);
  });

  it("reads the limits only at the top of the file, as whole numbers", () => {
    const read = (source: string) => {
      const { projectDocMaxBytes, autoCompactTokenLimit } = readCodexConfig(source);
      return { projectDocMaxBytes, autoCompactTokenLimit };
    };
    expect(read("[profiles.big]\nproject_doc_max_bytes = 9\n")).toEqual({});
    expect(read('project_doc_max_bytes = "9"\nmodel_auto_compact_token_limit = 1.5\n')).toEqual({});
    expect(read('note = """\nproject_doc_max_bytes = 9\n"""\n')).toEqual({});
    expect(read("# project_doc_max_bytes = 9\n")).toEqual({});
    expect(read("  project_doc_max_bytes=+9\n")).toEqual({ projectDocMaxBytes: 9 });
  });
});

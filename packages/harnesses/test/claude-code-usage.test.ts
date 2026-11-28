import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findCanary } from "@loadsheet/fixtures";
import type { Fact, Place, UsageTokensFact } from "@loadsheet/kit";
import { memoryFiles } from "@loadsheet/kit";
import { readTranscript, type ReadPosition } from "@loadsheet/kit/node";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CLAUDE_CODE_RETENTION_DAYS, claudeCode, claudeTranscripts } from "../src/index.ts";

const FIXTURES = NodePath.join(import.meta.dirname, "fixtures/claude-code");
/** A session's main transcript and one of its subagents', sanitized together from one real session. */
const MAIN = NodePath.join(FIXTURES, "usage.jsonl");
const AGENT = NodePath.join(FIXTURES, "usage-agent.jsonl");
/** The fixtures' sanitized cwd is under this home. */
const PLACE: Place = { home: "/home/user", env: {} };
const machine = claudeCode.machine!;

const USAGE_TYPES = new Set(["usage-session", "compaction", "usage-tokens"]);
const usageOf = (facts: readonly Fact[]) => facts.filter((fact) => USAGE_TYPES.has(fact.type));

const parseLines = (lines: readonly string[], place: Place | null = PLACE) => {
  const state = claudeTranscripts.initial();
  const facts: Fact[] = [];
  for (const line of lines) {
    if (claudeTranscripts.markers.some((marker) => line.includes(marker))) {
      facts.push(...claudeTranscripts.parse(line, state, place ?? undefined));
    }
  }
  return { facts, state };
};

type Totals = {
  -readonly [
    Key in keyof Omit<UsageTokensFact, "type" | "via" | "project" | "thread" | "model" | "day">
  ]: UsageTokensFact[Key];
};
/** Each day's token Facts summed, with the number of requests. */
const byDay = (facts: readonly Fact[]) => {
  const days: Record<string, Totals> = {};
  for (const fact of facts) {
    if (fact.type !== "usage-tokens") continue;
    const sum = (days[fact.day] ??= {
      requests: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRewrite: 0,
    });
    sum.requests! += fact.requests ?? 1;
    for (const key of Object.keys(sum) as (keyof Totals)[]) {
      if (key !== "requests") sum[key] += fact[key] as number;
    }
  }
  return days;
};

const read = async (path: string) =>
  (await NodeFSP.readFile(path, "utf8")).split("\n").filter(Boolean);

// Counted by hand from the fixtures with jq: assistant lines grouped by consecutive message.id,
// `<synthetic>` dropped. The main transcript has 33 assistant lines for 15 messages, one of them
// synthetic; the subagent's 13 lines for 5. Main writes its cache for 1 hour, the subagent for 5
// minutes. The main transcript compacted once, by hand, and no two requests in either file are 5
// to 60 minutes apart: 14:54 to 15:54 is exactly 60.
describe("a sanitized Claude Code session's usage", () => {
  it("counts each request once, by the UTC day it was made", async () => {
    const { facts } = parseLines(await read(MAIN));
    const at = { via: "t3-code", project: "~/dir-1/file-1" };
    expect(facts.filter((fact) => fact.type === "usage-session")).toEqual([
      { type: "usage-session", day: "2026-11-18", ...at, thread: "main" },
    ]);
    expect(facts.filter((fact) => fact.type === "compaction")).toEqual([
      // Two days after the session started, dated by its start.
      { type: "compaction", day: "2026-11-18", ...at, thread: "main", manual: true, first: true },
    ]);
    const tokens = facts.filter((fact) => fact.type === "usage-tokens");
    expect(tokens).toHaveLength(14);
    expect(new Set(tokens.map((fact) => `${fact.model} ${fact.thread} ${fact.project}`))).toEqual(
      new Set(["claude-opus-5-5 main ~/dir-1/file-1"]),
    );
    expect(byDay(facts)).toEqual({
      "2026-11-18": {
        requests: 11,
        input: 24,
        output: 7058,
        reasoning: 1037,
        cacheRead: 704316,
        cacheWrite: 158653,
        cacheWrite5m: 0,
        cacheWrite1h: 158653,
        cacheRewrite: 0,
      },
      "2026-11-19": {
        requests: 3,
        input: 6,
        output: 2160,
        reasoning: 514,
        cacheRead: 354016,
        cacheWrite: 93493,
        cacheWrite5m: 0,
        cacheWrite1h: 93493,
        cacheRewrite: 0,
      },
    });
    // The first request, as before: 2 input, 24,755 cache creation, 28,300 cache read.
    expect(facts.filter((fact) => fact.type === "tokens")).toEqual([
      { type: "tokens", day: "2026-11-18", via: "t3-code", tokens: 53057 },
    ]);
  });

  it("counts a subagent's file as one subagent conversation, and only its tokens", async () => {
    const { facts } = parseLines(await read(AGENT));
    const at = { via: "t3-code", project: "~/dir-1/file-1", thread: "subagent" };
    expect(facts.filter((fact) => fact.type === "usage-session")).toEqual([
      { type: "usage-session", day: "2026-11-20", ...at },
    ]);
    // Its parent counts the session, its listing and its first tokens.
    expect(facts.filter((fact) => ["session", "tokens", "listed"].includes(fact.type))).toEqual([]);
    expect(facts.filter((fact) => fact.type === "compaction")).toEqual([]);
    expect(byDay(facts)).toEqual({
      "2026-11-20": {
        requests: 5,
        input: 10,
        output: 2700,
        reasoning: 563,
        cacheRead: 152219,
        cacheWrite: 49103,
        cacheWrite5m: 49103,
        cacheWrite1h: 0,
        cacheRewrite: 0,
      },
    });
  });

  it("names no home directory without a Place to tell it", async () => {
    const { facts } = parseLines(await read(MAIN), null);
    expect(new Set(usageOf(facts).map((fact) => (fact as { project: string }).project))).toEqual(
      new Set(["unknown"]),
    );
  });

  it("lets no fixture text, id or home path into its Facts or its State", async () => {
    for (const path of [MAIN, AGENT]) {
      const lines = await read(path);
      const { facts, state } = parseLines(lines);
      const ids = lines.flatMap((line) => {
        const id = (JSON.parse(line) as { message?: { id?: unknown } }).message?.id;
        return typeof id === "string" ? [id] : [];
      });
      expect(ids.length).toBeGreaterThan(0);
      const forbidden = ["/home/user", ...new Set(ids)];
      expect(findCanary(facts, forbidden)).toEqual([]);
      expect(findCanary(JSON.parse(JSON.stringify(state)), forbidden)).toEqual([]);
    }
  });

  describe("read through readTranscript", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-claude-usage-"));
    });
    afterEach(async () => {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    });

    it("gives the same Facts resumed after any line as read whole", async () => {
      for (const fixture of [MAIN, AGENT]) {
        const whole = await readTranscript(fixture, claudeTranscripts, undefined, { place: PLACE });
        expect(usageOf(whole!.records).length).toBeGreaterThan(0);
        // readTranscript skips lines the parser would not change anything for; it counts the same.
        expect(whole!.records).toEqual(parseLines(await read(fixture)).facts);
        const lines = await read(fixture);
        const path = NodePath.join(dir, "session.jsonl");
        for (let cut = 0; cut <= lines.length; cut += 1) {
          const head = lines.slice(0, cut).map((line) => `${line}\n`);
          await NodeFSP.writeFile(path, head.join(""));
          const first = await readTranscript(path, claudeTranscripts, undefined, { place: PLACE });
          // The cache holds the position as JSON.
          const saved = JSON.parse(JSON.stringify(first!.position)) as ReadPosition;
          await NodeFSP.appendFile(
            path,
            lines
              .slice(cut)
              .map((line) => `${line}\n`)
              .join(""),
          );
          const second = await readTranscript(path, claudeTranscripts, saved, { place: PLACE });
          expect(second!.resumed || cut === 0).toBe(true);
          expect([...first!.records, ...second!.records], `cut at ${cut}`).toEqual(whole!.records);
        }
      }
    });
  });
});

describe("Claude Code usage", () => {
  const line = (value: Record<string, unknown>) =>
    JSON.stringify({
      timestamp: "2026-03-01T23:30:00.000-02:00",
      entrypoint: "cli",
      version: "2.1.0",
      cwd: "/home/jo/work/app",
      ...value,
    });
  const request = (
    id: string | undefined,
    timestamp: string,
    usage: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    model = "claude-opus-5-5",
  ) =>
    line({
      type: "assistant",
      timestamp,
      message: { model, ...(id === undefined ? {} : { id }), content: [], usage },
      ...extra,
    });
  const compact = (trigger: string, extra: Record<string, unknown> = {}) =>
    line({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      compactMetadata: { trigger, preTokens: 180000 },
      ...extra,
    });
  const jo: Place = { home: "/home/jo", env: {} };
  const tokens = (facts: readonly Fact[]) =>
    facts.filter((fact): fact is UsageTokensFact => fact.type === "usage-tokens");

  it("counts a message written once per content block as one request", () => {
    const usage = { input_tokens: 3, output_tokens: 10, cache_creation_input_tokens: 7 };
    const { facts } = parseLines(
      [
        request("a", "2026-03-02T10:00:00Z", usage),
        request("a", "2026-03-02T10:00:01Z", usage),
        line({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
        request("a", "2026-03-02T10:00:02Z", usage),
        request("b", "2026-03-02T10:00:03Z", usage),
        // Ids come back only next to each other; one that comes back later is a new request.
        request("a", "2026-03-02T10:00:04Z", usage),
        // Without an id, each line counts.
        request(undefined, "2026-03-02T10:00:05Z", usage),
        request(undefined, "2026-03-02T10:00:06Z", usage),
      ],
      jo,
    );
    expect(tokens(facts).map((fact) => fact.output)).toEqual([10, 10, 10, 10, 10]);
    expect(tokens(facts)[0]).toEqual({
      type: "usage-tokens",
      day: "2026-03-02",
      via: "cli",
      project: "~/work/app",
      thread: "main",
      model: "claude-opus-5-5",
      input: 3,
      output: 10,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 7,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRewrite: 0,
    });
  });

  it("skips <synthetic> messages, which never reached the API", () => {
    const usage = { input_tokens: 0, output_tokens: 0 };
    const { facts, state } = parseLines(
      [
        request("a", "2026-03-02T10:00:00Z", { input_tokens: 1 }),
        request("s", "2026-03-02T10:30:00Z", usage, {}, "<synthetic>"),
        // The synthetic message moved neither the last id nor the last request's minute.
        request("a", "2026-03-02T10:31:00Z", { input_tokens: 2 }),
        request("b", "2026-03-02T10:32:00Z", {
          cache_creation_input_tokens: 5,
          cache_creation: { ephemeral_5m_input_tokens: 5 },
        }),
      ],
      jo,
    );
    expect(tokens(facts).map(({ input, cacheRewrite }) => [input, cacheRewrite])).toEqual([
      [1, 0],
      [0, 5],
    ]);
    expect(state.minute).toBe(Date.parse("2026-03-02T10:32:00Z") / 60_000);
  });

  it("dates each request by its own UTC day, and the session by its start", () => {
    const { facts } = parseLines(
      [
        line({ type: "user", message: { content: "hi" } }),
        request("a", "2026-03-02T23:59:59.999Z", { input_tokens: 1 }),
        request("b", "2026-03-03T00:00:00.000Z", { input_tokens: 2 }),
      ],
      jo,
    );
    expect(facts.find((fact) => fact.type === "usage-session")?.day).toBe("2026-03-02");
    expect(tokens(facts).map(({ day, input }) => [day, input])).toEqual([
      ["2026-03-02", 1],
      ["2026-03-03", 2],
    ]);
  });

  it("splits cache writes by lifetime and counts reasoning inside output", () => {
    const { facts } = parseLines(
      [
        request("a", "2026-03-02T10:00:00Z", {
          input_tokens: 2,
          output_tokens: 300,
          output_tokens_details: { thinking_tokens: 120 },
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 900,
          cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 300 },
        }),
        // An older line has no split: it stays unsplit.
        request("b", "2026-03-02T10:01:00Z", { cache_creation_input_tokens: 40 }),
      ],
      jo,
    );
    expect(
      tokens(facts).map((fact) => [
        fact.output,
        fact.reasoning,
        fact.cacheRead,
        fact.cacheWrite,
        fact.cacheWrite5m,
        fact.cacheWrite1h,
      ]),
    ).toEqual([
      [300, 120, 5000, 900, 600, 300],
      [0, 0, 0, 40, 0, 0],
    ]);
  });

  it("counts as rewritten the cache writes of a request 5 to 60 minutes after the one before", () => {
    const write = (tokens: number) => ({
      cache_creation_input_tokens: tokens,
      cache_creation: { ephemeral_5m_input_tokens: tokens },
    });
    const { facts } = parseLines(
      [
        request("a", "2026-03-02T10:00:59Z", write(1)),
        // 4 minutes by the clock's minutes: the 5-minute cache was still there.
        request("b", "2026-03-02T10:04:00Z", write(2)),
        request("c", "2026-03-02T10:09:00Z", write(4)),
        request("d", "2026-03-02T11:08:59Z", write(8)),
        // 60 minutes: a 1-hour cache is gone too.
        request("e", "2026-03-02T12:08:00Z", write(16)),
        // A subagent's line in the same file follows the file's last request.
        request("f", "2026-03-02T12:20:00Z", write(32), { isSidechain: true }),
        request("f", "2026-03-02T12:40:00Z", write(32), { isSidechain: true }),
        request("g", "2026-03-02T12:35:00Z", write(64), {}, "different-model"),
        request(
          "h",
          "2026-03-02T12:50:00Z",
          { cache_creation_input_tokens: 128, cache_creation: { ephemeral_1h_input_tokens: 128 } },
          {},
          "different-model",
        ),
      ],
      jo,
    );
    expect(tokens(facts).map(({ cacheWrite, cacheRewrite }) => [cacheWrite, cacheRewrite])).toEqual(
      [
        [1, 0],
        [2, 0],
        [4, 4],
        [8, 8],
        [16, 0],
        [32, 32],
        [64, 0],
        [128, 0],
      ],
    );
    expect(tokens(facts).find((cell) => cell.cacheWrite === 32)?.thread).toBe("subagent");
  });

  it("counts automatic and manual compactions, the first one marked", () => {
    const { facts, state } = parseLines(
      [
        line({ type: "user", message: { content: "hi" } }),
        compact("auto"),
        compact("manual"),
        line({ type: "system", subtype: "turn_duration" }),
        compact("auto", { timestamp: "2026-03-05T10:00:00Z" }),
      ],
      jo,
    );
    const at = { day: "2026-03-02", via: "cli", project: "~/work/app", thread: "main" };
    expect(facts.filter((fact) => fact.type === "compaction")).toEqual([
      { type: "compaction", ...at, manual: false, first: true },
      { type: "compaction", ...at, manual: true, first: false },
      { type: "compaction", ...at, manual: false, first: false },
    ]);
    expect(state.compacted).toBe(true);

    const side = parseLines([compact("auto", { isSidechain: true, agentId: "a1" })], jo);
    expect(side.facts.filter((fact) => fact.type !== "usage-session")).toEqual([
      { type: "compaction", ...at, thread: "subagent", manual: false, first: true },
    ]);
  });

  it("keys the project by the cwd the file starts in, never a home directory in full", () => {
    const project = (cwd: unknown, place: Place | null = jo) =>
      parseLines([line({ type: "user", cwd, message: { content: "hi" } })], place).facts.find(
        (fact) => fact.type === "usage-session",
      )?.project;
    expect(project("/home/jo/work/app")).toBe("~/work/app");
    expect(project("/home/jo/work/app/")).toBe("~/work/app");
    expect(project("/home/jo")).toBe("~");
    expect(project("/srv/build/app")).toBe("/srv/build/app");
    expect(project("/home/other/app")).toBe("unknown");
    expect(project("/Users/jo/app")).toBe("unknown");
    expect(project("/root/app")).toBe("unknown");
    expect(project("C:\\Users\\jo\\app")).toBe("unknown");
    expect(project("relative/app")).toBe("unknown");
    expect(project("/srv/a\nb")).toBe("unknown");
    expect(project(undefined)).toBe("unknown");
    expect(project("/home/jo/work/app", null)).toBe("unknown");
    expect(project("/srv/build/app", null)).toBe("/srv/build/app");
    expect(project("C:\\Users\\jo\\app", { home: "C:\\Users\\jo", env: {} })).toBe("~/app");

    // A later cd does not move the session.
    const moved = parseLines(
      [
        line({ type: "user", message: { content: "hi" } }),
        request("a", "2026-03-02T10:00:00Z", { input_tokens: 1 }, { cwd: "/home/jo/elsewhere" }),
      ],
      jo,
    );
    expect(tokens(moved.facts)[0]?.project).toBe("~/work/app");
  });

  it("puts no model name with a path or markup in a Fact", () => {
    const { facts } = parseLines(
      [
        request("a", "2026-03-02T10:00:00Z", {}, {}, "arn:aws:bedrock:x/claude"),
        request("b", "2026-03-02T10:00:01Z", {}, {}, "<b>"),
        request("c", "2026-03-02T10:00:02Z", {}, {}, "us.anthropic.claude-opus-5-5"),
      ],
      jo,
    );
    expect(tokens(facts).map((fact) => fact.model)).toEqual([
      "unknown",
      "unknown",
      "us.anthropic.claude-opus-5-5",
    ]);
    expect(findCanary(facts, ["/home/jo"])).toEqual([]);
  });
});

describe("Claude Code turns, hours, tools and limits", () => {
  const jo: Place = { home: "/home/jo", env: {} };
  const line = (value: Record<string, unknown>) =>
    JSON.stringify({ entrypoint: "cli", version: "2.1.0", cwd: "/home/jo/work/app", ...value });
  const prompt = (timestamp: string, content: unknown, extra: Record<string, unknown> = {}) =>
    line({ type: "user", timestamp, message: { role: "user", content }, ...extra });
  const reply = (
    id: string,
    timestamp: string,
    content: unknown[] = [],
    extra: Record<string, unknown> = {},
    model = "claude-opus-5-5",
  ) =>
    line({
      type: "assistant",
      timestamp,
      message: { model, id, content, usage: { input_tokens: 1, output_tokens: 1 } },
      ...extra,
    });
  const use = (name: string, input: Record<string, unknown> = {}) => ({
    type: "tool_use",
    id: "toolu_secret",
    name,
    input,
  });
  const result = (timestamp: string, extra: Record<string, unknown> = {}) =>
    line({
      type: "user",
      timestamp,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_secret", content: "secret output" }],
      },
      toolUseResult: { stdout: "secret output" },
      ...extra,
    });
  const apiError = (timestamp: string, status: number, retryAttempt: number) =>
    line({
      type: "system",
      subtype: "api_error",
      level: "error",
      timestamp,
      error: { status, message: "secret error" },
      retryAttempt,
      maxRetries: 10,
    });

  /**
   * Two prompts. The first runs 10 s over two replies with five tool calls (an MCP tool, two
   * subagent starts in one message and a name that is not a tool's), then a notification ends it
   * and its answer is no part of it. The second starts before midnight, hits the rate limit after
   * it (two retries, then the failed reply), runs 40 s until the user stops it, and hits the limit
   * again on the next request.
   */
  const SESSION = [
    line({
      type: "attachment",
      timestamp: "2026-03-02T10:00:00Z",
      attachment: { type: "mcp_instructions_delta", addedNames: ["linear"] },
    }),
    prompt("2026-03-02T10:00:00Z", "Fix the secret bug"),
    reply("a", "2026-03-02T10:00:05Z", [
      use("Bash", { command: "cat secret" }),
      use("mcp__linear__list_issues"),
    ]),
    result("2026-03-02T10:00:06Z"),
    reply("b", "2026-03-02T10:00:10Z", [
      use("Agent", { subagent_type: "general-purpose", prompt: "secret" }),
      use("Task", { prompt: "secret" }),
      use("cat ~/secret"),
    ]),
    prompt("2026-03-02T10:05:00Z", "<task-notification>secret</task-notification>"),
    reply("c", "2026-03-02T10:05:10Z"),
    prompt("2026-03-02T23:59:50Z", [{ type: "text", text: "Next secret" }]),
    reply("d", "2026-03-03T00:00:05Z"),
    apiError("2026-03-03T00:00:10Z", 429, 1),
    apiError("2026-03-03T00:00:15Z", 429, 2),
    apiError("2026-03-03T00:00:16Z", 500, 1),
    reply(
      "e",
      "2026-03-03T00:00:20Z",
      [{ type: "text", text: "secret limit text" }],
      { isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429 },
      "<synthetic>",
    ),
    prompt("2026-03-03T00:00:30Z", [{ type: "text", text: "[Request interrupted by user]" }]),
    reply("f", "2026-03-03T00:00:45Z"),
    apiError("2026-03-03T00:01:00Z", 429, 1),
  ];

  const ofType = <T extends Fact["type"]>(facts: readonly Fact[], type: T) =>
    facts.filter((fact): fact is Extract<Fact, { type: T }> => fact.type === type);
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

  it("counts each prompt as a turn on its day, timed to its last reply, stopped by the user", () => {
    const turns = ofType(parseLines(SESSION, jo).facts, "usage-turn");
    expect(
      turns.every(
        (fact) =>
          fact.day === "2026-03-02" &&
          fact.via === "cli" &&
          fact.project === "~/work/app" &&
          fact.thread === "main",
      ),
    ).toBe(true);
    expect(summed(turns, () => "all")).toEqual({
      all: {
        turns: 2,
        timed: 2,
        durationMs: 10_000 + 40_000,
        interrupted: 1,
        toolCalls: 5,
        withSubagents: 1,
      },
    });
  });

  it("counts a tool stopped by the user as the turn's interruption", () => {
    const { facts } = parseLines(
      [
        prompt("2026-03-02T10:00:00Z", "Run it"),
        reply("a", "2026-03-02T10:00:02Z", [use("Bash")]),
        result("2026-03-02T10:00:09Z", { toolUseResult: { interrupted: true, stdout: "" } }),
        result("2026-03-02T10:00:10Z", { toolUseResult: { interrupted: true, stdout: "" } }),
        reply("b", "2026-03-02T10:00:15Z", [use("Read")]),
      ],
      jo,
    );
    const turns = ofType(facts, "usage-turn");
    expect(summed(turns, () => "all")).toEqual({
      all: { turns: 1, timed: 1, durationMs: 9_000, interrupted: 1, toolCalls: 1 },
    });
    expect(ofType(facts, "usage-tool").map((fact) => fact.tool)).toEqual(["Bash", "Read"]);
    expect(ofType(facts, "usage-hour").filter((fact) => fact.requests)).toHaveLength(2);
  });

  it("starts a fresh turn for a prompt that begins with markup", () => {
    const { facts } = parseLines(
      [
        prompt("2026-03-02T10:00:00Z", "First"),
        reply("a", "2026-03-02T10:00:02Z"),
        prompt("2026-03-02T11:00:00Z", "<div>Fix this</div>"),
        reply("b", "2026-03-02T11:00:03Z"),
      ],
      jo,
    );
    expect(summed(ofType(facts, "usage-turn"), () => "all")).toEqual({
      all: { turns: 2, timed: 2, durationMs: 5_000 },
    });
    expect(
      ofType(facts, "usage-hour")
        .filter((fact) => fact.turns)
        .map((fact) => fact.hour),
    ).toEqual([10, 11]);
  });

  it("starts no turn for a meta line, a tool result or a command", () => {
    const turns = ofType(
      parseLines(
        [
          prompt("2026-03-02T10:00:00Z", "<system-reminder>x</system-reminder>"),
          prompt("2026-03-02T10:00:00Z", "Context", { isMeta: true }),
          prompt("2026-03-02T10:00:01Z", "<command-name>/clear</command-name>"),
          result("2026-03-02T10:00:02Z"),
        ],
        jo,
      ).facts,
      "usage-turn",
    );
    expect(turns).toEqual([]);
  });

  it("counts requests and prompts by the UTC hour they happened in", () => {
    const hours = ofType(parseLines(SESSION, jo).facts, "usage-hour");
    expect(summed(hours, (fact) => `${fact.day} ${(fact as { hour: number }).hour}`)).toEqual({
      "2026-03-02 10": { turns: 1, requests: 3 },
      "2026-03-02 23": { turns: 1 },
      "2026-03-03 0": { requests: 2 },
    });
  });

  it("counts calls by tool, an MCP tool under its server and any other name as other", () => {
    const tools = ofType(parseLines(SESSION, jo).facts, "usage-tool");
    expect(tools.every((fact) => fact.day === "2026-03-02" && fact.thread === "main")).toBe(true);
    expect(tools.map((fact) => fact.tool)).toEqual([
      "Bash",
      "mcp:linear",
      "Agent",
      "Task",
      "other",
    ]);
  });

  it("counts each run of rate-limit retries as the limit reached once, with no window", () => {
    expect(ofType(parseLines(SESSION, jo).facts, "usage-limit")).toEqual([
      { type: "usage-limit", day: "2026-03-03", windowMinutes: 0, reached: 1 },
      { type: "usage-limit", day: "2026-03-03", windowMinutes: 0, reached: 1 },
    ]);
  });

  it("counts a failed reply as the limit reached when no retry said so", () => {
    const limits = ofType(
      parseLines(
        [
          reply(
            "a",
            "2026-03-02T10:00:00Z",
            [],
            {
              isApiErrorMessage: true,
              error: "rate_limit",
              apiErrorStatus: 429,
            },
            "<synthetic>",
          ),
          reply(
            "b",
            "2026-03-02T10:00:01Z",
            [],
            {
              isApiErrorMessage: true,
              error: "rate_limit",
              apiErrorStatus: 429,
            },
            "<synthetic>",
          ),
          reply("c", "2026-03-02T11:00:00Z"),
          reply(
            "d",
            "2026-03-02T12:00:00Z",
            [],
            {
              isApiErrorMessage: true,
              error: "rate_limit",
              apiErrorStatus: 429,
            },
            "<synthetic>",
          ),
        ],
        jo,
      ).facts,
      "usage-limit",
    );
    expect(limits.map((fact) => fact.reached)).toEqual([1, 1]);
  });

  it("keeps prompts, tool input and output, and errors out of every Fact and the State", () => {
    const { facts, state } = parseLines(SESSION, jo);
    const forbidden = ["secret", "toolu", "/home/jo"];
    expect(findCanary(facts, forbidden)).toEqual([]);
    expect(findCanary(state, forbidden)).toEqual([]);
  });

  it("buckets identifier-shaped names from unverified tools and MCP servers", () => {
    const { facts, state } = parseLines(
      [
        prompt("2026-03-02T10:00:00Z", "Run it"),
        reply("a", "2026-03-02T10:00:01Z", [
          use("private.customer-reference"),
          use("mcp__private__read"),
        ]),
      ],
      jo,
    );
    expect(ofType(facts, "usage-tool").map((fact) => fact.tool)).toEqual(["other", "other"]);
    expect(findCanary({ facts, state }, ["private"])).toEqual([]);
  });

  describe("read through readTranscript", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-claude-turns-"));
    });
    afterEach(async () => {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    });

    it("gives the same Facts and State resumed after any line as read whole", async () => {
      const path = NodePath.join(dir, "session.jsonl");
      await NodeFSP.writeFile(path, SESSION.map((value) => `${value}\n`).join(""));
      const whole = await readTranscript(path, claudeTranscripts, undefined, { place: jo });
      expect(whole!.records).toEqual(parseLines(SESSION, jo).facts);
      for (let cut = 1; cut < SESSION.length; cut += 1) {
        await NodeFSP.writeFile(
          path,
          SESSION.slice(0, cut)
            .map((value) => `${value}\n`)
            .join(""),
        );
        const first = await readTranscript(path, claudeTranscripts, undefined, { place: jo });
        const saved = JSON.parse(JSON.stringify(first!.position)) as ReadPosition;
        await NodeFSP.appendFile(
          path,
          SESSION.slice(cut)
            .map((value) => `${value}\n`)
            .join(""),
        );
        const second = await readTranscript(path, claudeTranscripts, saved, { place: jo });
        expect(second!.resumed, `cut at ${cut}`).toBe(true);
        expect([...first!.records, ...second!.records], `cut at ${cut}`).toEqual(whole!.records);
        expect(second!.position, `cut at ${cut}`).toEqual(whole!.position);
      }
    });
  });
});

describe("Claude Code settings", () => {
  const settingsFiles = (settings?: Record<string, unknown>, dir = "~/.claude") =>
    memoryFiles(
      settings === undefined ? {} : { [`${dir}/settings.json`]: JSON.stringify(settings) },
    );
  const read = (
    settings?: Record<string, unknown>,
    env: Record<string, string | undefined> = {},
    place: Partial<Place> = {},
  ) => machine.settings!(settingsFiles(settings), { home: "/home/jo", env, ...place });

  it("reads only the default retention when there is no settings.json and no variable", async () => {
    expect(await read(undefined, { HOME: "/home/jo", PATH: "/usr/bin" })).toEqual({
      retentionDays: 30,
      settingsPath: "~/.claude/settings.json",
    });
    expect(await read({})).toEqual({ retentionDays: 30, settingsPath: "~/.claude/settings.json" });
  });

  // Claude Code's documented precedence for the prompt cache's lifetime, highest first.
  it.each([
    [{}, {}, {}, undefined, undefined],
    [{ promptCacheTtl: "1h" }, {}, {}, "1h", "settings.promptCacheTtl"],
    [
      { promptCacheTtl: "5m" },
      {},
      { ENABLE_PROMPT_CACHING_1H: "1" },
      "5m",
      "settings.promptCacheTtl",
    ],
    [{}, {}, { ENABLE_PROMPT_CACHING_1H: "1" }, "1h", "env.ENABLE_PROMPT_CACHING_1H"],
    [{}, {}, { ENABLE_PROMPT_CACHING_1H: "0" }, undefined, undefined],
    [
      { promptCacheTtl: "1h" },
      {},
      { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
      "5m",
      "env.CLAUDE_CODE_PROMPT_CACHE_TTL",
    ],
    [
      { promptCacheTtl: "5m" },
      {},
      { CLAUDE_CODE_PROMPT_CACHE_TTL: "forever" },
      "5m",
      "settings.promptCacheTtl",
    ],
    [
      { promptCacheTtl: "1h" },
      {},
      { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", FORCE_PROMPT_CACHING_5M: "1" },
      "5m",
      "env.FORCE_PROMPT_CACHING_5M",
    ],
    [
      { promptCacheTtl: "1h" },
      { FORCE_PROMPT_CACHING_5M: "true" },
      {},
      "5m",
      "settings.env.FORCE_PROMPT_CACHING_5M",
    ],
    // The settings' env block goes over the environment Claude Code starts in.
    [
      {},
      { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" },
      { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
      "1h",
      "settings.env.CLAUDE_CODE_PROMPT_CACHE_TTL",
    ],
    [{ promptCacheTtl: "2h" }, {}, {}, undefined, undefined],
  ])(
    "settings %j, env block %j, environment %j: %s from %s",
    async (settings, block, env, ttl, from) => {
      const result = await read(
        { ...settings, ...(Object.keys(block).length > 0 ? { env: block } : {}) },
        env,
      );
      expect(result?.cacheTtl).toBe(ttl);
      expect(result?.cacheTtlFrom).toBe(from);
    },
  );

  it("reads the subagents' lifetime with its own knobs", async () => {
    expect((await read({ subagentPromptCacheTtl: "1h" }))?.subagentCacheTtl).toBe("1h");
    expect(
      (
        await read(
          { subagentPromptCacheTtl: "1h" },
          { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" },
        )
      )?.subagentCacheTtl,
    ).toBe("5m");
    expect(
      (await read({ subagentPromptCacheTtl: "1h" }, { FORCE_PROMPT_CACHING_5M: "1" }))
        ?.subagentCacheTtl,
    ).toBe("5m");
    const main = await read({ promptCacheTtl: "1h" });
    expect(main?.subagentCacheTtl).toBeUndefined();
  });

  it("tells when caching is off, for every model or one, and which variable turned it off", async () => {
    expect(await read({}, { DISABLE_PROMPT_CACHING: "1" })).toMatchObject({
      caching: "off",
      cachingFrom: "env.DISABLE_PROMPT_CACHING",
    });
    expect(await read({ env: { DISABLE_PROMPT_CACHING_OPUS: "yes" } })).toMatchObject({
      caching: "off",
      cachingFrom: "settings.env.DISABLE_PROMPT_CACHING_OPUS",
    });
    expect((await read({}, { DISABLE_PROMPT_CACHING_FABLE: "true" }))?.caching).toBe("off");
    const unset = await read({}, { DISABLE_PROMPT_CACHING: "0" });
    expect(unset?.caching).toBeUndefined();
    expect(unset?.cachingFrom).toBeUndefined();
    expect((await read({}, { DISABLE_PROMPT_CACHINGX: "1" }))?.caching).toBeUndefined();
  });

  it("reads retention and compaction", async () => {
    expect(CLAUDE_CODE_RETENTION_DAYS).toBe(30);
    expect(await read({ cleanupPeriodDays: 365 })).toEqual({
      retentionDays: 365,
      settingsPath: "~/.claude/settings.json",
    });
    expect((await read({ cleanupPeriodDays: "x" }))?.retentionDays).toBe(30);
    expect((await read({ autoCompactEnabled: false }))?.autoCompact).toBe(false);
    expect((await read({ autoCompactEnabled: true }))?.autoCompact).toBe(true);
    expect(
      (await read({ autoCompactEnabled: true }, { DISABLE_AUTO_COMPACT: "1" }))?.autoCompact,
    ).toBe(false);
    expect((await read({ env: { DISABLE_COMPACT: "1" } }))?.autoCompact).toBe(false);
    expect((await read({}))?.autoCompact).toBeUndefined();
    expect((await read({ autoCompactWindow: 220000 }))?.autoCompactWindow).toBe(220000);
    expect(
      (await read({ autoCompactWindow: 220000 }, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000" }))
        ?.autoCompactWindow,
    ).toBe(150000);
    expect((await read({ autoCompactWindow: -1 }))?.autoCompactWindow).toBeUndefined();
  });

  it("follows CLAUDE_CONFIG_DIR to its settings.json", async () => {
    const files = settingsFiles({ promptCacheTtl: "1h" }, "/srv/claude");
    const place = { home: "/home/jo", env: { CLAUDE_CONFIG_DIR: "/srv/claude" } };
    expect(await machine.settings!(files, place)).toEqual({
      cacheTtl: "1h",
      cacheTtlFrom: "settings.promptCacheTtl",
      retentionDays: 30,
    });
    expect(
      await machine.settings!(settingsFiles({ promptCacheTtl: "5m" }, "~/custom"), {
        home: "/home/jo",
        env: { CLAUDE_CONFIG_DIR: "/home/jo/custom" },
      }),
    ).toMatchObject({ settingsPath: "~/custom/settings.json", cacheTtl: "5m" });
  });

  it("copies no value of a setting or variable it does not read", async () => {
    const result = await read(
      {
        promptCacheTtl: "1h",
        apiKeyHelper: "/home/jo/bin/sekrit",
        env: { ANTHROPIC_AUTH_TOKEN: "sekrit", ANTHROPIC_BASE_URL: "https://jo.example" },
      },
      { ANTHROPIC_API_KEY: "sekrit", HOME: "/home/jo" },
    );
    expect(result).toEqual({
      settingsPath: "~/.claude/settings.json",
      cacheTtl: "1h",
      cacheTtlFrom: "settings.promptCacheTtl",
      retentionDays: 30,
    });
    expect(findCanary(result, ["sekrit", "/home/jo", "jo.example"])).toEqual([]);
  });
});

describe("Claude Code project hints", () => {
  const hints = (
    config: unknown,
    place: Place = { home: "/home/jo", env: {} },
    key = "~/.claude.json",
  ) => machine.projects!(memoryFiles({ [key]: JSON.stringify(config) }), place);

  it("maps each folder githubRepoPaths remembers to its repository", async () => {
    expect(
      await hints({
        githubRepoPaths: {
          "acme/app": ["/home/jo/work/app", "/home/jo/.t3/worktrees/app/feat-x/"],
          "acme/site": ["/srv/site"],
        },
      }),
    ).toEqual([
      { prefix: "~/work/app", project: "acme/app" },
      { prefix: "~/.t3/worktrees/app/feat-x", project: "acme/app" },
      { prefix: "/srv/site", project: "acme/site" },
    ]);
  });

  it("drops what is not an owner/repo or an absolute folder", async () => {
    expect(
      await hints({
        githubRepoPaths: {
          "not a repo": ["/home/jo/x"],
          "a/b/c": ["/home/jo/y"],
          "acme/app": ["relative", 3, "/home/jo/app"],
          "acme/none": "/home/jo/none",
        },
      }),
    ).toEqual([{ prefix: "~/app", project: "acme/app" }]);
    expect(await hints({})).toEqual([]);
    expect(await hints("not an object")).toEqual([]);
  });

  it("reads .claude.json inside CLAUDE_CONFIG_DIR when it is set", async () => {
    const place = { home: "/home/jo", env: { CLAUDE_CONFIG_DIR: "/srv/claude" } };
    const config = { githubRepoPaths: { "acme/app": ["/home/jo/app"] } };
    expect(await hints(config, place, "/srv/claude/.claude.json")).toEqual([
      { prefix: "~/app", project: "acme/app" },
    ]);
    expect(await hints(config, place)).toEqual([]);
  });

  it("reads a file kit already reads", () => {
    const sources = machine.sources({ home: "/home/jo", env: {} });
    expect(sources).toContain("/home/jo/.claude.json");
    expect(sources).toContain("/home/jo/.claude/settings.json");
  });
});

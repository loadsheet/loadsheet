import { Buffer } from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { LineBytes } from "@loadsheet/kit";
import { describe, expect, it } from "vite-plus/test";
import { codexTranscripts, type CodexState } from "../src/index.ts";

const FIXTURE = NodePath.join(import.meta.dirname, "fixtures/codex/session.jsonl");

const bytes = (buffer: Buffer): LineBytes => ({
  length: buffer.length,
  bytes: buffer,
  includes: (ascii) => buffer.includes(ascii, 0, "latin1"),
  slice: (start, end) => buffer.toString("latin1", start, end ?? buffer.length),
});

/**
 * Asks `skip` about one line, and where it says yes, checks that parse on a copy of the state
 * returns nothing and leaves the copy equal to the state. The line is decoded as readTranscript
 * decodes it, without a trailing carriage return.
 */
const skipped = (line: string, state: CodexState) => {
  const buffer = Buffer.from(line);
  const before = structuredClone(state);
  const said = codexTranscripts.skip!(bytes(buffer), state);
  expect(state).toEqual(before);
  if (said) {
    const copy = structuredClone(state);
    const text = buffer.toString("utf8").replace(/\r$/u, "");
    expect(codexTranscripts.parse(text, copy), line.slice(0, 300)).toEqual([]);
    expect(copy, line.slice(0, 300)).toEqual(state);
  }
  return said;
};

/** The value with each object's keys in reverse order: the line's `type` after its payload. */
const reversed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversed)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([k, v]) => [k, reversed(v)]),
        )
      : value;
/** The payload's `type` moved after its objects, where the line's head does not reach it. */
const typeLast = (value: Record<string, unknown>) => {
  const payload = value.payload as Record<string, unknown> | undefined;
  if (typeof payload !== "object" || payload === null || !("type" in payload)) return value;
  const { type, ...rest } = payload;
  return { ...value, payload: { ...rest, type } };
};
/** JSON with `space` around every token. */
const write = (value: unknown, space: string): string => {
  const join = (parts: string[]) => parts.join(`${space},${space}`);
  if (Array.isArray(value)) return `[${space}${join(value.map((v) => write(v, space)))}${space}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const members = Object.entries(value).map(
    ([key, v]) => `${JSON.stringify(key)}${space}:${space}${write(v, space)}`,
  );
  return `{${space}${join(members)}${space}}`;
};
const spaced = (line: string, space: string) => write(JSON.parse(line), space);
/** The same line written each way a reader may see it. */
const variants = (line: string) => {
  const value = JSON.parse(line) as Record<string, unknown>;
  return [
    line,
    `${line}\r`,
    spaced(line, " "),
    `${spaced(line, "\r")}\r`,
    ` ${line} `,
    JSON.stringify(reversed(value)),
    JSON.stringify(typeLast(value)),
    write(typeLast(value), " "),
  ];
};

const at = { timestamp: "2026-11-10T10:00:00.000Z", ordinal: 7 };
const line = (type: string, payload: unknown) => JSON.stringify({ ...at, type, payload });
const message = (role: string, text: string) =>
  line("response_item", {
    type: "message",
    id: "m",
    role,
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: {},
  });
const call = (type: string, name: string, input: string, extra: object = {}) =>
  line("response_item", {
    type,
    status: "completed",
    id: "c",
    ...extra,
    name,
    [type === "custom_tool_call" ? "input" : "arguments"]: input,
    call_id: "c",
    internal_chat_message_metadata_passthrough: {},
  });
const tokenCount = (tokens: number) =>
  line("event_msg", {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: tokens, cached_input_tokens: 1, output_tokens: 2 },
      last_token_usage: { input_tokens: tokens },
      model_context_window: 1000,
    },
    rate_limits: {},
  });
const taskStarted = (started_at: number) =>
  line("event_msg", { type: "task_started", turn_id: "t", started_at });

const SKILL_PATH = "/home/u/.agents/skills/review/SKILL.md";
const LISTING = [
  "<skills_instructions>",
  "### Available skills",
  `- review: Reviews a branch. (file: ${SKILL_PATH})`,
  "</skills_instructions>",
].join("\n");
const TOOLS = "<tools>\n- mcp__srv: Does things.\n</tools>";
const AGENTS = "# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>";
const MENTION = `<skill>\n<name>review</name>\n<path>${SKILL_PATH}</path>\nBody\n</skill>`;
const SINCE = Date.parse("2026-11-10T09:59:00.000Z") / 1000;

const META = line("session_meta", {
  id: "s",
  timestamp: "2026-11-10T09:59:00.000Z",
  cwd: "/w",
  originator: "codex_cli_rs",
  cli_version: "0.171.0",
  source: "cli",
});
const FORK = line("session_meta", {
  id: "f",
  forked_from_id: "s",
  timestamp: "2026-11-10T09:59:00.000Z",
  originator: "codex_cli_rs",
  source: "cli",
});
const WORLD = line("world_state", {
  full: true,
  state: {
    host_skills: { body: LISTING.split("\n").slice(1, -1).join("\n") },
    agents_md: { text: "Be brief.", directory: "/w" },
    tools: { mcp__srv: "Does things." },
  },
});
const WORLD_TOOLS = line("world_state", { state: { tools: { mcp__other: "x" } } });
const NESTED = TOOLS + MENTION + tokenCount(5) + SKILL_PATH;
const ITEM = line("event_msg", {
  type: "item_completed",
  item: { type: "token_count", text: NESTED },
});
const OUTPUT = line("response_item", {
  type: "custom_tool_call_output",
  id: "o",
  call_id: "c",
  output: { text: NESTED },
});
const REASONING = line("response_item", {
  type: "reasoning",
  id: "r",
  summary: [],
  encrypted_content: NESTED,
});
const COMPACTED = line("compacted", { message: NESTED, replacement_history: [JSON.parse(META)] });

const CRAFTED = [
  META,
  FORK,
  WORLD,
  WORLD_TOOLS,
  line("world_state", { state: {} }),
  line("turn_context", { turn_id: "t", cwd: "/w" }),
  tokenCount(5),
  line("event_msg", { type: "token_count", info: null, rate_limits: {} }),
  taskStarted(SINCE + 1),
  taskStarted(SINCE - 100),
  ITEM,
  line("event_msg", { type: "task_complete", last_agent_message: NESTED }),
  message("developer", LISTING),
  message("developer", TOOLS),
  message("developer", `plain ${NESTED}`),
  message("user", AGENTS),
  message("user", MENTION),
  message("user", `plain ${NESTED}`),
  message("assistant", NESTED),
  call("custom_tool_call", "exec", `cat ${SKILL_PATH}`),
  call("custom_tool_call", "exec", "await tools.mcp__srv__go()"),
  call("custom_tool_call", "exec", "ls"),
  call("custom_tool_call", "apply_patch", `*** ${SKILL_PATH} mcp__srv__go`),
  call("function_call", "go", "{}", { namespace: "mcp__srv" }),
  call("function_call", "mcp__srv__go", "{}"),
  call("function_call", "shell", JSON.stringify({ command: `cat ${SKILL_PATH}` })),
  call("function_call", "shell", JSON.stringify({ command: "ls" })),
  OUTPUT,
  REASONING,
  COMPACTED,
  line("token_usage_record", { thread_id: "t", text: NESTED }),
  // The payload's type after a long member, past the head the rule reads.
  line("event_msg", {
    id: "x".repeat(600),
    type: "token_count",
    info: { last_token_usage: { input_tokens: 5 } },
  }),
  line("response_item", {
    id: "x".repeat(600),
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: MENTION }],
  }),
  // An escaped type or role reads as unknown.
  `{"timestamp":"x","type":"event_\\u006dsg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":4}}}}`,
  `{"timestamp":"x","type":"response_item","payload":{"type":"message","role":"use\\u0072","content":[{"type":"input_text","text":${JSON.stringify(MENTION)}}]}}`,
  JSON.stringify({ type: "response_item", payload: "not an object" }),
  // Not JSON, or cut short.
  META.slice(0, 80),
  "not json",
  "",
];

/** The state after reading these lines in order, as readTranscript reads them. */
const after = (lines: string[]) => {
  const state = codexTranscripts.initial();
  for (const each of lines) codexTranscripts.parse(each, state);
  return state;
};
const STATES: Record<string, CodexState> = {
  "first line of a file": after([]),
  started: after([META]),
  "copying a fork": after([FORK]),
  "fork past its copy": after([FORK, taskStarted(SINCE + 1)]),
  "tokens, nothing listed": after([META, tokenCount(5)]),
  settled: after([META, WORLD, tokenCount(5)]),
  "settled from messages": after([
    META,
    message("developer", LISTING),
    message("developer", TOOLS),
    message("user", AGENTS),
    tokenCount(5),
  ]),
  "skill used this turn": after([META, WORLD, tokenCount(5), message("user", MENTION)]),
};

describe("codexTranscripts.skip", () => {
  it("skips only lines that parse to nothing and leave the state as it was", () => {
    let yes = 0;
    let all = 0;
    for (const each of CRAFTED.flatMap((crafted) =>
      crafted.startsWith("{") && crafted.endsWith("}") ? variants(crafted) : [crafted],
    )) {
      for (const state of Object.values(STATES)) {
        all += 1;
        if (skipped(each, state)) yes += 1;
      }
    }
    // The property holds without being vacuous.
    expect(yes).toBeGreaterThan(all / 4);
  });

  it("keeps every line of the fixture that does something, read in order", async () => {
    const lines = (await NodeFSP.readFile(FIXTURE, "utf8")).split("\n").filter(Boolean);
    for (const variant of [
      (each: string) => each,
      (each: string) => `${each}\r`,
      (each: string) => spaced(each, " "),
    ]) {
      const current = codexTranscripts.initial();
      let yes = 0;
      for (const each of lines.map(variant)) {
        if (skipped(each, current)) yes += 1;
        else if (codexTranscripts.markers.some((marker) => each.includes(marker)))
          codexTranscripts.parse(each.replace(/\r$/u, ""), current);
      }
      expect(yes).toBeGreaterThan(0);
    }
  });

  it("decides the lines the scan spends its time on", () => {
    const settled = STATES.settled!;
    for (const each of [OUTPUT, REASONING, ITEM, META]) expect(skipped(each, settled)).toBe(true);
    expect(skipped(call("custom_tool_call", "exec", "ls"), settled)).toBe(true);
    expect(skipped(OUTPUT, STATES["first line of a file"]!)).toBe(true);
    // A fork's copied compaction is its parent's.
    expect(skipped(COMPACTED, STATES["copying a fork"]!)).toBe(true);

    expect(skipped(META, STATES["first line of a file"]!)).toBe(false);
    expect(skipped(tokenCount(5), STATES.started!)).toBe(false);
    // Every token count moves the usage totals, and every compaction counts.
    expect(skipped(tokenCount(5), settled)).toBe(false);
    expect(skipped(tokenCount(5), STATES["copying a fork"]!)).toBe(false);
    expect(skipped(COMPACTED, settled)).toBe(false);
    expect(skipped(line("turn_context", { model: "gpt-6" }), settled)).toBe(false);
    expect(skipped(taskStarted(SINCE + 1), STATES["copying a fork"]!)).toBe(false);
    expect(skipped(call("custom_tool_call", "exec", `cat ${SKILL_PATH}`), settled)).toBe(false);
    expect(skipped(call("function_call", "go", "{}", { namespace: "mcp__srv" }), settled)).toBe(
      false,
    );
    expect(skipped(message("user", MENTION), settled)).toBe(false);
    expect(skipped(WORLD, STATES.started!)).toBe(false);
  });
});

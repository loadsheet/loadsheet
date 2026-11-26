import { Buffer } from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { LineBytes } from "@loadsheet/kit";
import { describe, expect, it } from "vite-plus/test";
import { claudeTranscripts, type ClaudeState } from "../src/index.ts";

const FIXTURE = NodePath.join(import.meta.dirname, "fixtures/claude-code/session.jsonl");

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
const skipped = (line: string, state: ClaudeState) => {
  const buffer = Buffer.from(line);
  const before = structuredClone(state);
  const said = claudeTranscripts.skip!(bytes(buffer), state);
  expect(state).toEqual(before);
  if (said) {
    const copy = structuredClone(state);
    const text = buffer.toString("utf8").replace(/\r$/u, "");
    expect(claudeTranscripts.parse(text, copy), line.slice(0, 300)).toEqual([]);
    expect(copy, line.slice(0, 300)).toEqual(state);
  }
  return said;
};

const spaced = (line: string) => JSON.stringify(JSON.parse(line), null, 1).replace(/\n\s*/gu, " ");
/** The same line written each way a reader may see it. */
const variants = (line: string) => [
  line,
  `${line}\r`,
  spaced(line),
  `${spaced(line)}\r`,
  ` ${line} `,
];

const state = (fields: Partial<ClaudeState> = {}): ClaudeState => ({
  ...claudeTranscripts.initial(),
  ...fields,
});
const day = "2026-11-10";
const STATES: Record<string, ClaudeState> = {
  "first line of a file": state(),
  "not started": state({ day, via: "cli" }),
  "started, no tokens": state({ day, via: "cli", started: true }),
  settled: state({ day, via: "cli", started: true, tokens: true, listed: { "skill:a": true } }),
  "pending command": state({ day, via: "cli", started: true, tokens: true, command: "a" }),
  "pending mcp": state({ day, via: "cli", started: true, tokens: true, mcp: { srv: 12 } }),
  "pending project": state({
    day,
    via: "cli",
    started: true,
    tokens: true,
    project: { "instructions:project/CLAUDE.md": 3 },
  }),
};

// Real Claude Code key orders: the type before the message on user lines, after it on assistant and
// attachment lines.
const at = { timestamp: "2026-11-10T10:00:00.000Z", entrypoint: "cli", version: "2.1.0" };
const NESTED = JSON.stringify({
  parentUuid: null,
  isSidechain: false,
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "a" } }] },
});
/** A nested object that reads as a quiet assistant line. */
const QUIET = { type: "assistant", message: { content: [{ type: "text", text: "x" }] } };
const user = (side: boolean, content: unknown, extra: object = {}) =>
  JSON.stringify({
    parentUuid: "4f1c2d3e-0000-4000-8000-000000000000",
    isSidechain: side,
    promptId: "p",
    type: "user",
    message: { role: "user", content },
    ...extra,
    uuid: "u",
    ...at,
  });
const assistant = (side: boolean, content: unknown[], model = "claude-opus-5-5", after = {}) =>
  JSON.stringify({
    parentUuid: "4f1c2d3e-0000-4000-8000-000000000000",
    isSidechain: side,
    message: {
      model,
      type: "message",
      role: "assistant",
      content,
      usage: { input_tokens: 3, cache_read_input_tokens: 10 },
    },
    type: "assistant",
    uuid: "u",
    ...after,
    ...at,
  });
const attachment = (side: boolean, body: object) =>
  JSON.stringify({
    parentUuid: "x",
    isSidechain: side,
    attachment: body,
    type: "attachment",
    ...at,
  });
const tool = (name: string, input: object = {}) => ({ type: "tool_use", id: "t", name, input });

const ATTACHMENTS = [
  { type: "skill_listing", names: ["b"], content: "- b: does b" },
  {
    type: "agent_listing_delta",
    addedTypes: ["helper"],
    addedLines: ["- helper: helps"],
    builtInTypes: ["Explore"],
  },
  { type: "mcp_instructions_delta", addedNames: ["srv2"], addedBlocks: ["use it"] },
  { type: "deferred_tools_delta", addedNames: ["mcp__srv3__go"], addedLines: ["mcp__srv3__go"] },
  {
    type: "instructions",
    files: [
      { path: "/home/jo/.claude/CLAUDE.md", type: "User", content: "abc" },
      { path: "/home/jo/app/CLAUDE.md", type: "Project", content: "de" },
    ],
  },
  { type: "environment", rest: "x" },
  { type: "prompt_snapshot", text: `"type":"skill_listing" ${NESTED}` },
  { type: "file", content: '"names":["c"]' },
];

const CRAFTED = [
  JSON.stringify({ type: "api-request", body: NESTED, ...at }),
  JSON.stringify({ type: "queue-operation", operation: "enqueue", ...at }),
  JSON.stringify({
    type: "user",
    isSidechain: false,
    message: { role: "user", content: "hi" },
    ...at,
  }),
  JSON.stringify({ type: "system", subtype: "x", ...at }),
  ...[false, true].flatMap((side) => [
    user(side, [{ type: "tool_result", tool_use_id: "t", content: NESTED }]),
    user(side, [{ type: "tool_result", content: [{ type: "text", text: NESTED }] }], {
      toolUseResult: { stdout: NESTED },
    }),
    user(side, "<command-message>a</command-message>\n<command-name>/a</command-name>"),
    user(side, "<command-message>clear</command-message>\n<command-name>/clear</command-name>"),
    user(side, [{ type: "text", text: "expanded" }], { isMeta: true }),
    user(side, "plain prompt"),
    assistant(side, [{ type: "thinking", thinking: NESTED }]),
    assistant(side, [{ type: "text", text: "done" }]),
    assistant(side, [{ type: "text", text: "x" }], "<synthetic>"),
    assistant(side, [tool("Bash", { command: NESTED })]),
    assistant(side, [tool("Skill", { skill: "a" })]),
    assistant(side, [tool("Skill", { skill: "/b" })]),
    assistant(side, [tool("Agent", { subagent_type: "helper" })]),
    assistant(side, [tool("Task", {})]),
    assistant(side, [tool("mcp__srv__go")]),
    assistant(side, [{ type: "text", text: "tool_use" }]),
    // The type sits between objects: neither end of the line shows it.
    assistant(side, [tool("Skill", { skill: "a" })], undefined, { toolUseResult: { a: 1 } }),
    assistant(side, [{ type: "text", text: "x" }], undefined, { toolUseResult: { a: 1 } }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: side,
      type: "system",
      subtype: "turn_duration",
      ...at,
    }),
    ...ATTACHMENTS.map((body) => attachment(side, body)),
  ]),
  // The type between objects, and an unescaped `"type":"assistant"` in a nested object.
  ...[false, true].flatMap((side) => [
    JSON.stringify({
      parentUuid: null,
      isSidechain: side,
      message: {
        role: "user",
        content: "<command-message>a</command-message>\n<command-name>/a</command-name>",
      },
      type: "user",
      toolUseResult: QUIET,
      ...at,
    }),
    // A key whose escaped quote makes it end in `"type":`.
    JSON.stringify({
      parentUuid: null,
      isSidechain: side,
      message: {
        role: "user",
        content: "<command-message>a</command-message>\n<command-name>/a</command-name>",
      },
      type: "user",
      toolUseResult: {},
      'x"type': "assistant",
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: side,
      message: { role: "assistant", content: [tool("Skill", { skill: "a" })] },
      type: "assistant",
      toolUseResult: { type: "user", content: "<command-message>" },
      ...at,
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: side,
      attachment: { files: [], type: "instructions" },
      type: "attachment",
      toolUseResult: JSON.parse(NESTED),
      ...at,
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: side,
      attachment: { text: JSON.parse(NESTED), type: "skill_listing", names: ["z"], content: "- z" },
      type: "attachment",
      ...at,
    }),
  ]),
  ...[false, true].flatMap((side) => [
    // A slash command after whitespace, or in a text block after a tool result.
    user(side, " \n\t<command-message>a</command-message><command-name>a</command-name>"),
    user(side, [
      { type: "tool_result", tool_use_id: "t", content: "x" },
      {
        type: "text",
        text: "<command-message>a</command-message>\n<command-name>/a</command-name>",
      },
    ]),
    // Keys that hold the parts searched for first, but not the names.
    assistant(side, [tool("Bash", { MySkill: 1, MyAgent: 1, a__b: 1, my_use: 1, my_type: 1 })]),
    assistant(side, [tool("Agent", { subagent_type: "Explore" })]),
    assistant(side, [tool("Task", { description: "x" })], undefined, { attributionAgent: "x" }),
    assistant(side, [{ type: "text", text: "x", MySkill: 1, my_use: 1 }]),
    // A counted tool after one that is not.
    assistant(side, [tool("Bash"), tool("Skill", { skill: "a" })]),
    assistant(side, [tool("Read"), tool("mcp__srv__go")]),
    // Last members of every scalar kind, and a string that ends in `"type`.
    assistant(side, [tool("Skill", { skill: "a" })], undefined, {
      slug: '"type',
      n: -1.5e3,
      ok: true,
      none: null,
    }),
    // A `"type"` key in a nested object that is the last member.
    JSON.stringify({
      parentUuid: null,
      isSidechain: side,
      message: { role: "assistant", content: [tool("Skill", { skill: "a" })] },
      type: "assistant",
      extra: { type: "system" },
    }),
  ]),
  JSON.stringify({ type: "system" }),
  // Key orders Claude Code does not write: isSidechain after an object, or as a string.
  JSON.stringify({
    message: { role: "user", content: "hi" },
    type: "user",
    isSidechain: true,
    ...at,
  }),
  JSON.stringify({ parentUuid: null, isSidechain: "true", type: "assistant", message: {}, ...at }),
  JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    type: "attachment",
    attachment: ATTACHMENTS[0],
    ...at,
  }),
  // Not JSON, or cut short.
  '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"content":"<command-message>a',
  "not json",
  "",
];

describe("claudeTranscripts.skip", () => {
  it("skips only lines that parse to nothing and leave the state as it was", () => {
    let yes = 0;
    let all = 0;
    for (const line of CRAFTED.flatMap((line) =>
      line.startsWith("{") && line.endsWith("}") ? variants(line) : [line],
    )) {
      for (const each of Object.values(STATES)) {
        all += 1;
        if (skipped(line, each)) yes += 1;
      }
    }
    // The property holds without being vacuous.
    expect(yes).toBeGreaterThan(all / 4);
  });

  it("keeps every line of the fixture that does something, read in order", async () => {
    const lines = (await NodeFSP.readFile(FIXTURE, "utf8")).split("\n").filter(Boolean);
    // The fixture's keys are sanitized; restore the first one so its lines have Claude Code's head.
    for (const file of [
      lines,
      lines.map((line) => line.replace(/^\{"key-2":/u, '{"parentUuid":')),
    ]) {
      for (const variant of [(line: string) => line, (line: string) => `${line}\r`, spaced]) {
        const current = claudeTranscripts.initial();
        let yes = 0;
        for (const line of file.map(variant)) {
          if (skipped(line, current)) yes += 1;
          else if (line.includes('"entrypoint"'))
            claudeTranscripts.parse(line.replace(/\r$/u, ""), current);
        }
        expect(yes).toBeGreaterThan(0);
      }
    }
  });

  it("decides the lines the scan spends its time on", () => {
    const settled = STATES.settled!;
    expect(skipped(CRAFTED[0]!, STATES["first line of a file"]!)).toBe(true);
    expect(skipped(user(false, [{ type: "tool_result", content: NESTED }]), settled)).toBe(true);
    expect(
      skipped(user(true, [{ type: "tool_result", content: NESTED }]), STATES["not started"]!),
    ).toBe(true);
    expect(skipped(assistant(true, [tool("Bash")]), STATES["not started"]!)).toBe(true);
    expect(skipped(attachment(false, ATTACHMENTS[6]!), settled)).toBe(true);

    expect(
      skipped(user(false, [{ type: "tool_result", content: NESTED }]), STATES["pending command"]!),
    ).toBe(false);
    expect(
      skipped(user(false, [{ type: "tool_result", content: NESTED }]), STATES["pending mcp"]!),
    ).toBe(false);
    expect(skipped(assistant(false, [tool("Bash")]), STATES["started, no tokens"]!)).toBe(false);
    expect(skipped(assistant(false, [tool("mcp__srv__go")]), settled)).toBe(false);
    for (const body of ATTACHMENTS.slice(0, 5))
      expect(skipped(attachment(false, body), settled)).toBe(false);
  });
});

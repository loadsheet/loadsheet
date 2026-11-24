import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findCanary } from "@loadsheet/fixtures";
import type { Fact, ListedFact, TranscriptFormat } from "@loadsheet/kit";
import { readTranscript, type ReadPosition } from "@loadsheet/kit/node";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { claudeTranscripts, instructionName, type ClaudeState } from "../src/index.ts";

const FIXTURE = NodePath.join(import.meta.dirname, "fixtures/claude-code/session.jsonl");

/** Facts from every line, the way readTranscript feeds them: only lines carrying a marker. */
const parseAll = (lines: readonly string[], state = claudeTranscripts.initial()) => {
  const facts: Fact[] = [];
  for (const line of lines) {
    if (claudeTranscripts.markers.some((marker) => line.includes(marker))) {
      facts.push(...claudeTranscripts.parse(line, state));
    }
  }
  return { facts, state };
};

const fixtureLines = async () =>
  (await NodeFSP.readFile(FIXTURE, "utf8")).split("\n").filter(Boolean);

const at = { day: "2026-11-10", via: "sdk-ts" } as const;
const listedOf = (facts: readonly Fact[], prefix: string) =>
  facts.filter(
    (fact): fact is ListedFact => fact.type === "listed" && fact.item.startsWith(prefix),
  );

// Counted by hand from session.jsonl with jq: the skill_listing attachment has 103 names and 103
// lines, 36 of them a bare `- name` of 650 characters in all, of 28,941 characters with their newlines; the subagent
// listing adds two plugin subagents beside its five built-ins; server-1 has a 2,134-character
// instructions block and six deferred tool lines of 133 characters, server-2 69 lines of 2,222.
describe("a sanitized Claude Code session", () => {
  it("parses to the Facts counted by hand", async () => {
    const { facts } = parseAll(await fixtureLines());

    expect(facts.filter((fact) => fact.type === "session")).toEqual([
      { type: "session", ...at, version: "2.1.322" },
    ]);
    // The first assistant line's usage: 2 input, 31,690 cache creation, 18,594 cache read.
    expect(facts.filter((fact) => fact.type === "tokens")).toEqual([
      { type: "tokens", ...at, tokens: 50286 },
    ]);

    const skills = listedOf(facts, "skill:");
    expect(skills).toHaveLength(103);
    expect(skills.filter((fact) => fact.bare)).toHaveLength(36);
    expect(skills.filter((fact) => fact.bare).reduce((sum, fact) => sum + fact.chars, 0)).toBe(650);
    expect(skills.reduce((sum, fact) => sum + fact.chars, 0)).toBe(28941);
    const chars = Object.fromEntries(skills.map((fact) => [fact.item, fact.chars]));
    expect(chars).toMatchObject({
      "skill:skill-34": 208,
      "skill:skill-39": 139,
      "skill:skill-42": 47,
      "skill:skill-45": 151,
    });
    expect(chars["skill:pack-1:skill-47"]).toBeGreaterThan(0);

    expect(listedOf(facts, "subagent:")).toEqual([
      { type: "listed", ...at, item: "subagent:pack-1:agent-2", chars: 113, bare: false },
      { type: "listed", ...at, item: "subagent:pack-1:agent-3", chars: 487, bare: false },
    ]);
    expect(listedOf(facts, "mcp:")).toEqual([
      { type: "listed", ...at, item: "mcp:server-1", chars: 2134 + 133, bare: false },
      { type: "listed", ...at, item: "mcp:server-2", chars: 2222, bare: false },
    ]);
    expect(listedOf(facts, "instructions:")).toEqual([
      { type: "listed", ...at, item: "instructions:CLAUDE.md", chars: 6586, bare: false },
      { type: "listed", ...at, item: "instructions:file-1.md", chars: 1167, bare: false },
      { type: "listed", ...at, item: "instructions:file-2.md", chars: 2782, bare: false },
      { type: "listed", ...at, item: "instructions:dir-5/AGENTS.md", chars: 20155, bare: false },
      { type: "listed", ...at, item: "instructions:memory/MEMORY.md", chars: 703, bare: false },
    ]);

    // Two Skill calls, two slash commands, one general-purpose Agent (built in, so not counted)
    // and three calls to server-2's tools.
    expect(facts.filter((fact) => fact.type === "used")).toEqual([
      { type: "used", ...at, item: "skill:skill-45", by: "model" },
      { type: "used", ...at, item: "skill:skill-39", by: "user" },
      { type: "used", ...at, item: "skill:skill-34", by: "model" },
      { type: "used", ...at, item: "mcp:server-2", by: "model" },
      { type: "used", ...at, item: "skill:skill-42", by: "user" },
      { type: "used", ...at, item: "mcp:server-2", by: "model" },
      { type: "used", ...at, item: "mcp:server-2", by: "model" },
    ]);
    expect(facts).toHaveLength(1 + 1 + 103 + 2 + 2 + 5 + 7);
  });

  it("lets no fixture text into its Facts or its State", async () => {
    const { facts, state } = parseAll(await fixtureLines());
    expect(findCanary(facts)).toEqual([]);
    expect(findCanary(JSON.parse(JSON.stringify(state)))).toEqual([]);
  });

  it("would catch a parser that copies text from a line", async () => {
    const leaky: TranscriptFormat<ClaudeState> = {
      ...claudeTranscripts,
      parse: (line, state) =>
        claudeTranscripts.parse(line, state).map((fact) => ({ ...fact, via: line.slice(0, 2000) })),
    };
    const lines = await fixtureLines();
    const facts = lines.flatMap((line) => leaky.parse(line, claudeTranscripts.initial()));
    expect(findCanary(facts).length).toBeGreaterThan(0);
  });

  describe("read through readTranscript", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-claude-"));
    });
    afterEach(async () => {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    });

    it("gives the same Facts in two reads, resumed from the saved position, as in one", async () => {
      const text = await NodeFSP.readFile(FIXTURE, "utf8");
      const whole = await readTranscript(FIXTURE, claudeTranscripts);
      expect(whole?.records).toHaveLength(121);

      const lines = text.split("\n");
      // Split after the skill listing and before the turn that flushes the MCP servers.
      const cut = lines.findIndex((line) => line.includes('"skill_listing"')) + 1;
      const path = NodePath.join(dir, "session.jsonl");
      await NodeFSP.writeFile(path, `${lines.slice(0, cut).join("\n")}\n`);
      const first = await readTranscript(path, claudeTranscripts);
      // The cache holds the position as JSON.
      const saved = JSON.parse(JSON.stringify(first!.position)) as ReadPosition;
      await NodeFSP.appendFile(path, lines.slice(cut).join("\n"));
      const second = await readTranscript(path, claudeTranscripts, saved);

      expect(second?.resumed).toBe(true);
      expect([...first!.records, ...second!.records]).toEqual(whole!.records);
    });
  });
});

describe("claudeTranscripts", () => {
  const line = (value: Record<string, unknown>) =>
    JSON.stringify({
      timestamp: "2026-03-01T23:30:00.000-02:00",
      entrypoint: "cli",
      version: "2.1.0",
      ...value,
    });
  const attachment = (value: Record<string, unknown>) =>
    line({ type: "attachment", attachment: value });
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
    line({
      type: "assistant",
      message: { model: "m", content, usage: { input_tokens: 3 } },
      ...extra,
    });
  const skillCall = (skill: string) => ({ type: "tool_use", name: "Skill", input: { skill } });

  it("dates a session by its UTC start day and counts a bare listing entry", () => {
    const { facts } = parseAll([
      attachment({
        type: "skill_listing",
        names: ["a", "b", "ab"],
        content: "- a: Does a.\n- b\n- ab: Does\nab.",
      }),
    ]);
    expect(facts).toEqual([
      { type: "session", day: "2026-03-02", via: "cli", version: "2.1.0" },
      {
        type: "listed",
        day: "2026-03-02",
        via: "cli",
        item: "skill:a",
        chars: "- a: Does a.\n".length,
        bare: false,
      },
      {
        type: "listed",
        day: "2026-03-02",
        via: "cli",
        item: "skill:b",
        chars: "- b\n".length,
        bare: true,
      },
      {
        type: "listed",
        day: "2026-03-02",
        via: "cli",
        item: "skill:ab",
        chars: "- ab: Does\nab.\n".length,
        bare: false,
      },
    ]);
  });

  it("counts a skill command only when its expansion follows, and never a built-in command", () => {
    const { facts } = parseAll([
      line({ type: "user", message: { content: "<command-name>/compact</command-name>" } }),
      line({
        type: "user",
        message: {
          content: "<command-message>x</command-message>\n<command-name>/x</command-name>",
        },
      }),
      line({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "body" }] } }),
      line({
        type: "user",
        message: {
          content: "<command-message>model</command-message>\n<command-name>/model</command-name>",
        },
      }),
      line({ type: "user", message: { content: "next prompt" } }),
    ]);
    expect(facts.filter((fact) => fact.type === "used")).toEqual([
      { type: "used", day: "2026-03-02", via: "cli", item: "skill:x", by: "user" },
    ]);
  });

  it("skips synthetic usage, counts each listed item once and names custom subagents only", () => {
    const { facts } = parseAll([
      attachment({
        type: "agent_listing_delta",
        addedTypes: ["Explore", "rev"],
        addedLines: ["- Explore: E (Tools: *)", "- rev: R (Tools: Read)"],
        builtInTypes: ["Explore"],
      }),
      attachment({
        type: "agent_listing_delta",
        addedTypes: ["rev"],
        addedLines: ["- rev: R (Tools: Read)"],
        builtInTypes: [],
      }),
      assistant([], { message: { model: "<synthetic>", content: [], usage: { input_tokens: 9 } } }),
      assistant([{ type: "tool_use", name: "Agent", input: { subagent_type: "Explore" } }]),
      assistant([
        { type: "tool_use", name: "Task", input: { subagent_type: "rev" } },
        skillCall("/p:s"),
      ]),
    ]);
    expect(facts.filter((fact) => fact.type !== "session")).toEqual([
      {
        type: "listed",
        day: "2026-03-02",
        via: "cli",
        item: "subagent:rev",
        chars: "- rev: R (Tools: Read)\n".length,
        bare: false,
      },
      { type: "tokens", day: "2026-03-02", via: "cli", tokens: 3 },
      { type: "used", day: "2026-03-02", via: "cli", item: "subagent:rev", by: "model" },
      { type: "used", day: "2026-03-02", via: "cli", item: "skill:p:s", by: "model" },
    ]);
  });

  // A subagent's transcript carries its parent's session id: counting its session, listing or
  // tokens again would count the parent session twice, so only what it used is counted.
  it("counts only what a subagent's own transcript used", () => {
    const side = { isSidechain: true, agentId: "a1" };
    const { facts } = parseAll([
      line({ type: "user", ...side, message: { content: "task" } }),
      line({
        type: "attachment",
        ...side,
        attachment: { type: "skill_listing", names: ["a"], content: "- a: A" },
      }),
      line({
        type: "attachment",
        ...side,
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["srv"],
          addedBlocks: ["## srv"],
        },
      }),
      assistant([skillCall("a"), { type: "tool_use", name: "mcp__srv__q", input: {} }], side),
    ]);
    expect(facts).toEqual([
      { type: "used", day: "2026-03-02", via: "cli", item: "skill:a", by: "model" },
      { type: "used", day: "2026-03-02", via: "cli", item: "mcp:srv", by: "model" },
    ]);
  });

  it("puts no unsafe entrypoint, name or path in a Fact", () => {
    const { facts } = parseAll([
      line({ type: "user", entrypoint: "/home/jo/bin", message: { content: "hi" } }),
      attachment({
        type: "skill_listing",
        names: ["has space", "<x>"],
        content: "- has space: A\n- <x>: B",
      }),
      attachment({
        type: "instructions",
        files: [
          { path: "/home/jo/CLAUDE.md", type: "Project", content: "x" },
          { path: "/Users/jo/work/app/.claude/rules/a.md", type: "Project", content: "xy" },
          { path: "/home/jo/.claude/rules/team/b.md", type: "User", content: "xyz" },
        ],
      }),
    ]);
    expect(facts).toEqual([
      { type: "session", day: "2026-03-02", via: "unknown", version: "2.1.0" },
      {
        type: "listed",
        day: "2026-03-02",
        via: "unknown",
        item: "instructions:~/CLAUDE.md",
        chars: 1,
        bare: false,
      },
      {
        type: "listed",
        day: "2026-03-02",
        via: "unknown",
        item: "instructions:app/.claude/rules/a.md",
        chars: 2,
        bare: false,
      },
      {
        type: "listed",
        day: "2026-03-02",
        via: "unknown",
        item: "instructions:rules/team/b.md",
        chars: 3,
        bare: false,
      },
    ]);
    expect(findCanary(facts, ["jo"])).toEqual([]);
  });

  it("names auto memory the same for every project", () => {
    expect(
      instructionName("/home/jo/.claude/projects/-home-jo-app/memory/MEMORY.md", "AutoMem"),
    ).toBe("memory/MEMORY.md");
  });
});

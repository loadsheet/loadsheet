import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findCanary } from "@loadsheet/fixtures";
import { memoryFiles, type Fact, type TranscriptFormat } from "@loadsheet/kit";
import { readTranscript, type ReadPosition } from "@loadsheet/kit/node";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  codex,
  codexListedChars,
  codexTranscripts,
  readCodexConfig,
  type CodexState,
} from "../src/index.ts";

const FIXTURE = NodePath.join(import.meta.dirname, "fixtures/codex/session.jsonl");
const machine = codex.machine;

/** Runs lines through the format the way readTranscript does, markers included. */
const parseAll = (lines: unknown[], format: TranscriptFormat<CodexState> = codexTranscripts) => {
  const state = format.initial();
  const facts: Fact[] = [];
  for (const value of lines) {
    const line = typeof value === "string" ? value : JSON.stringify(value);
    if (!format.markers.some((marker) => line.includes(marker))) continue;
    facts.push(...format.parse(line, state));
  }
  return { facts, state };
};

const meta = (payload: Record<string, unknown> = {}) => ({
  timestamp: "2026-11-09T23:59:00.000Z",
  type: "session_meta",
  payload: {
    timestamp: "2026-11-09T23:58:59.000Z",
    originator: "codex_cli_rs",
    cli_version: "0.171.0",
    source: "cli",
    ...payload,
  },
});
const developer = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] },
});
const user = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const exec = (input: string) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name: "exec", input },
});
const turn = { type: "turn_context", payload: {} };
const taskStarted = { type: "event_msg", payload: { type: "task_started" } };

const skillsSection = (lines: string[], roots: string[]) =>
  [
    "<skills_instructions>",
    "## Skills",
    "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file.",
    "### Skill roots",
    ...roots.map((root, index) => `- \`r${index}\` = \`${root}\``),
    "### Available skills",
    ...lines,
    "- 2 additional skills omitted from this bounded skills list.",
    "### How to use skills",
    "- Discovery: The list above is the skills available in this session.",
    "</skills_instructions>",
  ].join("\n");

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;

const count = (facts: readonly Fact[]) => {
  const out: Record<string, number> = {};
  for (const fact of facts) {
    const key = fact.type === "used" ? `used:${fact.by}` : fact.type;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

describe("codex listing", () => {
  const roots = ["/home/u/.agents/skills", "/home/u/.codex/plugins/cache/m/p/1.0.0/skills"];
  const lines = [
    "- review: Reviews a branch. (file: r0/review/SKILL.md)",
    "- p:lint: (file: r1/lint/SKILL.md)",
    "- notes: Keeps notes: one per day. (file: r0/nested/notes/SKILL.md)",
  ];

  it("counts each listed line and its newline, bare when it has no description", () => {
    const { facts } = parseAll([meta(), developer(skillsSection(lines, roots))]);
    expect(facts.filter((fact) => fact.type === "listed")).toEqual([
      {
        type: "listed",
        day: "2026-11-09",
        via: "codex_cli_rs",
        item: "skill:review",
        chars: codexListedChars("review", "Reviews a branch.", "r0/review/SKILL.md"),
        bare: false,
      },
      {
        type: "listed",
        day: "2026-11-09",
        via: "codex_cli_rs",
        item: "skill:p:lint",
        chars: "- p:lint: (file: r1/lint/SKILL.md)\n".length,
        bare: true,
      },
      {
        type: "listed",
        day: "2026-11-09",
        via: "codex_cli_rs",
        item: "skill:notes",
        chars: lines[2]!.length + 1,
        bare: false,
      },
    ]);
  });

  it("gives an installed skill the chars of the line Codex lists for it", async () => {
    const files = memoryFiles({
      "~/.agents/skills/review/SKILL.md": skillMd("review", "Reviews\n  a branch."),
    });
    const [item] = await machine.inventory(files);
    const { facts } = parseAll([meta(), developer(skillsSection([lines[0]!], roots))]);
    expect(item?.chars.listed).toBe(lines[0]!.length + 1);
    expect(facts.find((fact) => fact.type === "listed")).toMatchObject({
      item: item?.id,
      chars: item?.chars.listed,
    });
  });

  it("reads the listing once, from world_state when it comes first", () => {
    const body = skillsSection(lines, roots).replace(
      /^<skills_instructions>|<\/skills_instructions>$/gu,
      "",
    );
    const world = {
      type: "world_state",
      payload: { full: true, state: { host_skills: { body } } },
    };
    const { facts } = parseAll([meta(), world, developer(skillsSection(lines, roots))]);
    expect(facts.filter((fact) => fact.type === "listed")).toHaveLength(3);
  });

  it("infers a model use from a read of a listed SKILL.md, once per turn", () => {
    const { facts } = parseAll([
      meta(),
      developer(skillsSection(lines, roots)),
      turn,
      exec(
        'await tools.exec_command({ cmd: "sed -n 1,200p /home/u/.agents/skills/review/SKILL.md" })',
      ),
      exec("cat /home/u/.agents/skills/review/SKILL.md ~/x/{lint,other}/SKILL.md"),
      exec("cat nested/notes/SKILL.md /elsewhere/unknown/SKILL.md"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "/home/u/.agents/skills/review/SKILL.md",
        },
      },
      turn,
      exec("cat /home/u/.agents/skills/review/SKILL.md"),
    ]);
    expect(
      facts.flatMap((fact) => (fact.type === "used" ? [`${fact.item} ${fact.by}`] : [])),
    ).toEqual([
      "skill:review model",
      "skill:p:lint model",
      "skill:notes model",
      "skill:review model",
    ]);
  });

  it("counts a `<skill>` message as the user's use, and no model use of it in that turn", () => {
    const { facts } = parseAll([
      meta(),
      developer(skillsSection(lines, roots)),
      turn,
      user(
        "<skill>\n<name>review</name>\n<path>/home/u/.agents/skills/review/SKILL.md</path>\nBody",
      ),
      exec("cat /home/u/.agents/skills/review/SKILL.md"),
    ]);
    expect(facts.filter((fact) => fact.type === "used")).toEqual([
      { type: "used", day: "2026-11-09", via: "codex_cli_rs", item: "skill:review", by: "user" },
    ]);
  });
});

describe("codex sessions", () => {
  it("emits the session once, from the first session_meta, with its UTC day", () => {
    const { facts } = parseAll([
      meta({ timestamp: "2026-11-10T01:00:00+02:00" }),
      meta({ originator: "other" }),
    ]);
    expect(facts).toEqual([
      { type: "session", day: "2026-11-09", via: "codex_cli_rs", version: "0.171.0" },
    ]);
  });

  it("falls back to the source for via, and to subagent", () => {
    const via = (payload: Record<string, unknown>) =>
      parseAll([meta({ originator: undefined, ...payload })]).facts[0];
    expect(via({ source: "exec" })).toMatchObject({ via: "exec" });
    expect(via({ source: { subagent: { thread_spawn: {} } } })).toMatchObject({ via: "subagent" });
  });

  describe("AGENTS.md", () => {
    const folder = "/work/zebra-orchard-42";
    const fragment = (header: string, text: string) =>
      user(`# AGENTS.md instructions${header}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`);
    const world = (text: string, directory?: string) => ({
      type: "world_state",
      payload: { full: true, state: { agents_md: { text, ...(directory ? { directory } : {}) } } },
    });
    const instructions = (lines: object[]) =>
      parseAll([meta(), ...lines]).facts.flatMap((fact) =>
        fact.type === "listed" ? [[fact.item, fact.chars, fact.bare]] : [],
      );
    const both = "Mine.\n\n--- project-doc ---\n\nRoot doc.\n\nNested doc.";
    const mine = ["instructions:~/.codex/AGENTS.md", 5, false];
    const project = ["instructions:project/AGENTS.md", "Root doc.\n\nNested doc.".length, false];

    it("counts the user's part and the project's part of a `for <dir>` fragment", () => {
      expect(instructions([fragment(` for ${folder}`, both)])).toEqual([mine, project]);
      expect(instructions([world(both, folder)])).toEqual([mine, project]);
    });

    it("counts only the project's part when a `for <dir>` fragment has no separator", () => {
      const only = ["instructions:project/AGENTS.md", "Only the project's.".length, false];
      expect(instructions([fragment(` for ${folder}`, "Only the project's.")])).toEqual([only]);
      expect(instructions([world("Only the project's.", folder)])).toEqual([only]);
    });

    it("counts all of a bare fragment as the user's", () => {
      expect(instructions([fragment("", "Mine.")])).toEqual([mine]);
      expect(instructions([world("Mine.")])).toEqual([mine]);
    });

    it("emits nothing for an empty part", () => {
      expect(
        instructions([fragment(` for ${folder}`, "\n\n--- project-doc ---\n\nRoot doc.")]),
      ).toEqual([["instructions:project/AGENTS.md", 9, false]]);
      expect(
        instructions([fragment(` for ${folder}`, "Mine.\n\n--- project-doc ---\n\n")]),
      ).toEqual([mine]);
    });

    it("reads the first fragment of a session only", () => {
      expect(
        instructions([
          world(both, folder),
          fragment(` for ${folder}`, both),
          turn,
          fragment(" for /other", "Other doc."),
        ]),
      ).toEqual([mine, project]);
    });

    it("keeps a fork's copied fragment, once", () => {
      const facts = parseAll([
        meta({ forked_from_id: "parent" }),
        fragment(` for ${folder}`, both),
        taskStarted,
        turn,
        fragment(` for ${folder}`, both),
      ]).facts;
      expect(count(facts)).toEqual({ session: 1, listed: 2 });
    });

    it("keeps the header's folder out of every Fact", () => {
      const facts = [
        world(both, folder),
        world("Only the project's.", folder),
        fragment(` for ${folder}`, both),
        fragment(` for ${folder}`, "Only the project's."),
      ].flatMap((line) => parseAll([meta(), line]).facts);
      expect(facts.filter((fact) => fact.type === "listed")).toHaveLength(6);
      expect(JSON.stringify(facts)).not.toContain("zebra-orchard");
      expect(JSON.stringify(facts)).not.toContain("/work");
    });
  });

  it("lists MCP servers from the deferred namespaces and finds their uses in tool calls", () => {
    const { facts } = parseAll([
      meta(),
      developer(
        "<tools>\nDeferred tool namespaces:\n- mcp__exe_cutor: # Executor\n- mcp__exe\n- clock\n</tools>",
      ),
      turn,
      exec("await tools.mcp__exe_cutor__search({}); await tools.mcp__exe_cutor__call({});"),
      {
        type: "response_item",
        payload: { type: "function_call", name: "ping", namespace: "mcp__exe", arguments: "{}" },
      },
      exec("tools.mcp__unlisted__x()"),
    ]);
    expect(facts.filter((fact) => fact.type !== "session")).toEqual([
      {
        type: "listed",
        day: "2026-11-09",
        via: "codex_cli_rs",
        item: "mcp:exe_cutor",
        chars: 29,
        bare: false,
      },
      {
        type: "listed",
        day: "2026-11-09",
        via: "codex_cli_rs",
        item: "mcp:exe",
        chars: 11,
        bare: false,
      },
      { type: "used", day: "2026-11-09", via: "codex_cli_rs", item: "mcp:exe_cutor", by: "model" },
      { type: "used", day: "2026-11-09", via: "codex_cli_rs", item: "mcp:exe", by: "model" },
    ]);
  });

  it("skips the history a fork copied until its own first task, but keeps its listing", () => {
    const tokens = (input_tokens: number) => ({
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens } } },
    });
    const { facts } = parseAll([
      meta({ forked_from_id: "parent" }),
      meta({ originator: "parent" }),
      developer(skillsSection(["- a: A. (file: r0/a/SKILL.md)"], ["/s"])),
      turn,
      user("<skill>\n<name>a</name>"),
      exec("cat /s/a/SKILL.md"),
      tokens(900),
      taskStarted,
      turn,
      exec("cat /s/a/SKILL.md"),
      tokens(1000),
    ]);
    expect(count(facts)).toEqual({ session: 1, listed: 1, "used:model": 1, tokens: 1 });
    expect(facts.find((fact) => fact.type === "tokens")).toMatchObject({ tokens: 1000 });
  });
});

describe("codex fixture", () => {
  // Counted by hand from fixtures/codex/session.jsonl: a T3 Code session of Codex 0.167.0 that
  // lists 134 skills (19,526 chars, 56 of them a plugin's), loads 6,586 chars of the user's AGENTS.md
  // and 3,627 of project docs after it, lists two MCP namespaces (28 and 15 chars), starts with 20,326 input
  // tokens, and reads four listed SKILL.md files in three exec calls. No `<skill>` message.
  const hand = {
    session: { type: "session", day: "2026-11-09", via: "T3 Code", version: "0.167.0" },
    skills: 134,
    skillChars: 19_526,
    instructions: {
      "instructions:~/.codex/AGENTS.md": 6586,
      "instructions:project/AGENTS.md": 3627,
    },
    mcp: { "mcp:executor": 28, "mcp:t3_code": 15 },
    tokens: 20_326,
    used: [
      "skill:skill-3",
      "skill:skill-119",
      "skill:plugin-1:skill-107",
      "skill:plugin-1:skill-96",
    ],
  };

  const readFixture = async () => {
    const result = await readTranscript(FIXTURE, codexTranscripts);
    expect(result).not.toBeNull();
    return result!;
  };

  it("parses to the Facts counted by hand", async () => {
    const { records, skippedLines } = await readFixture();
    const listed = records.filter((fact) => fact.type === "listed");
    const skills = listed.filter((fact) => fact.item.startsWith("skill:"));
    expect(skippedLines).toBe(0);
    expect(records[0]).toEqual(hand.session);
    expect(count(records)).toEqual({ session: 1, listed: 138, tokens: 1, "used:model": 4 });
    expect(skills).toHaveLength(hand.skills);
    expect(skills.reduce((sum, fact) => sum + fact.chars, 0)).toBe(hand.skillChars);
    expect(skills.every((fact) => !fact.bare)).toBe(true);
    expect(
      Object.fromEntries(
        listed
          .filter((fact) => fact.item.startsWith("instructions:"))
          .map((fact) => [fact.item, fact.chars]),
      ),
    ).toEqual(hand.instructions);
    expect(
      Object.fromEntries(
        listed
          .filter((fact) => fact.item.startsWith("mcp:"))
          .map((fact) => [fact.item, fact.chars]),
      ),
    ).toEqual(hand.mcp);
    expect(records.find((fact) => fact.type === "tokens")).toMatchObject({ tokens: hand.tokens });
    expect(records.flatMap((fact) => (fact.type === "used" ? [fact.item] : []))).toEqual(hand.used);
    expect(records.some((fact) => fact.type === "used" && fact.by === "user")).toBe(false);
  });

  it("keeps the fixture's text, paths and names out of the Facts and the final State", async () => {
    const { records, position } = await readFixture();
    expect(findCanary(records, ["dir-", "file-", "SKILL.md"])).toEqual([]);
    expect(findCanary(position.state, ["/", "~", "dir-", "file-"])).toEqual([]);
  });

  it("catches a format that keeps text in its State", async () => {
    const leaky: TranscriptFormat<CodexState & { last?: string }> = {
      ...codexTranscripts,
      parse(line, state) {
        state.last = line;
        return codexTranscripts.parse(line, state);
      },
    };
    const result = await readTranscript(FIXTURE, leaky);
    expect(findCanary(result!.position.state).length).toBeGreaterThan(0);
  });

  describe("read in two parts", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-codex-"));
    });
    afterEach(async () => {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    });

    it("gives the same Facts as one read when it resumes from the saved position", async () => {
      const content = await NodeFSP.readFile(FIXTURE);
      const whole = await readFixture();
      // Split after the first exec call, mid-session, between a listing and the later uses.
      const lines = content.toString("utf8").split("\n");
      const split = Buffer.byteLength(lines.slice(0, 24).join("\n") + "\n");
      const path = NodePath.join(dir, "rollout.jsonl");
      await NodeFSP.writeFile(path, content.subarray(0, split));
      const first = await readTranscript(path, codexTranscripts);
      await NodeFSP.appendFile(path, content.subarray(split));
      const saved = JSON.parse(JSON.stringify(first!.position)) as ReadPosition;
      const second = await readTranscript(path, codexTranscripts, saved);
      expect(second!.resumed).toBe(true);
      expect(first!.records.length).toBeGreaterThan(0);
      expect(second!.records.length).toBeGreaterThan(0);
      expect([...first!.records, ...second!.records]).toEqual(whole.records);
      expect(second!.position).toEqual(whole.position);
    });
  });
});

describe("codex machine", () => {
  const place = { home: "/home/u", env: {} };

  it("finds its home, sources and transcripts, moved by CODEX_HOME", () => {
    expect(machine.home(place)).toBe("/home/u/.codex");
    expect(machine.roots(place)).toEqual([
      "/home/u/.codex/sessions",
      "/home/u/.codex/archived_sessions",
    ]);
    const moved = { home: "/home/u", env: { CODEX_HOME: "/data/codex/" } };
    expect(machine.home(moved)).toBe("/data/codex");
    expect(machine.sources(moved)).toEqual([
      "/data/codex/skills",
      "/home/u/.agents/skills",
      "/data/codex/plugins/cache",
      "/data/codex/AGENTS.override.md",
      "/data/codex/AGENTS.md",
      "/data/codex/config.toml",
      "/home/u/.agents/.skill-lock.json",
    ]);
  });

  const config = [
    'model = "gpt-5"',
    'api_key = "sk-SECRET-KEY"',
    "",
    "[mcp_servers.docs]",
    'command = "npx"',
    'args = ["-y", "docs-mcp", "--token", "SECRET-ARG"]',
    "",
    "[mcp_servers.docs.env]",
    'DOCS_TOKEN = "SECRET-ENV"',
    "enabled = false",
    "",
    '[mcp_servers."off-server"]',
    'url = "https://SECRET-HOST.example/mcp"',
    "enabled = false",
    "",
    "[mcp_servers]",
    'inline = { command = "SECRET-CMD", env = { KEY = "SECRET-INLINE" } }',
    "",
    'description = """',
    "[mcp_servers.fake]",
    '"""',
    "",
    '[plugins."kit@market"]',
    "enabled = true",
    "",
    '[plugins."off@market"]',
    "enabled = false",
  ].join("\n");

  const files = memoryFiles({
    "~/.codex/config.toml": config,
    "~/.codex/AGENTS.md": "\n  Be brief.  \n",
    "~/.codex/skills/mine/SKILL.md": skillMd("mine", "Mine."),
    "~/.codex/skills/.system/imagegen/SKILL.md": skillMd("imagegen", "Makes images."),
    "~/.codex/skills/.system/hidden/SKILL.md": skillMd("hidden", "Hidden."),
    "~/.codex/skills/.system/hidden/agents/openai.yaml":
      "policy:\n  allow_implicit_invocation: false\n",
    "~/.codex/skills/.cache/x/SKILL.md": skillMd("x", "In a hidden folder."),
    "~/.agents/skills/shared/SKILL.md": skillMd("shared", "Shared\n   across agents."),
    "~/.agents/skills/nodesc/SKILL.md": "---\nname: nodesc\n---\nBody.\n",
    "~/.codex/plugins/cache/market/kit/1.2.0/.codex-plugin/plugin.json": '{"name":"kit"}',
    "~/.codex/plugins/cache/market/kit/1.2.0/skills/lint/SKILL.md": skillMd("lint", "Old."),
    "~/.codex/plugins/cache/market/kit/1.10.0/.codex-plugin/plugin.json": '{"name":"kit"}',
    "~/.codex/plugins/cache/market/kit/1.10.0/skills/lint/SKILL.md": skillMd("lint", "Lints."),
    "~/.codex/plugins/cache/market/off/1.0.0/skills/nope/SKILL.md": skillMd("nope", "Off."),
  });

  it("reads skills, plugin skills, AGENTS.md and MCP servers", async () => {
    const items = await machine.inventory(files);
    const summary = items.map((item) => [
      item.id,
      item.scope,
      item.managedBy,
      item.path,
      item.chars.listed,
      item.modelInvocable,
    ]);
    expect(summary).toEqual([
      [
        "skill:mine",
        "user",
        "hand",
        "~/.codex/skills/mine",
        codexListedChars("mine", "Mine.", "r0/mine/SKILL.md"),
        true,
      ],
      [
        "skill:shared",
        "user",
        "hand",
        "~/.agents/skills/shared",
        codexListedChars("shared", "Shared across agents.", "r1/shared/SKILL.md"),
        true,
      ],
      ["skill:hidden", "user", "hand", "~/.codex/skills/.system/hidden", 0, false],
      [
        "skill:imagegen",
        "user",
        "hand",
        "~/.codex/skills/.system/imagegen",
        codexListedChars("imagegen", "Makes images.", "r2/imagegen/SKILL.md"),
        true,
      ],
      [
        "skill:kit:lint",
        "plugin",
        "plugin",
        "~/.codex/plugins/cache/market/kit/1.10.0/skills/lint",
        codexListedChars("kit:lint", "Lints.", "r3/lint/SKILL.md"),
        true,
      ],
      [
        "instructions:~/.codex/AGENTS.md",
        "user",
        "hand",
        "~/.codex/AGENTS.md",
        "Be brief.".length,
        true,
      ],
      ["mcp:docs", "user", "hand", "~/.codex/config.toml", "- mcp__docs\n".length, true],
      ["mcp:inline", "user", "hand", "~/.codex/config.toml", "- mcp__inline\n".length, true],
    ]);
    expect(items.every((item) => item.description === undefined)).toBe(true);
  });

  it("says what installed a skill, from fleetrc's manifest and the skills CLI's lock", async () => {
    const items = await machine.inventory(
      memoryFiles({
        "~/.agents/.skill-lock.json": JSON.stringify({
          version: 3,
          skills: { locked: { source: "acme/skills", sourceType: "github" } },
        }),
        "~/.agents/skills/.fleetrc-manifest.json": JSON.stringify({
          version: 1,
          links: { linked: { target: "/home/u/.agents/skills/linked", source: "onmax-skills" } },
        }),
        "~/.agents/skills/linked/SKILL.md": skillMd("linked", "Linked."),
        "~/.agents/skills/locked/SKILL.md": skillMd("locked", "Locked."),
        "~/.codex/skills/mine/SKILL.md": skillMd("mine", "Mine."),
        "~/.codex/plugins/cache/market/kit/1.0.0/skills/lint/SKILL.md": skillMd("lint", "Lints."),
        "~/.codex/config.toml": '[plugins."kit@market"]\nenabled = true\n',
      }),
    );
    expect(items.map((item) => [item.id, item.managedBy, item.pack])).toEqual([
      ["skill:mine", "hand", undefined],
      ["skill:linked", "fleetrc", "onmax-skills"],
      ["skill:locked", "skills", "acme/skills"],
      ["skill:kit:lint", "plugin", "kit"],
    ]);
  });

  it("keeps config.toml's values out of every Item", async () => {
    const items = await machine.inventory(files);
    expect(findCanary(items, ["SECRET", "npx", "gpt-5", "fake"])).toEqual([]);
  });

  it("reads only table names and enabled from config.toml", () => {
    const { mcpServers, plugins } = readCodexConfig(config);
    expect([...mcpServers]).toEqual([
      ["docs", true],
      ["off-server", false],
      ["inline", true],
    ]);
    expect([...plugins]).toEqual([
      ["kit@market", true],
      ["off@market", false],
    ]);
  });

  it("reads a pack's skills with their descriptions, named after its Codex plugin", async () => {
    const items = await codex.inventory(
      memoryFiles(
        {
          ".codex-plugin/plugin.json": '{"name":"kit"}',
          "skills/lint/SKILL.md": skillMd("lint", "Lints."),
          "AGENTS.md": "Development notes.",
        },
        "owner/kit",
      ),
    );
    expect(items).toMatchObject([
      {
        id: "skill:kit:lint",
        scope: "plugin",
        managedBy: "plugin",
        pack: "owner/kit",
        path: "skills/lint",
        description: "Lints.",
      },
    ]);
  });
});

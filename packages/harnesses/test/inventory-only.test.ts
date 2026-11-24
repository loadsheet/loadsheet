import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { memoryFiles, type Harness, type Place } from "@loadsheet/kit";
import { scanMachine } from "@loadsheet/kit/node";
import type { Item } from "@loadsheet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  claudeCode,
  codex,
  cursor,
  findHarness,
  gemini,
  grok,
  harnesses,
  kiro,
  NO_USAGE,
  opencode,
  pi,
} from "../src/index.ts";

// Every file below is invented for these tests.

const skillMd = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n${body}`;

/** The plain listing form an adapter uses where the harness's own is not documented. */
const plain = (name: string, description?: string) =>
  (description ? `- ${name}: ${description}\n` : `- ${name}\n`).length;

/** The `<skill>` entry Pi and Gemini CLI list. */
const xml = (name: string, description: string, location: string) =>
  `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${location}</location>\n  </skill>\n`
    .length;

/** What a test checks of an Item: everything but its digest, which the fixture text sets. */
const summary = (items: readonly Item[]) =>
  items
    .map((item) => ({
      id: item.id,
      path: item.path,
      scope: item.scope,
      managedBy: item.managedBy,
      ...(item.pack === undefined ? {} : { pack: item.pack }),
      harnesses: item.harnesses,
      chars: item.chars,
      modelInvocable: item.modelInvocable,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const hand = (harness: string, id: string, path: string, listed: number, body = 0) => ({
  id,
  path,
  scope: "user",
  managedBy: "hand",
  harnesses: [harness],
  chars: { listed, body },
  modelInvocable: true,
});

const mcp = (harness: string, name: string, path: string) => hand(harness, `mcp:${name}`, path, 0);

/** A skill the skills CLI installed in `~/.agents/skills`, which several harnesses read. */
const SHARED_BODY = "Share the load.\n";
const SHARED_PATH = "~/.agents/skills/shared-skill/SKILL.md";
const SHARED = {
  [SHARED_PATH]: skillMd({ name: "shared-skill", description: "Shared by many." }, SHARED_BODY),
  "~/.agents/.skill-lock.json": JSON.stringify({
    version: 3,
    skills: { "shared-skill": { sourceType: "github", source: "acme/tools" } },
  }),
};
const shared = (harness: string, listed: number) => ({
  id: "skill:shared-skill",
  path: "~/.agents/skills/shared-skill",
  scope: "user",
  managedBy: "skills",
  pack: "acme/tools",
  harnesses: [harness],
  chars: { listed, body: SHARED_BODY.length },
  modelInvocable: true,
});

const inventoryOf = (harness: Harness, record: Record<string, string>, place?: Place) =>
  harness.machine!.inventory(memoryFiles(record), place);

describe("the inventory-only harnesses", () => {
  it("declares every usage signal none and reads no transcripts", () => {
    for (const harness of [grok, pi, opencode, cursor, gemini, kiro] as Harness[]) {
      expect(harness.signals).toEqual(NO_USAGE);
      expect(Object.values(harness.signals).every((grade) => grade === "none")).toBe(true);
      expect(harness.machine?.transcripts).toBeUndefined();
      expect(harness.machine && "roots" in harness.machine).toBe(false);
    }
  });

  it("are all found by id, with the two full ones", () => {
    const ids = ["claude-code", "codex", "grok", "pi", "opencode", "cursor", "gemini", "kiro"];
    expect(harnesses.map((harness) => harness.id)).toEqual(ids);
    for (const id of ids) expect(findHarness(id)?.id).toBe(id);
    expect(findHarness("claude-code")).toBe(claudeCode);
    expect(findHarness("codex")).toBe(codex);
    expect(findHarness("nope")).toBeUndefined();
  });
});

describe("Grok", () => {
  it("reads its own and Claude's folders, its config and the compat switches", async () => {
    const items = await inventoryOf(grok, {
      ...SHARED,
      "~/.grok/skills/tidy-notes/SKILL.md": skillMd(
        { name: "tidy-notes", description: "Tidies scratch notes." },
        "Sort the notes.\n",
      ),
      // A command is a skill named after its file, described by its first paragraph.
      "~/.grok/commands/brew.md": "Brew a pot\nof tea.\n\nThen pour.\n",
      "~/.grok/commands/steep.md": "Steep it.\n",
      // The first skill of a name wins: Grok's home before Claude's folder.
      "~/.claude/skills/tidy-notes/SKILL.md": skillMd(
        { name: "tidy-notes", description: "Another tidier." },
        "Ignored.\n",
      ),
      // Cursor's own defaults are filtered out.
      "~/.cursor/skills/shell/SKILL.md": skillMd({ name: "shell", description: "Runs." }, "x\n"),
      "~/.grok/AGENTS.md": "Be brief.\n",
      "~/.grok/rules/style.md": "Use short words.\n",
      "~/.claude/CLAUDE.md": "Say thanks.\n",
      "~/.cursor/AGENTS.md": "Off by compat.\n",
      "~/.grok/config.toml": [
        'disabled_mcp_servers = ["noisy"]',
        "[skills]",
        'disabled = ["steep"]',
        "[compat.cursor]",
        "agents = false",
        "mcps = false",
        "[mcp_servers.kettle]",
        'command = "kettle-mcp"',
        "",
      ].join("\n"),
      "~/.claude.json": JSON.stringify({
        mcpServers: { kettle: { command: "other" }, noisy: {}, teapot: { command: "tp" } },
      }),
      "~/.cursor/mcp.json": JSON.stringify({ mcpServers: { cup: {} } }),
    });
    expect(summary(items)).toEqual([
      hand("grok", "instructions:CLAUDE.md", "~/.claude/CLAUDE.md", 12),
      hand("grok", "instructions:~/.grok/AGENTS.md", "~/.grok/AGENTS.md", 10),
      hand("grok", "instructions:~/.grok/rules/style.md", "~/.grok/rules/style.md", 17),
      mcp("grok", "kettle", "~/.grok/config.toml"),
      mcp("grok", "teapot", "~/.claude.json"),
      hand(
        "grok",
        "skill:brew",
        "~/.grok/commands/brew.md",
        plain("brew", "Brew a pot of tea."),
        31,
      ),
      shared("grok", plain("shared-skill", "Shared by many.")),
      { ...hand("grok", "skill:steep", "~/.grok/commands/steep.md", 0, 10), modelInvocable: false },
      hand(
        "grok",
        "skill:tidy-notes",
        "~/.grok/skills/tidy-notes",
        plain("tidy-notes", "Tidies scratch notes."),
        16,
      ),
    ]);
  });

  it("reads a list in config.toml that spans lines", async () => {
    const items = await inventoryOf(grok, {
      "~/.grok/config.toml": [
        "disabled_mcp_servers = [",
        '  "noisy", # too chatty ]',
        "  'idle',",
        "]",
        "[mcp_servers.kettle]",
        'command = "kettle-mcp"',
        "[mcp_servers.noisy]",
        'command = "noisy-mcp"',
        "[mcp_servers.idle]",
        'command = "idle-mcp"',
        "",
      ].join("\n"),
    });
    expect(items.map((item) => item.id)).toEqual(["mcp:kettle"]);
  });
});

describe("Pi", () => {
  it("reads its agent folder and ~/.agents/skills, listing skills as XML", async () => {
    const items = await inventoryOf(pi, {
      ...SHARED,
      "~/.pi/agent/skills/draft/SKILL.md": skillMd(
        { name: "draft", description: "Drafts a reply." },
        "Write it.\n",
      ),
      "~/.pi/agent/skills/quick.md": skillMd(
        { name: "quick", description: "Quick & small." },
        "Go.\n",
      ),
      // Without a description a skill does not load; the first of a name wins.
      "~/.pi/agent/skills/vague/SKILL.md": skillMd({ name: "vague" }, "Hm.\n"),
      "~/.agents/skills/draft/SKILL.md": skillMd({ name: "draft", description: "Loses." }, "No.\n"),
      "~/.pi/agent/AGENTS.md": "Plan first.\n",
      "~/.pi/agent/CLAUDE.md": "Not read: AGENTS.md comes first.\n",
      "~/.pi/agent/APPEND_SYSTEM.md": "Add this.\n",
      "~/.pi/agent/mcp.json": JSON.stringify({
        mcpServers: { kettle: { command: "k" }, idle: { command: "i", enabled: false } },
      }),
    });
    expect(summary(items)).toEqual([
      hand("pi", "instructions:~/.pi/agent/AGENTS.md", "~/.pi/agent/AGENTS.md", 12),
      hand("pi", "instructions:~/.pi/agent/APPEND_SYSTEM.md", "~/.pi/agent/APPEND_SYSTEM.md", 10),
      mcp("pi", "kettle", "~/.pi/agent/mcp.json"),
      hand(
        "pi",
        "skill:draft",
        "~/.pi/agent/skills/draft",
        xml("draft", "Drafts a reply.", "~/.pi/agent/skills/draft/SKILL.md"),
        10,
      ),
      hand(
        "pi",
        "skill:quick",
        "~/.pi/agent/skills/quick.md",
        xml("quick", "Quick &amp; small.", "~/.pi/agent/skills/quick.md"),
        4,
      ),
      shared(
        "pi",
        xml("shared-skill", "Shared by many.", "~/.agents/skills/shared-skill/SKILL.md"),
      ),
    ]);
  });

  it("lists a skill at the absolute path Pi sees and follows PI_CODING_AGENT_DIR", async () => {
    const place = { home: "/home/tester", env: { PI_CODING_AGENT_DIR: "~/agent" } };
    expect(pi.machine!.home(place)).toBe("/home/tester/agent");
    const items = await inventoryOf(
      pi,
      {
        "~/agent/skills/draft/SKILL.md": skillMd({ name: "draft", description: "D." }, "x\n"),
        "~/.pi/agent/skills/old/SKILL.md": skillMd({ name: "old", description: "O." }, "x\n"),
      },
      place,
    );
    expect(summary(items).map(({ id, path, chars }) => ({ id, path, chars }))).toEqual([
      {
        id: "skill:draft",
        path: "~/agent/skills/draft",
        chars: { listed: xml("draft", "D.", "/home/tester/agent/skills/draft/SKILL.md"), body: 2 },
      },
    ]);
  });
});

describe("OpenCode", () => {
  it("reads its config folder, ~/.agents and ~/.claude, a later skill of a name winning", async () => {
    const items = await inventoryOf(opencode, {
      ...SHARED,
      "~/.agents/skills/plan/SKILL.md": skillMd(
        { name: "plan", description: "Older plan." },
        "Old.\n",
      ),
      "~/.config/opencode/skills/plan/SKILL.md": skillMd(
        { name: "plan", description: "Plans the day." },
        "Make a list.\n",
      ),
      "~/.claude/skills/hush/SKILL.md":
        "---\nname: hush\ndescription: Keeps quiet.\nmetadata:\n  opencode/autoinvoke: false\n---\nShh.\n",
      "~/.config/opencode/AGENTS.md": "Answer in English.\n",
      "~/.claude/CLAUDE.md": "Not read: AGENTS.md wins.\n",
      "~/.config/opencode/opencode.jsonc": `{
        // V2 servers and a V1 one side by side.
        "mcp": {
          "servers": { "kettle": { "command": ["k"] }, "idle": { "disabled": true } },
          "legacy": { "type": "local", "command": ["l"] },
          "gone": { "type": "remote", "url": "https://example.invalid", "enabled": false },
        },
      }`,
    });
    expect(summary(items)).toEqual([
      hand(
        "opencode",
        "instructions:~/.config/opencode/AGENTS.md",
        "~/.config/opencode/AGENTS.md",
        19,
      ),
      mcp("opencode", "kettle", "~/.config/opencode/opencode.jsonc"),
      mcp("opencode", "legacy", "~/.config/opencode/opencode.jsonc"),
      { ...hand("opencode", "skill:hush", "~/.claude/skills/hush", 0, 5), modelInvocable: false },
      hand(
        "opencode",
        "skill:plan",
        "~/.config/opencode/skills/plan",
        plain("plan", "Plans the day."),
        13,
      ),
      shared("opencode", plain("shared-skill", "Shared by many.")),
    ]);
  });

  it("falls back to ~/.claude/CLAUDE.md, and drops Claude's folders when told to", async () => {
    const record = {
      "~/.claude/CLAUDE.md": "Say thanks.\n",
      "~/.claude/skills/hush/SKILL.md": skillMd({ name: "hush", description: "Q." }, "x\n"),
    };
    expect(summary(await inventoryOf(opencode, record)).map((item) => item.id)).toEqual([
      "instructions:CLAUDE.md",
      "skill:hush",
    ]);
    const place = { home: "/home/tester", env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" } };
    expect(await inventoryOf(opencode, record, place)).toEqual([]);
  });
});

describe("Cursor", () => {
  it("reads every skill folder it shares and its mcp.json, and no instructions", async () => {
    const items = await inventoryOf(cursor, {
      ...SHARED,
      "~/.cursor/skills/review/SKILL.md": skillMd(
        { name: "review", description: "Reviews a diff." },
        "Read it twice.\n",
      ),
      "~/.claude/skills/hush/SKILL.md": skillMd(
        { name: "hush", description: "Q.", "disable-model-invocation": "true" },
        "Shh.\n",
      ),
      "~/.codex/skills/group/deep/SKILL.md": skillMd(
        { name: "deep", description: "Nested." },
        "Down.\n",
      ),
      "~/.cursor/rules/style.md": "Project rules live in projects.\n",
      "~/.cursor/mcp.json": JSON.stringify({ mcpServers: { cup: { url: "https://x.invalid" } } }),
    });
    expect(summary(items)).toEqual([
      mcp("cursor", "cup", "~/.cursor/mcp.json"),
      hand("cursor", "skill:deep", "~/.codex/skills/group/deep", plain("deep", "Nested."), 6),
      { ...hand("cursor", "skill:hush", "~/.claude/skills/hush", 0, 5), modelInvocable: false },
      hand(
        "cursor",
        "skill:review",
        "~/.cursor/skills/review",
        plain("review", "Reviews a diff."),
        15,
      ),
      shared("cursor", plain("shared-skill", "Shared by many.")),
    ]);
  });
});

describe("Gemini CLI", () => {
  const place = { home: "/home/tester", env: {} };
  const at = (key: string) => `/home/tester${key.slice(1)}`;

  it("reads its skills, context, settings and enabled extensions", async () => {
    const items = await inventoryOf(
      gemini,
      {
        ...SHARED,
        "~/.gemini/settings.json": `{
          // Settings are JSONC.
          "skills": { "disabled": ["Muted"] },
          "context": { "fileName": ["AGENTS.md", "ELSEWHERE.md"] },
          "mcpServers": { "kettle": { "command": "k", "env": { "TOKEN": "x" } }, "blocked": {} },
          "mcp": { "excluded": ["blocked"] },
        }`,
        "~/.gemini/skills/SKILL.md": skillMd(
          { name: '"root:skill"', description: "At the top." },
          "Top.\n",
        ),
        "~/.gemini/skills/muted/SKILL.md": skillMd({ name: "muted", description: "M." }, "m\n"),
        "~/.gemini/skills/nameless/SKILL.md": skillMd({ description: "No name." }, "n\n"),
        // `~/.agents/skills` wins over `~/.gemini/skills` for a name.
        "~/.gemini/skills/dup/SKILL.md": skillMd({ name: "dup", description: "Loses." }, "l\n"),
        "~/.agents/skills/dup/SKILL.md": skillMd({ name: "dup", description: "Wins." }, "w\n"),
        "~/.gemini/GEMINI.md": "Not named by context.fileName.\n",
        "~/.gemini/AGENTS.md": "Be kind.\n",
        "~/.gemini/extensions/brewer/gemini-extension.json": JSON.stringify({
          name: "brewer",
          contextFileName: "BREW.md",
          mcpServers: { kettle: { command: "ext" }, pot: { command: "pot" } },
        }),
        "~/.gemini/extensions/brewer/BREW.md": "Brew slowly.\n",
        "~/.gemini/extensions/brewer/skills/steep/SKILL.md": skillMd(
          { name: "steep", description: "Steeps tea." },
          "Wait.\n",
        ),
        "~/.gemini/extensions/off/gemini-extension.json": JSON.stringify({
          name: "off",
          mcpServers: { unused: {} },
        }),
        "~/.gemini/extensions/off/GEMINI.md": "Disabled here.\n",
        "~/.gemini/extensions/extension-enablement.json": JSON.stringify({
          off: { overrides: ["!/home/tester/*"] },
          brewer: { overrides: ["!/elsewhere/*"] },
        }),
      },
      place,
    );
    const steep = "~/.gemini/extensions/brewer/skills/steep";
    expect(summary(items)).toEqual([
      {
        ...hand("gemini", "instructions:brewer:BREW.md", "~/.gemini/extensions/brewer/BREW.md", 13),
        scope: "plugin",
        managedBy: "plugin",
        pack: "brewer",
      },
      hand("gemini", "instructions:~/.gemini/AGENTS.md", "~/.gemini/AGENTS.md", 9),
      mcp("gemini", "kettle", "~/.gemini/settings.json"),
      {
        ...mcp("gemini", "pot", "~/.gemini/extensions/brewer/gemini-extension.json"),
        scope: "plugin",
        managedBy: "plugin",
        pack: "brewer",
      },
      hand(
        "gemini",
        "skill:dup",
        "~/.agents/skills/dup",
        xml("dup", "Wins.", at("~/.agents/skills/dup/SKILL.md")),
        2,
      ),
      { ...hand("gemini", "skill:muted", "~/.gemini/skills/muted", 0, 2), modelInvocable: false },
      hand(
        "gemini",
        "skill:root:skill",
        "~/.gemini/skills",
        xml("root-skill", "At the top.", at("~/.gemini/skills/SKILL.md")),
        5,
      ),
      shared("gemini", xml("shared-skill", "Shared by many.", at(SHARED_PATH))),
      {
        ...hand(
          "gemini",
          "skill:steep",
          steep,
          xml("steep", "Steeps tea.", at(`${steep}/SKILL.md`)),
          6,
        ),
        scope: "plugin",
        managedBy: "plugin",
        pack: "brewer",
      },
    ]);
  });

  it("lists nothing when skills are off, and follows GEMINI_CLI_HOME", async () => {
    const moved = { home: "/home/tester", env: { GEMINI_CLI_HOME: "/srv/gem" } };
    expect(gemini.machine!.home(moved)).toBe("/srv/gem/.gemini");
    const items = await inventoryOf(
      gemini,
      {
        "/srv/gem/.gemini/settings.json": JSON.stringify({ skills: { enabled: false } }),
        "/srv/gem/.gemini/skills/a/SKILL.md": skillMd({ name: "a", description: "A." }, "x\n"),
        "/srv/gem/.gemini/GEMINI.md": "Default context.\n",
      },
      moved,
    );
    expect(summary(items).map(({ id, chars }) => ({ id, chars }))).toEqual([
      { id: "instructions:~/.gemini/GEMINI.md", chars: { listed: 17, body: 0 } },
      { id: "skill:a", chars: { listed: 0, body: 2 } },
    ]);
  });
});

describe("Kiro", () => {
  it("reads its skills, steering by inclusion mode and mcp.json", async () => {
    const auto = skillMd(
      { inclusion: "auto", name: "api-guide", description: "Calls the API." },
      "Use v2.\n",
    );
    const agents = skillMd({ inclusion: "manual" }, "Always.\n");
    const tone = "Stay calm.\n";
    const items = await inventoryOf(kiro, {
      ...SHARED,
      "~/.kiro/skills/lint/SKILL.md": skillMd({ name: "lint", description: "Lints." }, "Run.\n"),
      // A skill whose name is not its folder's, or that has no description, does not load.
      "~/.kiro/skills/wrong/SKILL.md": skillMd({ name: "other", description: "W." }, "x\n"),
      "~/.kiro/skills/vague/SKILL.md": skillMd({ name: "vague" }, "x\n"),
      "~/.kiro/steering/tone.md": tone,
      "~/.kiro/steering/api.md": auto,
      "~/.kiro/steering/tests.md": skillMd({ inclusion: "fileMatch" }, "Test it.\n"),
      "~/.kiro/steering/deploy.md": skillMd({ inclusion: "manual" }, "Ship it.\n"),
      "~/.kiro/steering/AGENTS.md": agents,
      "~/.kiro/settings/mcp.json": JSON.stringify({
        mcpServers: { kettle: { command: "k" }, idle: { command: "i", disabled: true } },
      }),
    });
    const steering = (file: string) => `~/.kiro/steering/${file}`;
    expect(summary(items)).toEqual([
      hand("kiro", `instructions:${steering("AGENTS.md")}`, steering("AGENTS.md"), agents.length),
      hand(
        "kiro",
        `instructions:${steering("api.md")}`,
        steering("api.md"),
        plain("api-guide", "Calls the API."),
        8,
      ),
      {
        ...hand("kiro", `instructions:${steering("deploy.md")}`, steering("deploy.md"), 0, 9),
        modelInvocable: false,
      },
      hand("kiro", `instructions:${steering("tests.md")}`, steering("tests.md"), 0, 9),
      hand("kiro", `instructions:${steering("tone.md")}`, steering("tone.md"), tone.length),
      mcp("kiro", "kettle", "~/.kiro/settings/mcp.json"),
      hand("kiro", "skill:lint", "~/.kiro/skills/lint", plain("lint", "Lints."), 5),
    ]);
  });
});

describe("an inventory-only scan of a machine", () => {
  let home: string;
  beforeEach(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "loadsheet-inventory-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(home, { recursive: true, force: true });
  });

  const write = async (path: string, text: string) => {
    const file = NodePath.join(home, path);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, text);
  };

  it("covers Pi with no sessions and every signal none, and counts a shared folder once", async () => {
    await write(".agents/skills/shared-skill/SKILL.md", SHARED[SHARED_PATH]);
    await write(".pi/agent/AGENTS.md", "Plan first.\n");
    await write(".cursor/mcp.json", JSON.stringify({ mcpServers: { cup: {} } }));
    const scan = await scanMachine({
      harnesses: [pi, cursor] as Harness[],
      days: 1,
      tool: "loadsheet@0.0.0-test",
      machine: "test-machine",
      now: new Date("2026-11-24T12:00:00.000Z"),
      place: { home, env: {} },
      cacheDir: false,
    });
    expect(scan.coverage).toEqual([
      expect.objectContaining({ harness: "cursor", installed: true, sessions: 0 }),
      {
        machine: "test-machine",
        harness: "pi",
        installed: true,
        sessions: 0,
        versions: [],
        signals: NO_USAGE,
      },
    ]);
    expect(scan.sessions).toEqual([]);
    expect(scan.cells).toEqual([]);
    expect(scan.items.map(({ id, path, harnesses }) => ({ id, path, harnesses }))).toEqual([
      {
        id: "instructions:~/.pi/agent/AGENTS.md",
        path: "~/.pi/agent/AGENTS.md",
        harnesses: ["pi"],
      },
      { id: "mcp:cup", path: "~/.cursor/mcp.json", harnesses: ["cursor"] },
      {
        id: "skill:shared-skill",
        path: "~/.agents/skills/shared-skill",
        harnesses: ["cursor", "pi"],
      },
    ]);
    expect(JSON.stringify(scan)).not.toContain(home);
  });
});

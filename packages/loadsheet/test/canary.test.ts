import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCanary, findCanaryInDir } from "@loadsheet/fixtures";
import { parseReport, parseScan } from "@loadsheet/schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The whole CLI on an invented home where every text that must stay on the machine carries its own
// canary: transcript prompts and replies, tool input and output, skill and instruction bodies,
// session ids, environment values and the home path itself. None may reach the text report, the
// JSON Report, the Scan a fleet host prints, the page `build` writes, or the cache. Runs the built
// CLI, so `pnpm build` comes first.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const stub = fileURLToPath(new URL("fixtures/web/", import.meta.url));

const C = {
  home: "CANARY-LS-home-path",
  sessionId: "CANARY-LS-session-id",
  codexSessionId: "CANARY-LS-codex-session-id",
  prompt: "CANARY-LS-prompt",
  reply: "CANARY-LS-reply",
  toolInput: "CANARY-LS-tool-input",
  toolOutput: "CANARY-LS-tool-output",
  skillBody: "CANARY-LS-skill-body",
  instructionBody: "CANARY-LS-instruction-body",
  codexInstructionBody: "CANARY-LS-codex-instruction-body",
  mcpEnv: "CANARY-LS-mcp-env",
  mcpArg: "CANARY-LS-mcp-arg",
  settingsEnv: "CANARY-LS-settings-env",
  processEnv: "CANARY-LS-process-env",
  hook: "CANARY-LS-hook-command",
  codexReply: "CANARY-LS-codex-reply",
  codexToolOutput: "CANARY-LS-codex-tool-output",
  mcpInstructions: "CANARY-LS-mcp-instructions",
  agentLine: "CANARY-LS-agent-line",
  agentBody: "CANARY-LS-agent-body",
} as const;
const canaries = Object.values(C);

/** The canaries in `text`, raw or JSON-escaped. */
const leaks = (text: string) =>
  canaries.filter((c) => text.includes(c) || text.includes(JSON.stringify(c).slice(1, -1)));

let root: string;
let home: string;
let cache: string;
let env: Record<string, string>;
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const jsonl = (lines: unknown[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: home, env });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loadsheet-canary-"));
  home = join(root, C.home);
  cache = join(root, "cache");
  env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: join(root, "config"),
    LOADSHEET_WEB_DIR: stub,
    LOADSHEET_SECRET: C.processEnv,
  };
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();

  // Claude Code: two skills, one used; the user's CLAUDE.md; an MCP server it calls; a hook.
  const skill = (dir: string, name: string) =>
    write(
      join(home, dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use when the ${name} task comes up.\n---\n\n${C.skillBody} for ${name}.\n`,
    );
  skill(".claude/skills", "brew-notes");
  skill(".claude/skills", "kettle-log");
  skill(".agents/skills", "tide-table");
  write(
    join(home, ".claude", "agents", "dock-hand.md"),
    `---\nname: dock-hand\ndescription: Use when a boat ties up.\n---\n\n${C.agentBody}\n`,
  );
  write(join(home, ".claude", "CLAUDE.md"), `# House rules\n\n${C.instructionBody}\n`);
  write(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: { HARBOR_TOKEN: C.settingsEnv },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `echo ${C.hook}` }] }],
      },
    }),
  );
  write(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        harbor: {
          command: "node",
          args: [join(home, "servers", `${C.mcpArg}.js`)],
          env: { HARBOR_TOKEN: C.mcpEnv },
        },
        quay: { command: "node", args: ["quay.js"] },
      },
    }),
  );
  const at = { entrypoint: "cli", version: "2.1.322", sessionId: C.sessionId, cwd: home };
  write(
    join(home, ".claude", "projects", home.replaceAll("/", "-"), `${C.sessionId}.jsonl`),
    jsonl([
      {
        ...at,
        type: "user",
        timestamp: day(2),
        message: { role: "user", content: [{ type: "text", text: `${C.prompt} brew it` }] },
      },
      {
        ...at,
        type: "attachment",
        timestamp: day(2),
        attachment: {
          type: "skill_listing",
          names: ["brew-notes", "kettle-log"],
          content:
            "- brew-notes: Use when the brew-notes task comes up.\n- kettle-log: Use when the kettle-log task comes up.",
        },
      },
      {
        ...at,
        type: "attachment",
        timestamp: day(2),
        attachment: {
          type: "instructions",
          files: [
            {
              path: join(home, ".claude", "CLAUDE.md"),
              type: "User",
              content: `# House rules\n\n${C.instructionBody}\n`,
            },
          ],
        },
      },
      {
        ...at,
        type: "attachment",
        timestamp: day(2),
        attachment: {
          type: "deferred_tools_delta",
          addedNames: ["mcp__harbor__lookup"],
          addedLines: [`mcp__harbor__lookup: ${C.toolInput} description`],
        },
      },
      {
        ...at,
        type: "attachment",
        timestamp: day(2),
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["quay"],
          addedBlocks: [`## quay\n${C.mcpInstructions}`],
        },
      },
      {
        ...at,
        type: "attachment",
        timestamp: day(2),
        attachment: {
          type: "agent_listing_delta",
          addedTypes: ["dock-hand"],
          addedLines: [`- dock-hand: ${C.agentLine}`],
        },
      },
      {
        ...at,
        type: "assistant",
        timestamp: day(2),
        message: {
          model: "claude-opus",
          usage: { input_tokens: 1200, cache_read_input_tokens: 800 },
          content: [
            { type: "text", text: C.reply },
            {
              type: "tool_use",
              id: "t1",
              name: "Skill",
              input: { skill: "brew-notes", args: C.toolInput },
            },
            {
              type: "tool_use",
              id: "t2",
              name: "mcp__harbor__lookup",
              input: { query: C.toolInput },
            },
          ],
        },
      },
      {
        ...at,
        type: "user",
        timestamp: day(2),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t2", content: C.toolOutput }],
        },
      },
    ]),
  );

  // Codex: its AGENTS.md, an MCP server in config.toml, a listed skill it opens.
  write(join(home, ".codex", "AGENTS.md"), `${C.codexInstructionBody}\n`);
  write(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.harbor]\ncommand = "node"\nargs = ["${C.mcpArg}"]\n\n[mcp_servers.harbor.env]\nHARBOR_TOKEN = "${C.mcpEnv}"\n`,
  );
  const skillPath = join(home, ".agents", "skills", "tide-table", "SKILL.md");
  const codexDay = day(1);
  write(
    join(home, ".codex", "sessions", "2026", "11", "20", `rollout-${C.codexSessionId}.jsonl`),
    jsonl([
      {
        timestamp: codexDay,
        type: "session_meta",
        payload: {
          id: C.codexSessionId,
          timestamp: codexDay,
          cwd: home,
          originator: "codex_cli_rs",
          cli_version: "0.167.0",
          base_instructions: { text: C.codexInstructionBody },
        },
      },
      {
        timestamp: codexDay,
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `<skills_instructions>\n## Skills\n- tide-table: Use when the tide-table task comes up. (file: ${skillPath})\n</skills_instructions>`,
            },
          ],
        },
      },
      {
        timestamp: codexDay,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${C.codexInstructionBody}\n</INSTRUCTIONS>`,
            },
            { type: "input_text", text: `${C.prompt} tides please` },
          ],
        },
      },
      {
        timestamp: codexDay,
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 900 } } },
      },
      {
        timestamp: codexDay,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ command: ["cat", skillPath], note: C.toolInput }),
        },
      },
      {
        timestamp: codexDay,
        type: "response_item",
        payload: { type: "function_call_output", output: C.codexToolOutput },
      },
      {
        timestamp: codexDay,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: C.codexReply }],
        },
      },
    ]),
  );
  // A long window, so the fixture's days count whenever the test runs.
  write(join(root, "config", "loadsheet", "config.json"), JSON.stringify({ window: 3650 }));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("no canary leaves the machine", () => {
  it("the fixture home holds every canary and reads as real sessions", () => {
    const files = readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    const text = files.map((file) => `${file}\n${readFileSync(file, "utf8")}`).join("\n");
    expect(canaries.filter((c) => !text.includes(c) && c !== C.processEnv)).toEqual([]);

    const result = run("--json", "--local");
    expect(result.stderr).toBe("");
    const report = parseReport(JSON.parse(result.stdout));
    expect(Object.fromEntries(report.sheet.map((s) => [s.harness, s.sessions]))).toEqual({
      "claude-code": 1,
      codex: 1,
    });
    const items = report.sheet.flatMap((s) => s.lines.map((line) => line.item));
    expect(items).toEqual(
      expect.arrayContaining([
        "skill:brew-notes",
        "skill:kettle-log",
        "skill:tide-table",
        "mcp:harbor",
        "mcp:quay",
        "subagent:dock-hand",
        "instructions:CLAUDE.md",
        "instructions:~/.codex/AGENTS.md",
      ]),
    );
  });

  it("the text report", () => {
    const result = run("--local");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("brew-notes");
    expect(leaks(result.stdout + result.stderr)).toEqual([]);
    expect(result.stdout).not.toContain(root);
  });

  it("--json", () => {
    const result = run("--json", "--local");
    expect(result.status).toBe(0);
    expect(leaks(result.stdout + result.stderr)).toEqual([]);
    expect(findCanary(parseReport(JSON.parse(result.stdout)), canaries)).toEqual([]);
    expect(result.stdout).not.toContain(root);
  });

  it("the Scan a fleet host prints for --scan", () => {
    const result = run("--scan", "--days", "3650");
    expect(result.status).toBe(0);
    expect(leaks(result.stdout + result.stderr)).toEqual([]);
    expect(findCanary(parseScan(JSON.parse(result.stdout)), canaries)).toEqual([]);
    expect(result.stdout).not.toContain(root);
  });

  it("the page loadsheet build writes", async () => {
    const out = join(root, "site");
    const result = run("build", "--local", "--out", out);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(leaks(readFileSync(join(out, "index.html"), "utf8"))).toEqual([]);
    expect(await findCanaryInDir(out, canaries)).toEqual([]);
  });

  it("the cache folder's files", async () => {
    expect(run("--json", "--local").status).toBe(0);
    const files = readdirSync(cache, { recursive: true, withFileTypes: true }).filter((entry) =>
      entry.isFile(),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(await findCanaryInDir(cache, [...canaries, root])).toEqual([]);
  });
});

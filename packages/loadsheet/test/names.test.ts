import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReport, parseScan } from "@loadsheet/schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The whole CLI on invented homes, checking that every name in a Scan or Report is one the
// machine's files or a harness's own listing gave, and that the home is written `~`. Runs the
// built CLI, so `pnpm build` comes first.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loadsheet-names-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** An invented home holding `files`, by path under it. */
const homeWith = (name: string, files: Record<string, string>) => {
  const home = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  return home;
};
const run = (home: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args, "--no-cache", "--days", "3650"], {
    encoding: "utf8",
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      ...env,
    },
  });
const jsonl = (lines: unknown[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
const now = new Date().toISOString();

describe("a home folder an environment variable names", () => {
  it.each([
    ["CODEX_HOME", ".codex", "AGENTS.md"],
    ["CLAUDE_CONFIG_DIR", ".claude", "CLAUDE.md"],
  ])("%s with a redundant `//` or `/./` keeps its Items under ~", (name, dir, file) => {
    const home = homeWith(`env-${name}`, { [`${dir}/${file}`]: "Invented rules.\n" });
    for (const value of [`/${home}/${dir}`, `${home}/./${dir}`, `${home}//${dir}/`]) {
      const result = run(home, { [name]: value }, "--scan");
      expect(result.stderr).toBe("");
      const scan = parseScan(JSON.parse(result.stdout));
      expect(scan.items.map((item) => item.path)).toContain(`~/${dir}/${file}`);
      expect(result.stdout).not.toContain(root);
    }
  });
});

describe("a relative CODEX_HOME", () => {
  it("is read under the working directory, and its Items keep their ~ paths", () => {
    const home = homeWith("env-relative", {
      "AGENTS.md": "Invented rules.\n",
      "skills/sample/SKILL.md": "---\nname: sample\ndescription: A sample skill.\n---\n",
    });
    for (const value of [".", "./"]) {
      const result = run(home, { CODEX_HOME: value }, "--scan", "--harness", "codex");
      expect(result.stderr).toBe("");
      const scan = parseScan(JSON.parse(result.stdout));
      expect(scan.items.map((item) => [item.id, item.path])).toEqual([
        ["instructions:~/.codex/AGENTS.md", "~/AGENTS.md"],
        ["skill:sample", "~/skills/sample"],
      ]);
      expect(result.stdout).not.toContain(root);
    }
  });
});

describe("a use of something neither installed nor listed", () => {
  const claudeLine = (line: Record<string, unknown>) => ({
    entrypoint: "cli",
    version: "2.1.322",
    sessionId: "invented-session",
    cwd: "/invented/project",
    timestamp: now,
    ...line,
  });
  const claudeHome = (name: string, lines: Record<string, unknown>[]) =>
    homeWith(name, { ".claude/projects/p/invented-session.jsonl": jsonl(lines.map(claudeLine)) });
  const codexHome = (name: string, lines: Record<string, unknown>[]) =>
    homeWith(name, {
      ".codex/sessions/2026/11/20/rollout-invented.jsonl": jsonl(
        lines.map((line) => ({ timestamp: now, ...line })),
      ),
    });

  /** Runs `--scan` and `--json`, and checks the session was read and no PRIVATE name came out. */
  const expectNoName = (home: string) => {
    const scan = run(home, {}, "--scan");
    expect(scan.stderr).toBe("");
    expect(parseScan(JSON.parse(scan.stdout)).coverage.some((row) => row.sessions > 0)).toBe(true);
    expect(scan.stdout).not.toContain("PRIVATE");
    const json = run(home, {}, "--json");
    expect(json.stderr).toBe("");
    parseReport(JSON.parse(json.stdout));
    expect(json.stdout).not.toContain("PRIVATE");
  };

  it("a slash command Claude Code runs", () => {
    expectNoName(
      claudeHome("slash", [
        {
          type: "user",
          message: {
            role: "user",
            content:
              "<command-message>example</command-message>\n<command-name>/PRIVATE-SLASH-PROMPT</command-name>",
          },
        },
        {
          type: "user",
          isMeta: true,
          message: { role: "user", content: [{ type: "text", text: "Example text." }] },
        },
      ]),
    );
  });

  it("a skill or agent Claude Code's model calls by name", () => {
    expectNoName(
      claudeHome("tool-use", [
        { type: "user", message: { role: "user", content: "Example prompt." } },
        {
          type: "assistant",
          message: {
            model: "claude-opus",
            usage: { input_tokens: 10 },
            content: [
              { type: "tool_use", id: "t1", name: "Skill", input: { skill: "PRIVATE-SKILL-ARG" } },
              {
                type: "tool_use",
                id: "t2",
                name: "Agent",
                input: { subagent_type: "PRIVATE-AGENT-ARG", prompt: "Example." },
              },
            ],
          },
        },
      ]),
    );
  });

  it("a `<skill>` message in a Codex session", () => {
    expectNoName(
      codexHome("codex-skill", [
        {
          type: "session_meta",
          payload: { timestamp: now, originator: "codex_cli_rs", cli_version: "0.171.0" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<skill>\n<name>PRIVATE CODEX PROMPT</name>\n<path>/invented/none/SKILL.md</path>\nExample text.\n</skill>",
              },
            ],
          },
        },
      ]),
    );
  });

  it("an entry after a Codex section's closing tag", () => {
    const developer = (text: string) => ({
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] },
    });
    expectNoName(
      codexHome("codex-section", [
        {
          type: "session_meta",
          payload: { timestamp: now, originator: "codex_cli_rs", cli_version: "0.171.0" },
        },
        developer(
          "<skills_instructions>\n## Skills\n</skills_instructions>\n- PRIVATE SKILL INSTRUCTIONS: example (file: /invented/example/SKILL.md)",
        ),
        developer("<tools>\n- mcp__harbor\n</tools>\n- mcp__PRIVATE-TOOL-INSTRUCTIONS"),
      ]),
    );
  });

  it("a string in config.toml that opens on the line where another closes", () => {
    const home = homeWith("codex-toml", {
      ".codex/config.toml": [
        "[mcp_servers.harbor]",
        'args = [ """first',
        'end""", """second',
        "[mcp_servers.PRIVATE-ARG-TEXT]",
        'end""" ]',
        "",
      ].join("\n"),
    });
    for (const args of [["--scan"], ["--json"]]) {
      const result = run(home, {}, ...args);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("mcp:harbor");
      expect(result.stdout).not.toContain("PRIVATE");
    }
  });
});

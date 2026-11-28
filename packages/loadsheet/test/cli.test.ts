import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_DOC } from "@loadsheet/core";
import { defaultCacheDir } from "@loadsheet/kit/node";
import { parseReport, parseScan } from "@loadsheet/schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };

// Runs the built CLI, so `pnpm build` comes first.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: fixtures });

describe("loadsheet CLI", () => {
  it.each(["--version", "-v"])("%s prints the package version", (flag) => {
    const result = run(flag);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${pkg.version}\n`);
  });

  it.each(["--help", "-h"])("%s prints the usage", (flag) => {
    const result = run(flag);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: loadsheet");
    expect(result.stdout).toContain("--version");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain(PROMPT_DOC);
  });

  it.each([
    [["--nope"]],
    [["missing-dir"]],
    [["pack", "--harness", "nope"]],
    [["https://gitlab.com/o/r"]],
  ])("%j prints the usage to stderr and exits 2", (args: string[]) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(args.at(-1));
    expect(result.stderr).toContain("Usage: loadsheet");
  });
});

describe("loadsheet <dir>", () => {
  it("--json prints a pack Report that parses, named after the directory", () => {
    const result = run("pack", "--json");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = parseReport(JSON.parse(result.stdout));
    expect(report).toMatchObject({ mode: "pack", source: "pack", machines: [], coverage: [] });
    expect(report.sheet[0]?.lines.map((line) => [line.item, line.chars.listed])).toEqual([
      ["skill:log-digest", 406],
      ["skill:commit-notes", 88],
      ["skill:release-checklist", 0],
    ]);
    expect(report.findings.map((finding) => finding.id)).toEqual([
      "expensive-description:skill:log-digest",
    ]);
    expect(result.stdout).not.toContain(fixtures);
  });

  it("prints a table by default", () => {
    const result = run(fixtures + "pack");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^loadsheet@[^:]+: pack pack\n/u);
    expect(result.stdout).toContain("claude-code: 3 lines, ~124 tokens listed");
    expect(result.stdout).toContain("~27  skill:log-digest  406 characters, over 300");
    expect(result.stdout).toContain("    shorten skills/log-digest/SKILL.md\n");
  });
});

// A home made up for the local run: the harnesses' fixture transcripts, two skills whose bodies
// hold the canary, and a config file. Nothing of the real home reaches the CLI.
const CANARY = "CANARY-LS";
const transcripts = fileURLToPath(new URL("../../harnesses/test/fixtures/", import.meta.url));

describe("loadsheet (this machine)", () => {
  let root: string;
  let home: string;
  let env: Record<string, string>;
  const local = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: home, env });
  const writeConfig = (text: string) => {
    mkdirSync(join(root, "config", "loadsheet"), { recursive: true });
    writeFileSync(join(root, "config", "loadsheet", "config.json"), text);
  };
  const writeSkill = (dir: string, name: string) => {
    mkdirSync(join(home, dir, name), { recursive: true });
    writeFileSync(
      join(home, dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use when the ${name} task comes up.\n---\n\n${CANARY} body.\n`,
    );
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "loadsheet-cli-"));
    home = join(root, "home");
    env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
    };
    mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
    cpSync(
      join(transcripts, "claude-code", "session.jsonl"),
      join(home, ".claude", "projects", "p", "session.jsonl"),
    );
    mkdirSync(join(home, ".codex", "sessions", "2026", "11", "09"), { recursive: true });
    cpSync(
      join(transcripts, "codex", "session.jsonl"),
      join(
        home,
        ".codex",
        "sessions",
        "2026",
        "11",
        "09",
        "rollout-2026-11-09T10-00-00-session.jsonl",
      ),
    );
    writeSkill(".claude/skills", "brew-notes");
    writeSkill(".agents/skills", "tide-table");
    // A window long enough to hold the fixtures' days whenever the test runs.
    writeConfig(JSON.stringify({ window: 3650 }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("--json prints a local Report that parses and holds no canary or home path", () => {
    const result = local("--json");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = parseReport(JSON.parse(result.stdout));
    expect(report.mode).toBe("local");
    expect(report.machines).toHaveLength(1);
    expect(
      Object.fromEntries(report.sheet.map((sheet) => [sheet.harness, sheet.sessions])),
    ).toEqual({
      "claude-code": 1,
      codex: 1,
    });
    expect(report.sheet[0]!.lines.map((line) => line.item)).toContain("skill:brew-notes");
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stdout).not.toContain(root);
  });

  it("prints a table by default, with no canary or home path", () => {
    const result = local();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Claude Code");
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stdout).not.toContain(root);
  });

  it("writes only the scan cache and returns the same Scan without it", () => {
    const scan = (cache: string, ...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, "--scan", ...args], {
        encoding: "utf8",
        cwd: home,
        env: { ...env, XDG_CACHE_HOME: cache },
      });
      expect(result.status).toBe(0);
      const { scannedAt: _, ...payload } = parseScan(JSON.parse(result.stdout));
      return payload;
    };
    const cache = join(root, "scan-cache");
    const dir = defaultCacheDir({ home, env: { XDG_CACHE_HOME: cache } });
    const expected = scan(cache);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "compile"))).toBe(false);
    expect(readdirSync(cache)).toEqual(["loadsheet"]);

    const none = join(root, "no-cache");
    expect(scan(none, "--no-cache")).toEqual(expected);
    expect(existsSync(none)).toBe(false);

    // A cache directory that cannot be made leaves the Scan as it is.
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "");
    expect(scan(blocked)).toEqual(expected);
  });

  it("a flag overrides the config file", () => {
    const sessions = (...args: string[]) => {
      const report = parseReport(JSON.parse(local("--json", ...args).stdout));
      return Object.fromEntries(report.sheet.map((sheet) => [sheet.harness, sheet.sessions]));
    };
    writeConfig(JSON.stringify({ window: 3650, harnesses: ["codex"] }));
    try {
      expect(sessions()).toEqual({ codex: 1 });
      expect(sessions("--harness", "claude-code")).toEqual({ "claude-code": 1 });
      expect(sessions("--harness", "codex", "--days", "1")).toEqual({ codex: 0 });
    } finally {
      writeConfig(JSON.stringify({ window: 3650 }));
    }
  });

  it("--harness still reads every harness, so a path a left-out harness uses gets no remove", () => {
    // Claude Code's config directory is ~/.agents, so it and Codex both load ~/.agents/skills.
    const shared = join(root, "shared");
    mkdirSync(join(shared, ".agents", "projects", "p"), { recursive: true });
    cpSync(
      join(transcripts, "claude-code", "session.jsonl"),
      join(shared, ".agents", "projects", "p", "session.jsonl"),
    );
    mkdirSync(join(shared, ".codex", "sessions", "2026", "11", "09"), { recursive: true });
    cpSync(
      join(transcripts, "codex", "session.jsonl"),
      join(shared, ".codex", "sessions", "2026", "11", "09", "rollout-2026-11-09T10-00-00-s.jsonl"),
    );
    // Claude Code's model invokes skill-34 in its fixture; Codex lists it and never does.
    mkdirSync(join(shared, ".agents", "skills", "skill-34"), { recursive: true });
    writeFileSync(
      join(shared, ".agents", "skills", "skill-34", "SKILL.md"),
      `---\nname: skill-34\ndescription: Use when it comes up.\n---\n\n${CANARY} body.\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--json",
        "--no-cache",
        "--harness",
        "codex",
        "--rule",
        "dead-skill.minSessions=1",
        "--rule",
        "dead-skill.minDays=1",
      ],
      {
        encoding: "utf8",
        cwd: shared,
        env: { ...env, HOME: shared, CLAUDE_CONFIG_DIR: join(shared, ".agents") },
      },
    );
    expect(result.stderr).toBe("");
    const report = parseReport(JSON.parse(result.stdout));
    expect(report.coverage.map((row) => row.harness)).toEqual(["codex"]);
    const finding = report.findings.find((f) => f.id === "dead-skill:skill:skill-34");
    expect(finding?.fixes.map((fix) => fix.action)).toEqual(["hide-from-model"]);
  });

  it.each([
    ["a plain folder gets rm -r", false, [["remove", "rm -r ~/.agents/skills/skill-1"]]],
    ["a folder a used skill is linked into gets no remove", true, [["hide-from-model", undefined]]],
  ])("a dead hand-installed skill in %s", (_, linked, fixes) => {
    const own = join(root, `reach-${String(linked)}`);
    mkdirSync(join(own, ".claude", "projects", "p"), { recursive: true });
    cpSync(
      join(transcripts, "claude-code", "session.jsonl"),
      join(own, ".claude", "projects", "p", "session.jsonl"),
    );
    mkdirSync(join(own, ".codex", "sessions", "2026", "11", "09"), { recursive: true });
    cpSync(
      join(transcripts, "codex", "session.jsonl"),
      join(own, ".codex", "sessions", "2026", "11", "09", "rollout-2026-11-09T10-00-00-s.jsonl"),
    );
    // Codex lists skill-1 and never uses it.
    const skill = (dir: string, name: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Use when it comes up.\n---\n\n${CANARY} body.\n`,
      );
    };
    skill(join(own, ".agents", "skills", "skill-1"), "skill-1");
    if (linked) {
      // Claude Code's model invokes skill-34, whose folder is a link into skill-1's.
      skill(join(own, ".agents", "skills", "skill-1", "vendored"), "skill-34");
      mkdirSync(join(own, ".claude", "skills"), { recursive: true });
      symlinkSync(
        "../../.agents/skills/skill-1/vendored",
        join(own, ".claude", "skills", "skill-34"),
      );
    }
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--json",
        "--no-cache",
        "--rule",
        "dead-skill.minSessions=1",
        "--rule",
        "dead-skill.minDays=1",
      ],
      { encoding: "utf8", cwd: own, env: { ...env, HOME: own } },
    );
    expect(result.stderr).toBe("");
    const report = parseReport(JSON.parse(result.stdout));
    const finding = report.findings.find((f) => f.id === "dead-skill:skill:skill-1");
    expect(finding?.fixes.map((fix) => [fix.action, fix.run])).toEqual(fixes);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stdout).not.toContain(root);
  });

  it("--rule turns a rule off and sets a threshold", () => {
    const report = parseReport(
      JSON.parse(
        local("--json", "--rule", "expensive-description=off", "--rule", "dead-skill.minDays=7")
          .stdout,
      ),
    );
    expect(report.config.rules["expensive-description"]).toMatchObject({ enabled: false });
    expect(report.config.rules["dead-skill"]).toMatchObject({ enabled: true, minDays: 7 });
  });

  it.each([
    ["not JSON", "{", /not JSON/u],
    ["invalid", JSON.stringify({ window: "long" }), /window/u],
  ])("a config file that is %s exits 2 with the reason", (_, text, reason) => {
    writeConfig(text);
    try {
      const result = local("--json");
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(reason);
    } finally {
      writeConfig(JSON.stringify({ window: 3650 }));
    }
  });

  it("a --via that is a path is an invalid flag, not a Report", () => {
    const result = local("--json", "--via", "/home/someone/private");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid flags");
    expect(result.stderr).toContain("$.via.include[0]");
  });

  it("a missing --config file exits 2", () => {
    const result = local("--config", join(root, "nope.json"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no such file");
  });

  it.each([[["--days", "0"]], [["--rule", "dead-skill.minDays=soon"]], [["--harness", "nope"]]])(
    "%j prints the reason and the usage and exits 2",
    (args: string[]) => {
      const result = local(...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Usage: loadsheet");
    },
  );
});

// An invented home whose Report holds a fix of each kind an agent applies: a command to run, a key
// in a SKILL.md's frontmatter and a key in settings.json. Copy it to a folder and run loadsheet
// with HOME set to that folder to let an agent apply a fix there.
describe("loadsheet on fixtures/home", () => {
  const home = join(fixtures, "home");
  let cache: string;
  const inHome = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CACHE_HOME: cache },
    });
  /** Every file under the home and a digest of its content. */
  const digests = () =>
    readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return `${path} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      })
      .sort();

  beforeAll(() => {
    cache = mkdtempSync(join(tmpdir(), "loadsheet-home-"));
  });
  afterAll(() => rmSync(cache, { recursive: true, force: true }));

  it("--json prints only the Report, with a run fix and two set fixes", () => {
    const before = digests();
    const result = inHome("--json");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = parseReport(JSON.parse(result.stdout));
    const fixes = Object.fromEntries(report.findings.map((finding) => [finding.id, finding.fixes]));
    // The machine is this machine's hostname, so the fixes are matched without it.
    expect(fixes["dead-skill:skill:old-notes"]).toMatchObject([
      {
        action: "remove",
        path: "~/.claude/skills/old-notes",
        run: "rm -r ~/.claude/skills/old-notes",
      },
    ]);
    expect(fixes["manual-only:skill:release-steps"]).toMatchObject([
      {
        action: "hide-from-model",
        path: "~/.claude/skills/release-steps/SKILL.md",
        set: { key: "disable-model-invocation", value: true },
      },
    ]);
    // The listing budget's key changes with Claude Code; the file and the action do not.
    expect(fixes["invisible-skill:skill:tide-guide"]).toMatchObject([
      { action: "set", path: "~/.claude/settings.json" },
    ]);
    expect(digests()).toEqual(before);
  });

  it("prints what a chat starts with and what it can get back", () => {
    const result = inHome();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^loadsheet \d+\.\d+\.\d+\n\nLearn what you send to Claude Code with the first message of every chat\.\n\nClaude Code {2}[\d.]+k tokens · \d+% context window\n/u,
    );
    expect(result.stdout).toContain("Breakdown");
    expect(result.stdout).toContain("remove 1 skill never used in 3650 days");
    expect(result.stdout).toContain(
      "More detail    npx loadsheet claude\nAs a web page  npx loadsheet --ui\n",
    );
    expect(result.stdout).not.toContain("\u001b[");
  });

  it("loadsheet claude breaks Claude Code down, and colours it when asked", () => {
    const result = inHome("claude");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skills · 3 listed");
    expect(result.stdout).toContain("~/.claude/skills/<name>  $ rm -r ~/.claude/skills/<name>");
    expect(result.stdout).toMatch(/old-notes +\d+ +never +hide\n/u);
    const coloured = spawnSync(process.execPath, [cli, "claude"], {
      encoding: "utf8",
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CACHE_HOME: cache, FORCE_COLOR: "1" },
    });
    expect(coloured.stdout).toContain("\u001b[");
  });

  it("--all is for one harness", () => {
    const result = inHome("--all");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--all lists every skill of one harness");
  });

  it("--full prints every fix as text and ends by naming the prompt", () => {
    const result = inHome("--full");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "remove ~/.claude/skills/old-notes  $ rm -r ~/.claude/skills/old-notes",
    );
    expect(result.stdout).toContain(
      "hide-from-model ~/.claude/skills/release-steps/SKILL.md  disable-model-invocation = true",
    );
    expect(result.stdout).toContain("set ~/.claude/settings.json  ");
    expect(result.stdout.trimEnd().endsWith(PROMPT_DOC)).toBe(true);
  });
});

// A home made up for `loadsheet usage`: Claude Code sessions in two repositories, one of them in a
// subfolder, and a folder that is no repository; a subagent; a Codex session whose transcript
// names its remote. Counted by hand below. The repositories exist only as `.git/config` files.
describe("loadsheet usage", () => {
  let root: string;
  let home: string;
  let env: Record<string, string>;
  const inUsage = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: home, env });
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  const jsonl = (lines: unknown[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  /** One Claude Code conversation in `folder`: a prompt, each request's usage, then a compaction. */
  const claude = (
    file: string,
    folder: string,
    day: string,
    requests: { id: string; input: number; output: number; read?: number; write5m?: number }[],
    { side = false, compact }: { side?: boolean; compact?: "auto" | "manual" } = {},
  ) => {
    const at = {
      isSidechain: side,
      entrypoint: "cli",
      version: "2.1.300",
      sessionId: "s",
      cwd: join(home, folder),
    };
    const lines: unknown[] = [
      { ...at, timestamp: `${day}T09:00:00.000Z`, type: "user", message: { content: "hi" } },
    ];
    requests.forEach((request, index) => {
      const usage = {
        input_tokens: request.input,
        output_tokens: request.output,
        cache_read_input_tokens: request.read ?? 0,
        cache_creation_input_tokens: request.write5m ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: request.write5m ?? 0 },
      };
      const line = {
        ...at,
        timestamp: `${day}T09:0${index + 1}:00.000Z`,
        type: "assistant",
        message: { id: request.id, model: "claude-fixture", content: [], usage },
      };
      // Claude Code writes a message once per content block, with the same usage.
      lines.push(line, line);
    });
    if (compact)
      lines.push({
        ...at,
        timestamp: `${day}T09:30:00.000Z`,
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: compact },
      });
    write(join(home, ".claude", "projects", "-usage", file), jsonl(lines));
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "loadsheet-usage-"));
    home = join(root, "home");
    env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
    };
    const remote = (folder: string, url: string) =>
      write(join(home, folder, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    remote("work/harbour", "git@github.com:Harbour-Co/harbour.git");
    remote("work/quay", "https://github.com/harbour-co/quay.git");
    mkdirSync(join(home, "work", "harbour", "src", "deep"), { recursive: true });
    mkdirSync(join(home, "notes"), { recursive: true });

    // harbour-co/harbour: 1,060 + 1,245 tokens, compacted on its own; 200 from a subfolder; a
    // subagent's 10. harbour-co/quay: 1,000, compacted by hand. ~/notes: 100.
    claude(
      "a.jsonl",
      "work/harbour",
      "2026-11-20",
      [
        { id: "m1", input: 10, output: 50, write5m: 1000 },
        { id: "m2", input: 5, output: 40, read: 1000, write5m: 200 },
      ],
      { compact: "auto" },
    );
    claude(
      "a/subagents/agent-1.jsonl",
      "work/harbour",
      "2026-11-20",
      [{ id: "m4", input: 1, output: 9 }],
      { side: true },
    );
    claude("b.jsonl", "work/harbour/src/deep", "2026-11-21", [
      { id: "m3", input: 100, output: 100 },
    ]);
    claude("c.jsonl", "work/quay", "2026-11-22", [{ id: "m5", input: 300, output: 700 }], {
      compact: "manual",
    });
    claude("d.jsonl", "notes", "2026-11-22", [{ id: "m6", input: 50, output: 50 }]);
    write(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ promptCacheTtl: "1h", cleanupPeriodDays: 90 }),
    );

    // tideworks/tides on Codex: 1,500 uncached input, 500 cached, 300 output; compacted.
    const stamp = "2026-11-23T10:00:00.000Z";
    write(
      join(home, ".codex", "sessions", "2026", "11", "23", "rollout-2026-11-23T10-00-00-e.jsonl"),
      jsonl([
        {
          timestamp: stamp,
          type: "session_meta",
          payload: {
            id: "e",
            timestamp: stamp,
            cwd: join(home, "elsewhere"),
            originator: "codex_cli_rs",
            cli_version: "0.171.0",
            source: "cli",
            git: { repository_url: "https://github.com/Tideworks/Tides.git" },
          },
        },
        { timestamp: stamp, type: "turn_context", payload: { cwd: home, model: "gpt-fixture" } },
        {
          timestamp: "2026-11-23T10:00:05.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 2000,
                cached_input_tokens: 500,
                output_tokens: 300,
                reasoning_output_tokens: 50,
                total_tokens: 2300,
              },
            },
          },
        },
        { timestamp: "2026-11-23T10:10:00.000Z", type: "compacted", payload: { message: "x" } },
      ]),
    );
    write(join(home, ".codex", "config.toml"), "model_auto_compact_token_limit = 180000\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A table's rows as [name, sessions, compacted, compacted %, tokens, share %], as printed. */
  const table = (text: string, title: string) => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${title} `));
    expect(start).toBeGreaterThan(-1);
    const rows: string[][] = [];
    for (const line of lines.slice(start + 1)) {
      const match = /^ {2}(\S.*?) {2,}([\d,]+) +([\d,]+) +(\d+)% +(\S+) +(\d+)%$/u.exec(line);
      if (!match) break;
      rows.push(match.slice(1));
    }
    return rows;
  };

  it("counts sessions, compactions and tokens per project and org, as --json's cells sum", () => {
    const report = parseReport(JSON.parse(inUsage("usage", "--json", "--days", "3650").stdout));
    const usage = report.usage!;
    const tokensOf = (keep: (project: string) => boolean) =>
      usage.tokens
        .filter((cell) => keep(cell.project))
        .reduce((n, c) => n + c.input + c.output + c.cacheRead + c.cacheWrite, 0);
    const main = usage.sessions.filter((cell) => cell.thread === "main");
    const count = (key: "sessions" | "compacted") => main.reduce((n, cell) => n + cell[key], 0);
    // By hand: the cells hold what the transcripts say.
    expect(tokensOf((p) => p === "harbour-co/harbour")).toBe(1060 + 1245 + 200 + 10);
    expect(tokensOf((p) => p === "harbour-co/quay")).toBe(1000);
    expect(tokensOf((p) => p === "tideworks/tides")).toBe(2300);
    expect(tokensOf((p) => p === "~/notes")).toBe(100);
    expect([count("sessions"), count("compacted")]).toEqual([5, 3]);
    expect(
      usage.sessions.filter((c) => c.thread === "subagent").reduce((n, c) => n + c.sessions, 0),
    ).toBe(1);
    expect(tokensOf(() => true)).toBe(5915);

    const result = inUsage("usage", "--days", "3650");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const text = result.stdout;
    expect(text).toContain(
      "Sessions, compactions and tokens, 2026-11-20 to 2026-11-23, on this machine.",
    );
    expect(text).toContain("plus 1 subagent session");
    // The printed totals are the cells' sums; shares by largest remainder sum to 100.
    expect(table(text, "Totals")).toEqual([
      ["Claude Code", "4", "2", "50", "3.6k", "61"],
      ["Codex", "1", "1", "100", "2.3k", "39"],
      ["all", String(count("sessions")), String(count("compacted")), "60", "5.9k", "100"],
    ]);
    const orgs = table(text, "Orgs");
    expect(orgs).toEqual([
      ["harbour-co", "3", "2", "67", "3.5k", "59"],
      ["tideworks", "1", "1", "100", "2.3k", "39"],
      ["no repository", "1", "0", "0", "0.1k", "2"],
    ]);
    expect(orgs.reduce((n, row) => n + Number(row[5]), 0)).toBe(100);
    const projects = table(text, "Projects");
    expect(projects.map((row) => row[0])).toEqual([
      "harbour-co/harbour",
      "tideworks/tides",
      "harbour-co/quay",
      "no repository",
    ]);
    expect(projects.reduce((n, row) => n + Number(row[1]), 0)).toBe(count("sessions"));
    expect(projects.reduce((n, row) => n + Number(row[5]), 0)).toBe(100);
    expect(text).toMatch(/Claude Code {2}prompt cache {6}1 hour, from settings\.promptCacheTtl\n/u);
    expect(text).toContain("transcripts kept  90 days");
    expect(text).toMatch(/Codex {8}auto-compact {6}at 180\.0k tokens\n/u);
    expect(text).not.toContain(root);
    for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("--json prints the Report --json prints, and --scan carries the usage", () => {
    const strip = (stdout: string) => {
      const { generatedAt: _, machines: __, ...rest } = JSON.parse(stdout);
      return rest;
    };
    const usage = strip(inUsage("usage", "--json", "--days", "3650").stdout);
    // Only the usage view's --days bounds usage; the report keeps every day.
    expect(usage.config.usageWindow).toBe(3650);
    delete usage.config.usageWindow;
    expect(usage).toEqual(strip(inUsage("--json", "--days", "3650").stdout));
    expect(strip(inUsage("usage", "--json").stdout).config.usageWindow).toBeUndefined();
    const scan = parseScan(JSON.parse(inUsage("--scan", "--days", "3650").stdout));
    expect(scan.usage?.tokens.length).toBeGreaterThan(0);
  });

  it("is not read as a pack, unless it comes after --", () => {
    mkdirSync(join(home, "usage"), { recursive: true });
    try {
      expect(inUsage("usage", "--days", "3650").stdout).toContain("Orgs");
      const asPack = inUsage("--json", "--", "usage");
      expect(asPack.status).toBe(0);
      expect(parseReport(JSON.parse(asPack.stdout)).mode).toBe("pack");
    } finally {
      rmSync(join(home, "usage"), { recursive: true });
    }
    const extra = inUsage("usage", "claude");
    expect(extra.status).toBe(2);
    expect(extra.stderr).toContain("loadsheet usage takes no pack");
  });

  it("says so when no session counted any usage", () => {
    const result = inUsage("usage", "--days", "1");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to count yet");
  });
});

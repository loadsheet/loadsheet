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

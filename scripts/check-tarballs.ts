// Packs every publishable package as npm will receive it, checks what each tarball holds, installs
// them together with npm into an empty project and runs the CLI from there. Build first: the
// packages are packed as built, without their prepack scripts.
//
//   node scripts/check-tarballs.ts [--keep]
import { execFileSync, spawnSync, type SpawnSyncOptions } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const keep = process.argv.includes("--keep");
const tmp = mkdtempSync(join(tmpdir(), "loadsheet-tarballs-"));
const problems: string[] = [];
const problem = (text: string) => problems.push(text);

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  bin?: string | Record<string, string>;
  exports?: unknown;
}

/** Every path an `exports` or `bin` field names, without its `./`. */
const named = (manifest: Manifest): string[] => {
  const paths: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") paths.push(value.replace(/^\.\//u, ""));
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(manifest.exports);
  walk(manifest.bin);
  return paths.filter((path) => !path.includes("*"));
};

const ALWAYS = /^(?:package\.json|README(?:\.md)?|LICENSE(?:\.md)?)$/iu;
const TEST = /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;
const ENV = /(?:^|\/)\.env(?:\.|$)/u;

const run = (command: string, args: string[], options: SpawnSyncOptions = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

try {
  // 1. Pack.
  const packages = readdirSync(join(root, "packages"))
    .map((dir) => join(root, "packages", dir))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({
      dir,
      manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest,
    }))
    .filter(({ manifest }) => !manifest.private);
  const tarballs = new Map<string, string>();
  for (const { dir, manifest } of packages) {
    if (!existsSync(join(dir, "dist")))
      throw new Error(`${manifest.name} has no dist: run pnpm build first`);
    const file = join(tmp, `${manifest.name.replace("@", "").replace("/", "-")}.tgz`);
    execFileSync("pnpm", ["pack", "--out", file], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, pnpm_config_ignore_scripts: "true" },
    });
    tarballs.set(manifest.name, file);
  }

  // 2. What each tarball holds.
  for (const [name, file] of tarballs) {
    const files = execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line && !line.endsWith("/"))
      .map((line) => line.replace(/^package\//u, ""));
    const text = execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" });
    const manifest = JSON.parse(text) as Manifest;
    for (const protocol of ["workspace:", "catalog:"]) {
      if (text.includes(protocol)) problem(`${name}: package.json still holds ${protocol}`);
    }
    const exported = named(manifest);
    for (const path of exported) {
      if (!files.includes(path))
        problem(`${name}: exports or bin name ${path}, which is not in the tarball`);
    }
    for (const required of [/^README(?:\.md)?$/iu, /^LICENSE(?:\.md)?$/iu]) {
      if (!files.some((path) => required.test(path)))
        problem(`${name}: no ${required.source.slice(1, 7)}`);
    }
    for (const path of files) {
      if (!ALWAYS.test(path) && !path.startsWith("dist/") && !exported.includes(path))
        problem(`${name}: ${path} is neither dist, package.json, README, LICENSE nor exported`);
      if (TEST.test(path)) problem(`${name}: ${path} is test code or a fixture`);
      if (ENV.test(path)) problem(`${name}: ${path} is an env file`);
      if (path.endsWith(".map")) {
        const map = execFileSync("tar", ["-xOzf", file, `package/${path}`], { encoding: "utf8" });
        const sources = (JSON.parse(map) as { sources?: string[] }).sources ?? [];
        if (sources.some((source) => TEST.test(source))) problem(`${name}: ${path} maps test code`);
      }
    }
  }
  if (problems.length) throw new Error("the tarballs hold what they should not");
  const version = JSON.parse(
    execFileSync("tar", ["-xOzf", tarballs.get("loadsheet")!, "package/package.json"], {
      encoding: "utf8",
    }),
  ).version as string;
  console.log(
    `${tarballs.size} tarballs: no workspace: or catalog:, only dist, package.json, README, LICENSE and exports, every bin and export present`,
  );

  // 3. Install them together. Overrides point every @loadsheet/* at its tarball, so npm looks none up.
  const project = join(tmp, "project");
  mkdirSync(project);
  const spec = (name: string) => `file:${tarballs.get(name)}`;
  const scoped = [...tarballs.keys()].filter((name) => name.startsWith("@loadsheet/"));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "tarball-check",
      private: true,
      dependencies: { loadsheet: spec("loadsheet") },
      overrides: Object.fromEntries(scoped.map((name) => [name, spec(name)])),
    }),
  );
  const npmEnv = {
    ...process.env,
    npm_config_cache: join(tmp, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  const install = run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: project,
    env: npmEnv,
  });
  if (install.status !== 0) throw new Error(`npm install failed:\n${install.stderr}`);
  const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8")) as {
    packages: Record<string, { resolved?: string }>;
  };
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (
      /node_modules\/(?:@loadsheet\/[^/]+|loadsheet)$/u.test(path) &&
      !entry.resolved?.startsWith("file:")
    )
      problem(`npm took ${path} from ${entry.resolved}, not its tarball`);
  }

  // 4. Run the installed CLI on an invented home, so nothing reads the real one.
  const home = join(tmp, "home");
  const transcripts = join(root, "packages", "harnesses", "test", "fixtures");
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  cpSync(
    join(transcripts, "claude-code", "session.jsonl"),
    join(home, ".claude", "projects", "p", "s.jsonl"),
  );
  const codexDay = join(home, ".codex", "sessions", "2026", "11", "09");
  mkdirSync(codexDay, { recursive: true });
  cpSync(
    join(transcripts, "codex", "session.jsonl"),
    join(codexDay, "rollout-2026-11-09T10-00-00-s.jsonl"),
  );
  mkdirSync(join(home, ".claude", "skills", "brew-notes"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "skills", "brew-notes", "SKILL.md"),
    "---\nname: brew-notes\ndescription: Use when brewing comes up.\n---\n\nNotes.\n",
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CACHE_HOME: join(tmp, "cache"),
    XDG_CONFIG_HOME: join(tmp, "config"),
    npm_config_cache: join(tmp, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  const npx = (...args: string[]) =>
    run("npx", ["--no-install", "loadsheet", ...args], { cwd: project, env });

  const printed = npx("--version");
  if (printed.status !== 0 || printed.stdout !== `${version}\n`)
    problem(
      `npx loadsheet --version printed ${JSON.stringify(printed.stdout)}, exit ${printed.status}`,
    );

  const json = npx("--json", "--days", "3650");
  const { parseReport } = (await import(
    pathToFileURL(join(project, "node_modules", "@loadsheet", "schema", "dist", "index.mjs")).href
  )) as {
    parseReport: (value: unknown) => { sheet: { harness: string; sessions: number }[] };
  };
  let harnesses = "";
  try {
    const report = parseReport(JSON.parse(json.stdout));
    harnesses = report.sheet.map((sheet) => `${sheet.harness} ${sheet.sessions}`).join(", ");
    if (!report.sheet.every((sheet) => sheet.sessions === 1))
      problem(`npx loadsheet --json read ${harnesses} sessions`);
  } catch (error) {
    problem(
      `npx loadsheet --json printed no Report (exit ${json.status}): ${(error as Error).message}\n${json.stderr}`,
    );
  }

  const fleet = npx("fleet", "--help");
  if (fleet.status !== 0 || !fleet.stdout.includes("Usage: loadsheet fleet"))
    problem(`npx loadsheet fleet --help exited ${fleet.status}: ${fleet.stderr}`);

  if (problems.length) throw new Error("the installed packages do not run");
  console.log(
    `npm installed them together: --version ${version}, --json a Report (sessions: ${harnesses}), fleet --help ok`,
  );
} catch (error) {
  for (const text of problems) console.error(`- ${text}`);
  console.error(`Tarball check failed: ${(error as Error).message}${keep ? ` (kept ${tmp})` : ""}`);
  process.exitCode = 1;
} finally {
  if (!keep) rmSync(tmp, { recursive: true, force: true });
}

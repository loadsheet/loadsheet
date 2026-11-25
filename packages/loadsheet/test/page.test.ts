import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReport } from "@loadsheet/schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The web UI that ships, opened in a headless browser on the page the built CLI wrote, so `pnpm build`
// comes first. LOADSHEET_BROWSER names the browser, as CI does; without it the first Chrome or Chromium
// on PATH is used, and a machine with none skips these tests.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && spawnSync(join(dir, name), ["--version"]).status === 0);
const browser =
  process.env.LOADSHEET_BROWSER ??
  ["google-chrome", "chromium", "chromium-browser", "chrome-headless-shell"].find(onPath);

let root: string;
let env: Record<string, string>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loadsheet-page-"));
  env = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  const skill = join(root, "home", ".claude", "skills", "brew-notes");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: brew-notes\ndescription: Use when brewing comes up.\n---\n\nNotes.\n",
  );
  cpSync(join(fixtures, "pack"), join(root, "pack"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What the page shows once its script has run: the text of `#app`, without scripts and styles. */
const shown = (file: string, route = "") => {
  const dom = spawnSync(
    browser!,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--virtual-time-budget=5000",
      "--dump-dom",
      pathToFileURL(file).href + route,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  expect(dom.status).toBe(0);
  const app = dom.stdout.slice(dom.stdout.indexOf('<div id="app"'));
  return app.replace(/<(script|style)[\s\S]*?<\/\1>/gu, "").replace(/<[^>]+>/gu, " ");
};

/** Builds the page and gives the skill names of the Report in it. */
const build = (args: string[], out: string) => {
  const result = spawnSync(process.execPath, [cli, "build", ...args, "--out", out], {
    encoding: "utf8",
    cwd: root,
    env,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const page = readFileSync(join(out, "index.html"), "utf8");
  const inline = /<script type="application\/json" id="report">([\s\S]*?)<\/script/u.exec(page);
  const names = parseReport(JSON.parse(inline![1]!))
    .sheet.flatMap((sheet) => sheet.lines)
    .flatMap((line) => (line.item.startsWith("skill:") ? [line.item.slice(6)] : []));
  expect(names.length).toBeGreaterThan(0);
  return names;
};

// A browser's first start on a CI runner takes longer than the default five seconds.
describe.skipIf(!browser)("the web UI on a page loadsheet build wrote", { timeout: 60_000 }, () => {
  it("shows a pack's Report, not its own example", () => {
    const out = join(root, "pack-site");
    const names = build(["pack"], out);
    const text = shown(join(out, "index.html"));
    for (const name of names) expect(text).toContain(name);
  });

  it("opens on a home's Report", () => {
    const out = join(root, "home-site");
    const names = build([], out);
    expect(names).toContain("brew-notes");
    const text = shown(join(out, "index.html"), "#/report/skills");
    for (const name of names) expect(text).toContain(name);
    // The bare page goes to the Report as well, not to the landing page.
    expect(shown(join(out, "index.html"))).not.toContain("npx loadsheet");
  });
});

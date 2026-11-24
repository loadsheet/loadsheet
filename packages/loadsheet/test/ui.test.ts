import { spawn, spawnSync } from "node:child_process";
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
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReport, type Report } from "@loadsheet/schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { injectReport, MARKER } from "../src/ui.ts";

// Runs the built CLI, so `pnpm build` comes first. The web UI is a stub with one module script and
// one asset, named by LOADSHEET_WEB_DIR.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const stub = join(fixtures, "web");

/** The Report in a page's `<script id="report">`, read up to the first `</script` as a browser does. */
const reportIn = (html: string): { text: string; report: Report } => {
  const match = /<script type="application\/json" id="report">([\s\S]*?)<\/script/iu.exec(html);
  if (!match) throw new Error("no report element");
  return { text: match[1]!, report: parseReport(JSON.parse(match[1]!)) };
};

let root: string;
let env: Record<string, string>;
const run = (args: string[], options: { cwd?: string; web?: string } = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? root,
    env: { ...env, LOADSHEET_WEB_DIR: options.web ?? stub },
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loadsheet-ui-"));
  env = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  mkdirSync(join(root, "home"));
  cpSync(join(fixtures, "pack"), join(root, "pack"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("loadsheet build", () => {
  it("writes the stub with the Report the default command prints, before the first script", () => {
    const out = join(root, "site");
    const result = run(["build", "pack", "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readdirSync(out).sort()).toEqual([MARKER, "assets", "index.html"]);
    expect(readFileSync(join(out, "assets", "app.js"), "utf8")).toBe(
      readFileSync(join(stub, "assets", "app.js"), "utf8"),
    );
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html.indexOf('id="report"')).toBeLessThan(html.indexOf('src="./assets/app.js"'));
    const { report } = reportIn(html);
    const printed = parseReport(JSON.parse(run(["pack", "--json"]).stdout));
    expect({ ...report, generatedAt: "" }).toEqual({ ...printed, generatedAt: "" });
  });

  it("escapes a name that would end the script element, and the Report reads back the same", () => {
    // A folder name is the pack's source; it cannot hold a slash, so `<!--<script>` stands in.
    const name = "x<!--<script>y";
    cpSync(join(fixtures, "pack"), join(root, name), { recursive: true });
    const out = join(root, "escaped");
    expect(run(["build", name, "--out", out]).status).toBe(0);
    const { text, report } = reportIn(readFileSync(join(out, "index.html"), "utf8"));
    expect(text).not.toContain("<");
    expect(report.source).toBe(name);

    // A skill name that closes the element and opens another, which no harness reads in today.
    const evil = "</script><script>alert(1)</script>";
    const original = structuredClone(report);
    const line = original.sheet[0]!.lines[0]!;
    line.ref.name = evil;
    line.item = `skill:${evil}`;
    original.source = "pack\u2028\u2029";
    const page = injectReport(readFileSync(join(stub, "index.html"), "utf8"), original);
    const back = reportIn(page);
    expect(back.text).not.toMatch(/[<\u2028\u2029]/u);
    expect(back.report).toEqual(original);
    expect(back.report.sheet[0]!.lines[0]!.item).toBe(`skill:${evil}`);
  });

  it("writes into a folder it wrote before, replacing only its own files", () => {
    const out = join(root, "again");
    expect(run(["build", "pack", "--out", out]).status).toBe(0);
    writeFileSync(join(out, "notes.txt"), "mine");
    const result = run(["build", "pack", "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("mine");
    expect(JSON.parse(readFileSync(join(out, MARKER), "utf8")).files).toEqual([
      "assets/app.js",
      "index.html",
    ]);
  });

  it("defaults to ./loadsheet-report", () => {
    const cwd = join(root, "cwd");
    mkdirSync(cwd);
    expect(run(["build", join(root, "pack")], { cwd }).status).toBe(0);
    expect(existsSync(join(cwd, "loadsheet-report", "index.html"))).toBe(true);
  });

  it.each([
    [
      "a folder holding files it did not write",
      (dir: string) => writeFileSync(join(dir, "a"), "a"),
    ],
    ["a marker that is not its own", (dir: string) => writeFileSync(join(dir, MARKER), "hello")],
  ])("stops with exit 2 on %s and leaves it alone", (_, prepare) => {
    const out = mkdtempSync(join(root, "taken-"));
    prepare(out);
    const before = readdirSync(out).map((file) => [file, readFileSync(join(out, file), "utf8")]);
    const result = run(["build", "pack", "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("did not write");
    expect(readdirSync(out).map((file) => [file, readFileSync(join(out, file), "utf8")])).toEqual(
      before,
    );
  });

  it("stops with exit 2 rather than overwrite a file of the user's in its own folder", () => {
    const out = join(root, "collide");
    mkdirSync(out);
    writeFileSync(join(out, MARKER), JSON.stringify({ files: ["assets/app.js"] }));
    writeFileSync(join(out, "index.html"), "the user's page");
    const result = run(["build", "pack", "--out", out]);
    expect(result.status).toBe(2);
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("the user's page");
  });

  it.each([
    ["a folder", "assets"],
    ["its page", "index.html"],
    ["its marker", MARKER],
  ])("stops with exit 2 at a link in place of %s, and touches nothing behind it", (_, name) => {
    const out = mkdtempSync(join(root, "linked-"));
    const elsewhere = mkdtempSync(join(root, "elsewhere-"));
    writeFileSync(join(elsewhere, "app.js"), "the user's script");
    writeFileSync(join(elsewhere, "page"), "the user's page");
    const marker = JSON.stringify({ files: ["assets/app.js", "index.html"] });
    if (name === MARKER) {
      writeFileSync(join(elsewhere, "marker"), marker);
      symlinkSync(join(elsewhere, "marker"), join(out, MARKER));
    } else {
      writeFileSync(join(out, MARKER), marker);
      symlinkSync(join(elsewhere, name === "assets" ? "." : "page"), join(out, name));
    }
    const result = run(["build", "pack", "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is a link");
    expect(readFileSync(join(elsewhere, "app.js"), "utf8")).toBe("the user's script");
    expect(readFileSync(join(elsewhere, "page"), "utf8")).toBe("the user's page");
    expect(readdirSync(elsewhere).sort()).toEqual(
      name === MARKER ? ["app.js", "marker", "page"] : ["app.js", "page"],
    );
    if (name === MARKER) expect(readFileSync(join(elsewhere, "marker"), "utf8")).toBe(marker);
  });

  it.each([[["build", "pack"]], [["pack", "--ui"]]])(
    "%j without a web UI stops with one line",
    (args: string[]) => {
      const result = run(args, { web: join(root, "no-web") });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        "This build of loadsheet has no web UI, so it cannot run build or --ui.\n",
      );
    },
  );

  it.each([[["pack", "--out", "x"]], [["build", "pack", "--ui"]], [["--ui", "--port", "http"]]])(
    "%j is a usage error",
    (args: string[]) => {
      expect(run(args).status).toBe(2);
    },
  );

  it("passes a usage error of the default command through", () => {
    const result = run(["build", "--days", "0"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--days");
  });
});

/** A raw GET, so a path such as `/../x` reaches the server as written. */
const get = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  new Promise<{ status: number; type: string; body: string }>((done, failed) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        done({
          status: response.statusCode ?? 0,
          type: response.headers["content-type"] ?? "",
          body,
        }),
      );
    });
    req.on("error", failed);
    req.end();
  });

/** Starts `loadsheet --ui` and resolves with its port once it prints the URL. */
const startUi = (args: string[], cwd: string) => {
  const child = spawn(process.execPath, [cli, "--ui", ...args], {
    cwd,
    env: { ...env, LOADSHEET_WEB_DIR: stub },
  });
  const port = new Promise<number>((done, failed) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//u.exec(out);
      if (match) done(Number(match[1]));
    });
    child.on("exit", (code) => failed(new Error(`exited ${code}`)));
  });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  return { child, port, exited };
};

describe("loadsheet --ui", () => {
  it("serves the page and its asset on 127.0.0.1, nothing outside them, writes nothing, and stops on Ctrl+C", async () => {
    const cwd = mkdtempSync(join(root, "serve-"));
    const { child, port: started, exited } = startUi([join(root, "pack")], cwd);
    const port = await started;

    const page = await get(port, "/");
    expect(page.status).toBe(200);
    expect(page.type).toContain("text/html");
    expect(reportIn(page.body).report.source).toBe("pack");
    const asset = await get(port, "/assets/app.js");
    expect(asset).toMatchObject({ status: 200, type: "text/javascript; charset=utf-8" });

    for (const path of [
      "/../ui.test.ts",
      "/%2e%2e/ui.test.ts",
      "/assets/%2e%2e/%2e%2e/pack/AGENTS.md",
      "/..%2fpack%2fAGENTS.md",
      "/%2e%2e%2f%2e%2e%2fpackage.json",
      "/nope.js",
    ]) {
      expect(await get(port, path), path).toMatchObject({ status: 404, body: "Not found\n" });
    }
    expect((await get(port, "/%E0%A4%A")).status).toBe(400);
    // A page elsewhere that resolves its own name to 127.0.0.1 is turned away.
    expect((await get(port, "/", "evil.example")).status).toBe(421);

    child.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("--port serves on the port given", async () => {
    const free = await new Promise<number>((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => done(port));
      });
    });
    const { child, port, exited } = startUi([join(root, "pack"), "--port", String(free)], root);
    expect(await port).toBe(free);
    child.kill("SIGINT");
    expect(await exited).toBe(0);
  });
});

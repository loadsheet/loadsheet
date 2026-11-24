// `loadsheet build` and `loadsheet --ui`: the Report the default command prints, put into the web
// UI's page, written to a folder or served from memory on 127.0.0.1.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReport, type Report } from "@loadsheet/schema";
import pkg from "../package.json" with { type: "json" };

/** The file `build` leaves in its folder: the files it wrote, so a later build replaces only those. */
export const MARKER = ".loadsheet-build";

const usage = `Usage: loadsheet build [--out <dir>] [options]  Write the report as a web page to <dir>
                                                (default ./loadsheet-report)
       loadsheet --ui [--port <n>] [options]     Serve the report as a web page on 127.0.0.1

The options are the default command's (\`loadsheet --help\`); the Report is the one it prints.
build writes only into a folder that is missing, empty or one it wrote before.
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * The Report as the body of `<script type="application/json" id="report">`. A name comes from the
 * user's disk, so every `<` is escaped: no `</script` or `<!--` in it can end the element. U+2028
 * and U+2029 are escaped too, for any reader that takes the text as JavaScript.
 */
export const reportJson = (report: Report): string =>
  JSON.stringify(report)
    .replaceAll("<", String.raw`\u003c`)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`);

/** The page with the Report element before its first script, so the app finds it when it runs. */
export const injectReport = (html: string, report: Report): string => {
  const element = `<script type="application/json" id="report">${reportJson(report)}</script>`;
  const at = html.search(/<script/iu);
  if (at !== -1) return html.slice(0, at) + element + html.slice(at);
  const end = html.search(/<\/body/iu);
  return end === -1 ? html + element : html.slice(0, end) + element + html.slice(end);
};

/** The web UI's built files, relative to `dir`, with `/` separators. */
const distFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();

/**
 * Splits this command's own flags from the ones the default command takes. After `--` every word is
 * the default command's: a pack may be named `--ui`.
 */
const parse = (argv: string[]) => {
  const build = argv[0] === "build";
  const rest = build ? argv.slice(1) : argv;
  let out: string | undefined;
  let port: string | undefined;
  let ui = false;
  let help = false;
  let version = false;
  let scan = false;
  const forward: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--") {
      forward.push(...rest.slice(index));
      break;
    }
    const value = (flag: string) => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      const next = rest[(index += 1)];
      // A value that starts with a dash goes after `=`, so a forgotten value takes no option for one.
      if (next === undefined || next.startsWith("-"))
        fail(`${flag} takes a value; write one that starts with - as ${flag}=<value>\n\n${usage}`);
      return next;
    };
    if (arg === "--out" || arg.startsWith("--out=")) out = value("--out");
    else if (arg === "--port" || arg.startsWith("--port=")) port = value("--port");
    else if (arg === "--ui") ui = true;
    else if (arg === "--help") help = true;
    else if (arg === "--version") version = true;
    // The default command's two short options, alone or together as in `-vh`.
    else if (/^-[hv]+$/u.test(arg)) {
      help ||= arg.includes("h");
      version ||= arg.includes("v");
    } else if (arg === "--scan") scan = true;
    else if (arg === "--json") continue;
    else forward.push(arg);
  }
  return { build, ui, out, port, help, version, scan, forward };
};

/** The Report the default command prints for these flags, or its exit code when it fails. */
const buildReport = (forward: string[]): Report => {
  const cli = process.argv[1]!;
  // --json goes first: after a `--` in `forward` it would be a pack, and a first word such as
  // `fleet` would be a command.
  const child = spawnSync(process.execPath, [...process.execArgv, cli, "--json", ...forward], {
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 1 << 30,
    encoding: "utf8",
  });
  if (child.error) fail(`Cannot run loadsheet: ${child.error.message}`, 1);
  if (child.status !== 0) process.exit(child.status ?? 1);
  try {
    return parseReport(JSON.parse(child.stdout));
  } catch (error) {
    fail(`loadsheet printed no Report: ${(error as Error).message}`, 1);
  }
};

/** Writes the page into `out`, which must be missing, empty, or a folder this command wrote. */
const writeBuild = async (out: string, web: string, html: string) => {
  const files = distFiles(web);
  let previous: string[] = [];
  if (existsSync(out)) {
    if (!lstatSync(out).isDirectory())
      fail(`${out} is not a folder; loadsheet build writes a folder`);
    const entries = readdirSync(out);
    if (entries.length > 0) {
      try {
        const marker: unknown = JSON.parse(readFileSync(join(out, MARKER), "utf8"));
        const listed = (marker as { files?: unknown } | null)?.files;
        // No path holds a NUL, so a list with one is not a build's.
        const path = (file: unknown) => typeof file === "string" && !file.includes("\0");
        if (!Array.isArray(listed) || !listed.every(path)) throw new Error("no file list");
        previous = listed;
      } catch {
        fail(
          `${out} holds files loadsheet build did not write; name an empty or missing folder with --out`,
        );
      }
    }
  }
  // The marker's paths that stay inside the folder: the only ones a build may replace.
  previous = previous.filter((file) => resolve(out, file).startsWith(out + sep));
  // A file the last build did not write is the user's: stop before touching anything.
  const mine = new Set([...previous, MARKER]);
  for (const file of files) {
    if (!mine.has(file) && existsSync(join(out, file)))
      fail(`${join(out, file)} is not loadsheet build's; it will not overwrite it`);
  }
  // Every path is looked at before any is changed, so a build that stops has changed nothing. A link
  // on the way to a file leads out of the folder, where nothing is loadsheet build's; a folder where
  // a file goes, or a file where a folder goes, is the user's change to the last build.
  const there = new Set<string>();
  for (const file of [...previous, ...files, MARKER]) {
    const parts = relative(out, resolve(out, file)).split(sep);
    let path = out;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      let found;
      try {
        found = lstatSync(path, { throwIfNoEntry: false });
      } catch {
        fail(`${path} cannot be read; name an empty or missing folder with --out`);
      }
      if (!found) break;
      if (found.isSymbolicLink())
        fail(`${path} is a link; loadsheet build writes and deletes through no link`);
      const last = index === parts.length - 1;
      if (last ? !found.isFile() : !found.isDirectory())
        fail(
          `${path} is not the ${last ? "file" : "folder"} loadsheet build wrote; name an empty or missing folder with --out`,
        );
      if (last) there.add(path);
    }
  }
  // Only a file the loop above found is deleted: a listed path that is not there needs no removal.
  for (const file of previous) {
    const path = resolve(out, file);
    if (!there.has(path)) continue;
    rmSync(path, { force: true });
    // Folders the last build made go too, once nothing else is left in them.
    for (let dir = dirname(path); dir.startsWith(out + sep); dir = dirname(dir)) {
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
    }
  }
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, MARKER),
    `${JSON.stringify({ tool: `loadsheet@${pkg.version}`, files })}\n`,
  );
  for (const file of files) {
    const target = join(out, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file === "index.html" ? html : readFileSync(join(web, file)));
  }
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Serves the page and the UI's files from memory on 127.0.0.1 until the process is stopped. */
const serve = (web: string, html: string, port: number) => {
  // Only these paths are served, so no request reaches a file outside the UI's folder.
  const files = new Map<string, Buffer>(
    distFiles(web).map((file) => [
      file,
      file === "index.html" ? Buffer.from(html) : readFileSync(join(web, file)),
    ]),
  );
  const server = createServer((request, response) => {
    const send = (status: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
      response.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    // A page on another site that resolves its name to 127.0.0.1 sends its own Host. One Host only:
    // of two, `headers.host` holds the first and a proxy may route on the second.
    const hosts = request.headersDistinct.host ?? [];
    const { port: bound } = server.address() as { port: number };
    if (
      hosts.length !== 1 ||
      (hosts[0] !== `127.0.0.1:${bound}` && hosts[0] !== `localhost:${bound}`)
    )
      return send(421, "Misdirected request\n");
    if (request.method !== "GET" && request.method !== "HEAD")
      return send(405, "Method not allowed\n");
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname).slice(1);
    } catch {
      return send(400, "Bad request\n");
    }
    const body = files.get(path === "" ? "index.html" : path);
    if (body === undefined) return send(404, "Not found\n");
    send(200, body, TYPES[extname(path || "index.html")] ?? "application/octet-stream");
  });
  server.on("error", (error: NodeJS.ErrnoException) =>
    fail(
      error.code === "EADDRINUSE"
        ? `Port ${port} is in use; pick another with --port`
        : `Cannot serve the report: ${error.message}`,
      1,
    ),
  );
  server.listen(port, "127.0.0.1", () => {
    const { port: bound } = server.address() as { port: number };
    process.stdout.write(`Serving the report at http://127.0.0.1:${bound}/ (Ctrl+C stops it)\n`);
  });
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};

export async function run(argv: string[]): Promise<void> {
  const { build, ui, out, port, help, version, scan, forward } = parse(argv);
  // The version before the help, as the default command answers both.
  if (version) {
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }
  if (help) {
    process.stdout.write(usage);
    process.exit(0);
  }
  if (build && ui) fail(`build writes the page and --ui serves it; pick one\n\n${usage}`);
  if (!build && out !== undefined) fail(`--out is for loadsheet build\n\n${usage}`);
  if (!ui && port !== undefined) fail(`--port is for loadsheet --ui\n\n${usage}`);
  if (scan) fail(`--scan prints a Scan, not a Report to show\n\n${usage}`);
  const portNumber = port === undefined ? 0 : Number(port);
  if (port !== undefined && (!/^\d+$/u.test(port) || portNumber < 1 || portNumber > 65_535))
    fail(`--port takes a port from 1 to 65535, got ${port}`);

  // The web UI is copied into dist/web when loadsheet is built; LOADSHEET_WEB_DIR names another.
  const web = resolve(
    process.env.LOADSHEET_WEB_DIR || fileURLToPath(new URL("./web/", import.meta.url)),
  );
  // A page that is a link is not copied, so it is no page to put the Report into.
  if (!lstatSync(join(web, "index.html"), { throwIfNoEntry: false })?.isFile())
    fail("This build of loadsheet has no web UI, so it cannot run build or --ui.", 1);

  const html = injectReport(readFileSync(join(web, "index.html"), "utf8"), buildReport(forward));
  if (build) {
    const dir = out ?? "loadsheet-report";
    await writeBuild(resolve(dir), web, html);
    process.stdout.write(`Wrote the report to ${join(dir, "index.html")}\n`);
  } else {
    serve(web, html, portNumber);
  }
}

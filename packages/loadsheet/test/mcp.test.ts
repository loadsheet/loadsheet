import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { checkMcpToolList } from "@loadsheet/mcp";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// Runs the built CLI, so `pnpm build` comes first.
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../../mcp/test/fixtures/deepwiki.json", import.meta.url));
const deepwiki = JSON.parse(readFileSync(fixture, "utf8")) as {
  initialize: unknown;
  tools: unknown[];
};

// Async, so the test's own HTTP server can answer while the CLI runs.
const run = (...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [cli, "mcp", ...args],
      { encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({ status: error ? (error.code as number) : 0, stdout, stderr }),
    );
  });

const TOKEN = "s3cret-token-value";
let server: Server;
let base: string;
const seen: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push(req.headers.authorization);
      if (req.url?.startsWith("/private") && req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(204).end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize" ? deepwiki.initialize : { tools: deepwiki.tools };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("loadsheet mcp", () => {
  it("--json on a tools/list file gives checkMcpToolList's diagnostics with the matrix", async () => {
    const result = await run(fixture, "--json");
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ source: "json", toolCount: deepwiki.tools.length });
    expect(report.diagnostics).toEqual(checkMcpToolList(deepwiki as never));
    expect(report.matrix.tools).toHaveLength(deepwiki.tools.length);
    // Warnings alone don't fail a run.
    expect(result.status).toBe(0);
  });

  it("prints each warning with its fix and docs link", async () => {
    const result = await run(fixture);
    expect(result.stdout).toMatch(/^loadsheet@[^:]+: MCP server DeepWiki/u);
    expect(result.stdout).toContain("warn MCP0001 ask_wiki_question");
    expect(result.stdout).toContain("docs: https://loadsheet.dev/docs/reference/mcp#mcp0001");
  });

  it("--max-warnings fails the run when there are more warnings", async () => {
    expect((await run(fixture, "--max-warnings", "0")).status).toBe(1);
    expect((await run(fixture, "--max-warnings", "100")).status).toBe(0);
  });

  it("--client checks only the clients it names", async () => {
    const report = JSON.parse((await run(fixture, "--json", "--client", "codex")).stdout);
    expect(report.clients).toEqual([{ id: "codex", label: "Codex" }]);
  });

  it("reads a running server and names only its origin", async () => {
    const result = await run(`${base}/mcp?key=abc`, "--json");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ source: "url", endpoint: base, server: { name: "DeepWiki" } });
    expect(result.stdout).not.toContain("key=abc");
  });

  it("sends --header and never prints its value", async () => {
    seen.length = 0;
    const result = await run(`${base}/private/mcp`, "--header", `Authorization: Bearer ${TOKEN}`);
    expect(result.status).toBe(0);
    expect(seen).toContain(`Bearer ${TOKEN}`);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("exits 3 with the --header hint when the server wants a token", async () => {
    const result = await run(`${base}/private/mcp`);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Cannot read the MCP server at ${base}`);
    expect(result.stderr).toContain('--header "Authorization: Bearer $TOKEN"');
  });

  it.each([
    [[], "Expected one"],
    [["missing.json"], "no such file"],
    [[fixture, "--client", "nope"], "Unknown client nope"],
    [[fixture, "--max-warnings", "x"], "--max-warnings"],
    [[fixture, "--header", "A: b"], "--header is sent to a server"],
    [["https://example.com/mcp", "--header", "no colon"], "--header takes"],
  ])("%j is a usage error, exit 2", async (args: string[], message: string) => {
    const result = await run(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage: loadsheet mcp");
  });
});

import { readFileSync } from "node:fs";
import { checkMcpToolList } from "@loadsheet/mcp";
import { describe, expect, test } from "vite-plus/test";
import {
  McpScanError,
  checkMcpUrl,
  parseMcpScanInput,
  scanEvent,
  scanMcp,
} from "../server/utils/mcp.ts";

const fixture = (name: string): { initialize: unknown; tools: unknown[] } =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/mcp/test/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

async function scanError(promise: Promise<unknown>): Promise<McpScanError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(McpScanError);
  return error as McpScanError;
}

describe("a pasted tools/list", () => {
  for (const name of ["context7", "deepwiki", "nuxt"]) {
    test(`${name} gives the codes checkMcpToolList gives`, async () => {
      const list = fixture(name);
      const expected = checkMcpToolList(list);
      const result = await scanMcp(parseMcpScanInput({ toolList: list }));
      expect(result.diagnostics).toEqual(expected);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result).toMatchObject({ source: "json", toolCount: list.tools.length });
      expect(result.ci).toBeUndefined();
      expect(result.matrix.tools.map((row) => row.tool)).toEqual(
        list.tools.map((tool) => (tool as { name: string }).name),
      );
    });
  }

  test("takes a JSON-RPC response, a bare tools array or a JSON string", async () => {
    const { tools } = fixture("deepwiki");
    const expected = checkMcpToolList({ tools }).map((d) => d.code);
    for (const toolList of [
      { jsonrpc: "2.0", id: 2, result: { tools } },
      tools,
      JSON.stringify({ tools }),
    ]) {
      const result = await scanMcp(parseMcpScanInput({ toolList }));
      expect(result.diagnostics.map((d) => d.code)).toEqual(expected);
    }
  });

  test("marks each client's cell with its worst severity and codes", async () => {
    const result = await scanMcp(
      parseMcpScanInput({ toolList: fixture("context7"), clients: ["codex", "claude-directory"] }),
    );
    expect(result.clients.map((c) => c.id)).toEqual(["codex", "claude-directory"]);
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.tool) continue;
      const row = result.matrix.tools.find((r) => r.tool === diagnostic.tool)!;
      for (const finding of diagnostic.findings) {
        expect(row.clients[finding.client]!.codes).toContain(diagnostic.code);
        expect(row.clients[finding.client]!.status).not.toBe("ok");
      }
    }
  });

  test("refuses what isn't a tools/list", async () => {
    expect((await scanError(scanMcp(parseMcpScanInput({ toolList: { hello: 1 } })))).code).toBe(
      "not-mcp",
    );
    expect(() => parseMcpScanInput({ toolList: [], clients: ["netscape"] })).toThrow(
      /Unknown client/,
    );
    expect(() => parseMcpScanInput({})).toThrow(McpScanError);
  });
});

describe("a URL", () => {
  test.each([
    ["http://mcp.deepwiki.com/mcp", "not-https"],
    ["ftp://mcp.deepwiki.com/mcp", "invalid-url"],
    ["not a url", "invalid-url"],
    ["https://mcp.deepwiki.com:8443/mcp", "invalid-url"],
    ["https://user:pass@mcp.deepwiki.com/mcp", "invalid-url"],
    ["https://127.0.0.1/mcp", "private-host"],
    ["https://0x7f000001/mcp", "private-host"],
    ["https://[::1]/mcp", "private-host"],
    ["https://localhost/mcp", "private-host"],
    ["https://api.localhost./mcp", "private-host"],
    ["https://printer.local/mcp", "private-host"],
    ["https://mcp.corp.internal/mcp", "private-host"],
    ["https://intranet/mcp", "private-host"],
  ])("%s is refused as %s", (url, code) => {
    expect(() => checkMcpUrl(url)).toThrow(expect.objectContaining({ code }));
  });

  test("a public https URL passes", () => {
    expect(checkMcpUrl("https://mcp.deepwiki.com/mcp").href).toBe("https://mcp.deepwiki.com/mcp");
  });

  test("reads the server and returns the CI command", async () => {
    const list = fixture("deepwiki");
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const message = JSON.parse(init?.body as string) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "initialize" ? list.initialize : { tools: list.tools };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    const result = await scanMcp(parseMcpScanInput({ url: "https://mcp.deepwiki.com/mcp" }), {
      fetch,
    });
    expect(result.diagnostics).toEqual(
      checkMcpToolList(list, { url: "https://mcp.deepwiki.com/mcp" }),
    );
    expect(result).toMatchObject({
      source: "url",
      ci: "npx vite-doctor --mcp-url https://mcp.deepwiki.com/mcp",
      server: { name: "DeepWiki" },
    });
  });

  test.each([401, 403])("a %i answer is auth-required with the local command", async (status) => {
    const fetch = async () => new Response(null, { status });
    const url = "https://mcp.example.dev/mcp?team=a&b=c";
    const error = await scanError(scanMcp(parseMcpScanInput({ url }), { fetch }));
    expect(error).toMatchObject({ code: "auth-required", status: 401 });
    expect(error.command).toBe(
      `npx vite-doctor --mcp-url 'https://mcp.example.dev/mcp?team=a&b=c' --mcp-header "Authorization: Bearer $TOKEN"`,
    );
    expect(scanEvent(undefined, error)).toBe("auth-required");
  });

  test("a body past the byte budget is too-large", async () => {
    const tools = Array.from({ length: 50_000 }, (_, i) => ({
      name: `tool_${i}`,
      description: "x".repeat(100),
    }));
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const message = JSON.parse(init?.body as string) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "initialize" ? {} : { tools };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    const error = await scanError(
      scanMcp(parseMcpScanInput({ url: "https://mcp.example.dev/mcp" }), { fetch }),
    );
    expect(error.code).toBe("too-large");
    expect(scanEvent(undefined, error)).toBe("error:too-large");
  });

  test("a redirect is not followed and the server is not-mcp", async () => {
    const fetch = async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    const error = await scanError(
      scanMcp(parseMcpScanInput({ url: "https://mcp.example.dev/mcp" }), { fetch }),
    );
    expect(error.code).toBe("not-mcp");
    expect(error.message).toMatch(/redirects are not followed/);
  });
});

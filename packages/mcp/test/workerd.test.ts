import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { checkMcpToolList } from "../dist/index.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = ["context7", "deepwiki", "nuxt", "edge"] as const;
const read = (fixture: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${fixture}.json`, import.meta.url), "utf8"));

let worker: Miniflare;

beforeAll(async () => {
  if (!existsSync(`${root}/dist/index.mjs`))
    throw new Error("Build @loadsheet/mcp first: pnpm --filter @loadsheet/mcp build");
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: root,
      modules: ["test/workerd/worker.mjs", "dist/index.mjs"].map((path) => ({
        type: "ESModule" as const,
        path: `${root}/${path}`,
      })),
      // No nodejs_compat: the package must run on workerd's web APIs alone.
      compatibilityDate: "2026-11-01",
      // Stands in for an MCP server, so the default `fetch` runs inside workerd.
      outboundService: async (request) => {
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const list = read(new URL(request.url).hostname.split(".")[0]!);
        const result = message.method === "initialize" ? list.initialize : { tools: list.tools };
        return Response.json({ jsonrpc: "2.0", id: message.id, result });
      },
    }),
  );
  await worker.ready;
}, 60_000);

afterAll(() => worker?.dispose());

async function inWorkerd(body: unknown): Promise<unknown> {
  const response = await worker.dispatchFetch("http://worker/", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

for (const fixture of fixtures) {
  test(`workerd checks the ${fixture} tools/list as Node does`, async () => {
    const list = read(fixture);
    const options = { serverName: fixture, url: "https://mcp.example.com/mcp" };
    const node = checkMcpToolList(list, options);
    expect(node.length).toBeGreaterThan(0);
    expect(await inWorkerd({ list, options })).toEqual(node);
  });
}

test("workerd reads a tools/list with the global fetch", async () => {
  expect(await inWorkerd({ url: "https://nuxt.example.com/mcp" })).toEqual(read("nuxt"));
});

import { HTTPError, defineHandler, getRequestIP, type H3Event } from "h3";
import { sql } from "drizzle-orm";
import { useDatabase } from "vite-hub/database";
import { requireRateLimit } from "vite-hub/rate-limit";
import {
  MCP_MAX_BYTES,
  McpScanError,
  parseMcpScanInput,
  scanEvent,
  scanMcp,
  type McpScanInput,
} from "../utils/mcp";

/**
  `POST /api/mcp` with `{ url }` or `{ toolList }`, and optional `clients`: an MCP server's tools/list checked against
  what each client does with it. A URL is read once over https, never stored or logged, and a server that wants a
  token gets back the loadsheet command that reads it locally. Only a daily count per outcome is kept.
*/
export default defineHandler(async (event) => {
  event.res.headers.set("cache-control", "no-store");
  const key =
    event.req.headers.get("cf-connecting-ip") ??
    getRequestIP(event, { xForwardedFor: true }) ??
    "unknown";
  // A URL scan sends up to 43 requests to someone else's server, so the bucket is tighter than /api/resolve's.
  await requireRateLimit({ headers: event.req.headers }, "mcp", { key, limit: 10, window: "1m" });
  let input: McpScanInput | undefined;
  try {
    input = parseMcpScanInput(await readJson(event));
    const result = await scanMcp(input, { signal: event.req.signal });
    count(event, scanEvent(input));
    return result;
  } catch (error) {
    count(event, scanEvent(input, error));
    if (!(error instanceof McpScanError)) throw error;
    const extra = error.command ? { command: error.command } : {};
    throw new HTTPError({
      status: error.status,
      message: error.message,
      data: { code: error.code, ...extra },
      body: { error: error.code, ...extra },
    });
  }
});

async function readJson(event: H3Event): Promise<unknown> {
  const tooLarge = () =>
    new McpScanError("too-large", `The request body passed ${MCP_MAX_BYTES / 1024 / 1024} MiB.`);
  if (Number(event.req.headers.get("content-length")) > MCP_MAX_BYTES) throw tooLarge();
  const reader = event.req.body?.getReader();
  if (!reader)
    throw new McpScanError("invalid-input", "Send a JSON body: { url } or { toolList }.");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MCP_MAX_BYTES) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new McpScanError("invalid-input", "The request body isn't JSON.");
  }
}

/** Adds one to today's count for `name`. A failed write never fails the scan. */
function count(event: H3Event, name: string) {
  const write = (async () => {
    const { db, schema } = useDatabase("default");
    const day = new Date().toISOString().slice(0, 10);
    await db
      .insert(schema.mcpCounters)
      .values({ day, event: name, n: 1 })
      .onConflictDoUpdate({
        target: [schema.mcpCounters.day, schema.mcpCounters.event],
        set: { n: sql`${schema.mcpCounters.n} + 1` },
      });
  })().catch((error: unknown) => {
    console.error("mcp counter write failed", error instanceof Error ? error.name : "unknown");
  });
  event.waitUntil(write);
}

import pkg from "../package.json" with { type: "json" };
import { parseMcpEndpoint } from "./endpoint.ts";
import { validateInitialize, validateTools } from "./input.ts";
import type { McpInitializeResult, McpTool, McpToolList } from "./types.ts";

const PROTOCOL_VERSION = "2025-11-25";

export interface FetchMcpToolListOptions {
  /** Extra request headers, such as `authorization`. */
  headers?: Record<string, string>;
  /** The client the `initialize` request names. @default { name: "@loadsheet/mcp", version } */
  clientInfo?: { name: string; version: string; [field: string]: unknown };
  /** Aborts each request after this many milliseconds. @default 10_000 */
  timeout?: number;
  /** Aborts the whole read, every request and body together, after this many milliseconds. @default 30_000 */
  deadline?: number;
  /** The most response bytes to read across every request. @default 8 MiB */
  maxBytes?: number;
  /**
   * The most `tools/list` pages to read. With `initialize`, `notifications/initialized` and the
   * closing DELETE, the default 40 keeps a full read under a Cloudflare Worker's 50 subrequests.
   * @default 40
   */
  maxPages?: number;
  /** Aborts the read when it aborts. */
  signal?: AbortSignal;
  /** Sends every request. Redirects are never followed. @default globalThis.fetch */
  fetch?: typeof globalThis.fetch;
}

/**
 * Why a read failed: `invalid-url` before any request, `http` for a non-2xx answer (see `status`),
 * `timeout` per request or at the deadline, `too-large` past `maxBytes`, `too-many-pages` past
 * `maxPages`, `invalid-response` when the answer isn't an MCP `tools/list`, and `network` when the
 * request couldn't be sent or its body read.
 */
export type McpFetchErrorReason =
  | "invalid-url"
  | "http"
  | "timeout"
  | "too-large"
  | "too-many-pages"
  | "invalid-response"
  | "network";

export class McpFetchError extends Error {
  readonly reason: McpFetchErrorReason;
  readonly status: number | undefined;
  constructor(message: string, reason: McpFetchErrorReason, status?: number) {
    super(message);
    this.name = "McpFetchError";
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Reads a Streamable HTTP MCP server's `initialize` result and every page of `tools/list`,
 * the same requests a client sends when it connects. Redirects are not followed.
 */
export async function fetchMcpToolList(
  url: string | URL,
  options: FetchMcpToolListOptions = {},
): Promise<McpToolList> {
  const endpoint = parseMcpEndpoint(url);
  if (!endpoint)
    throw new McpFetchError("Expected an absolute HTTP(S) MCP endpoint.", "invalid-url");
  const maxPages = options.maxPages ?? 40;
  const { request, close } = createRequester(endpoint, options);
  try {
    const initialize = (await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: options.clientInfo ?? { name: pkg.name, version: pkg.version },
    })) as McpInitializeResult;
    await request("notifications/initialized", undefined, true);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = (await request("tools/list", cursor ? { cursor } : {})) as {
        tools?: unknown;
        nextCursor?: unknown;
      };
      if (!Array.isArray(result?.tools))
        throw new McpFetchError(
          "The server's tools/list result has no `tools` array.",
          "invalid-response",
        );
      try {
        tools.push(...validateTools(result.tools));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new McpFetchError(error.message, "invalid-response");
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) return { initialize, tools };
    }
    throw new McpFetchError(
      `The server's tools/list kept paginating past ${maxPages} pages; raise \`maxPages\` to read more.`,
      "too-many-pages",
    );
  } finally {
    await close();
  }
}

function createRequester(url: URL, options: FetchMcpToolListOptions) {
  // Workers throw "Illegal invocation" when `fetch` is called detached from the global.
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeout = options.timeout ?? 10_000;
  const deadlineMs = options.deadline ?? 30_000;
  const deadline = AbortSignal.timeout(deadlineMs);
  const budget = { left: options.maxBytes ?? 8 * 1024 * 1024 };
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let id = 0;
  function headers() {
    const result = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...options.headers,
    });
    if (sessionId) result.set("mcp-session-id", sessionId);
    if (protocolVersion) result.set("mcp-protocol-version", protocolVersion);
    return result;
  }
  async function send(method: "POST" | "DELETE", body?: unknown) {
    return fetch(url, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        deadline,
        ...(options.signal ? [options.signal] : []),
      ]),
    });
  }
  async function close() {
    if (!sessionId) return;
    try {
      cancelBody(await send("DELETE"));
    } catch {
      return;
    }
  }
  async function request(method: string, params: unknown, notification = false): Promise<unknown> {
    const body = notification
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) };
    try {
      const response = await send("POST", body);
      if (!response.ok) {
        cancelBody(response);
        const hint =
          response.status >= 300 && response.status < 400
            ? " MCP redirects are not followed; configure the final endpoint URL."
            : response.status === 401 || response.status === 403
              ? " The endpoint needs authorization; pass a token in `headers`."
              : "";
        throw new McpFetchError(
          `${method} answered HTTP ${response.status}.${hint}`,
          "http",
          response.status,
        );
      }
      if (method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? undefined;
      if (notification) {
        cancelBody(response);
        return undefined;
      }
      const message = await readMessage(response, id, budget);
      if (message.error) {
        const code = typeof message.error.code === "number" ? ` ${message.error.code}` : "";
        throw new McpFetchError(`${method} returned JSON-RPC error${code}.`, "invalid-response");
      }
      if (method === "initialize") {
        try {
          const initialize = validateInitialize(message.result);
          protocolVersion = initialize.protocolVersion;
          return initialize;
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          throw new McpFetchError(error.message, "invalid-response");
        }
      }
      return message.result;
    } catch (error) {
      if (error instanceof McpFetchError) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      if (deadline.aborted)
        throw new McpFetchError(
          `${method} was still running at the ${deadlineMs} ms deadline for the whole read.`,
          "timeout",
        );
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new McpFetchError(
          `${method} got no complete response within ${timeout} ms.`,
          "timeout",
        );
      throw new McpFetchError(
        `${method} failed to send the request or read the response.`,
        "network",
      );
    }
  }
  return { request, close };
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown };
}

interface ByteBudget {
  left: number;
}

async function readMessage(
  response: Response,
  id: number,
  budget: ByteBudget,
): Promise<JsonRpcResponse> {
  const type = response.headers.get("content-type") ?? "";
  const message = type.toLowerCase().includes("text/event-stream")
    ? await readEventStream(response.body, id, budget)
    : matchingMessage(await readText(response.body, budget), id);
  if (message) return message;
  throw new McpFetchError(
    `The server sent no JSON-RPC response for request ${id}.`,
    "invalid-response",
  );
}

/** Yields the body's chunks, failing once they pass what is left of `maxBytes`. */
async function* chunks(body: Response["body"], budget: ByteBudget) {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      budget.left -= value.byteLength;
      if (budget.left < 0)
        throw new McpFetchError(
          "The server's responses passed `maxBytes` before tools/list ended.",
          "too-large",
        );
      yield value;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readText(body: Response["body"], budget: ByteBudget): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of chunks(body, budget)) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function matchingMessage(text: string, id: number): JsonRpcResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (message && typeof message === "object" && (message as JsonRpcResponse).id === id)
      return message as JsonRpcResponse;
  }
}

async function readEventStream(body: Response["body"], id: number, budget: ByteBudget) {
  const decoder = new TextDecoder();
  let line = "";
  let skipLF = false;
  let data: string[] = [];
  for await (const chunk of chunks(body, budget)) {
    for (const character of decoder.decode(chunk, { stream: true })) {
      const ignore = skipLF && character === "\n";
      skipLF = character === "\r";
      if (ignore) continue;
      if (character !== "\r" && character !== "\n") {
        line += character;
        continue;
      }
      if (!line && data.length) {
        const message = matchingMessage(data.join("\n"), id);
        if (message) return message;
        data = [];
      } else if (line === "data" || line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
      line = "";
    }
  }
}

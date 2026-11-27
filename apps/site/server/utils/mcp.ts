import {
  fetchMcpToolList,
  MCP_CLIENT_LABELS,
  McpFetchError,
  mcpReport,
  normalizeToolList,
  type McpClient,
  type McpReport,
  type McpToolList,
} from "@loadsheet/mcp";

export type McpScanErrorCode =
  | "invalid-input"
  | "invalid-url"
  | "not-https"
  | "private-host"
  | "timeout"
  | "too-large"
  | "not-mcp"
  | "auth-required";

const STATUS: Record<McpScanErrorCode, number> = {
  "invalid-input": 400,
  "invalid-url": 400,
  "not-https": 400,
  "private-host": 400,
  timeout: 504,
  "too-large": 413,
  "not-mcp": 502,
  "auth-required": 401,
};

export class McpScanError extends Error {
  readonly code: McpScanErrorCode;
  readonly status: number;
  /** For `auth-required`: the loadsheet command that reads the server with the user's own token. */
  readonly command: string | undefined;
  constructor(code: McpScanErrorCode, message: string, command?: string) {
    super(message);
    this.name = "McpScanError";
    this.code = code;
    this.status = STATUS[code];
    this.command = command;
  }
}

/** The largest request body, and the most bytes read from an MCP server across one scan. */
export const MCP_MAX_BYTES = 4 * 1024 * 1024;
/** One scan, every request to the server together. */
const DEADLINE_MS = 15_000;
/**
  A Worker request gets 50 subrequests. `initialize`, `notifications/initialized` and the closing DELETE take three,
  so 40 pages leave room, and the counter write goes through the D1 binding, which isn't a subrequest.
*/
const MAX_PAGES = 40;

const CLIENTS = Object.keys(MCP_CLIENT_LABELS) as McpClient[];

// Names that resolve inside a private network, or nowhere, rather than on the public internet.
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "home.arpa",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
];

/**
  The endpoint a scan may read: https on its default port, under a public DNS name. IP literals, single-label names
  and private suffixes are refused, so loadsheet.dev never sends a request into someone's network.
*/
export function checkMcpUrl(value: string): URL {
  const url = value.length <= 2048 ? URL.parse(value.trim()) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
    throw new McpScanError(
      "invalid-url",
      "Pass an absolute https URL, such as https://mcp.example.com/mcp.",
    );
  if (url.protocol === "http:")
    throw new McpScanError("not-https", "loadsheet.dev reads MCP servers over https only.");
  if (url.username || url.password)
    throw new McpScanError("invalid-url", "Leave credentials out of the URL.");
  if (url.port)
    throw new McpScanError(
      "invalid-url",
      "loadsheet.dev reads MCP servers on the default https port only.",
    );
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const isIp = host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (
    isIp ||
    !host.includes(".") ||
    PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  )
    throw new McpScanError(
      "private-host",
      "loadsheet.dev reads public MCP servers only. Run `npx loadsheet mcp <url>` on your machine for a private one.",
    );
  return url;
}

/** `value` as one shell word, so a pasted URL can't break the command it's printed in. */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The same check on the user's machine, which reads private servers and fits CI. */
export function localCommand(url: string, auth = false): string {
  const command = `npx loadsheet mcp ${shellWord(url)}`;
  return auth ? `${command} --header "Authorization: Bearer $TOKEN"` : command;
}

export type McpScanInput =
  | { kind: "url"; url: string; clients?: McpClient[] }
  | { kind: "json"; toolList: unknown; clients?: McpClient[] };

/** Reads `{ url }` or `{ toolList }`, with optional `clients`, from a parsed request body. */
export function parseMcpScanInput(body: unknown): McpScanInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new McpScanError("invalid-input", "Send a JSON object: { url } or { toolList }.");
  const { url, toolList, clients } = body as Record<string, unknown>;
  const picked = parseClients(clients);
  if ((url === undefined) === (toolList === undefined))
    throw new McpScanError("invalid-input", "Send either `url` or `toolList`, not both.");
  if (url !== undefined) {
    if (typeof url !== "string" || !url.trim())
      throw new McpScanError(
        "invalid-url",
        "`url` must be a string, such as https://mcp.example.com/mcp.",
      );
    return { kind: "url", url: url.trim(), ...(picked ? { clients: picked } : {}) };
  }
  let list = toolList;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      throw new McpScanError("invalid-input", "`toolList` is a string that isn't JSON.");
    }
  }
  return { kind: "json", toolList: list, ...(picked ? { clients: picked } : {}) };
}

function parseClients(value: unknown): McpClient[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length)
    throw new McpScanError(
      "invalid-input",
      `\`clients\` must be a non-empty array of: ${CLIENTS.join(", ")}.`,
    );
  const unknown = value.filter((client) => !CLIENTS.includes(client as McpClient));
  if (unknown.length)
    throw new McpScanError(
      "invalid-input",
      `Unknown client ${unknown.map((client) => JSON.stringify(client)).join(", ")}; expected one of ${CLIENTS.join(", ")}.`,
    );
  return [...new Set(value as McpClient[])];
}

export interface McpScanResult extends McpReport {
  source: "url" | "json";
  /** The same check in CI, against the live server. Only for a URL scan. */
  ci?: string;
}

export interface ScanMcpOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export async function scanMcp(
  input: McpScanInput,
  options: ScanMcpOptions = {},
): Promise<McpScanResult> {
  if (input.kind === "url") {
    const url = checkMcpUrl(input.url);
    const list = await readServer(url, input.url, options);
    return {
      source: "url",
      ...mcpReport(list, { ...(input.clients ? { clients: input.clients } : {}), url: url.href }),
      ci: localCommand(input.url),
    };
  }
  let list: McpToolList;
  try {
    list = normalizeToolList(input.toolList);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new McpScanError("not-mcp", error.message);
  }
  return { source: "json", ...mcpReport(list, input.clients ? { clients: input.clients } : {}) };
}

async function readServer(url: URL, given: string, options: ScanMcpOptions): Promise<McpToolList> {
  try {
    return await fetchMcpToolList(url, {
      clientInfo: { name: "loadsheet.dev", version: "1" },
      timeout: 10_000,
      deadline: DEADLINE_MS,
      maxBytes: MCP_MAX_BYTES,
      maxPages: MAX_PAGES,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof McpFetchError)) throw error;
    if (error.status === 401 || error.status === 403)
      throw new McpScanError(
        "auth-required",
        `The server answered HTTP ${error.status}: it needs a token. Run loadsheet on your machine with yours.`,
        localCommand(given, true),
      );
    switch (error.reason) {
      case "timeout":
        throw new McpScanError("timeout", error.message);
      case "too-large":
      case "too-many-pages":
        throw new McpScanError("too-large", error.message);
      default:
        throw new McpScanError("not-mcp", error.message);
    }
  }
}

/** The counter event for a scan's outcome: no URL, host or tool name ever goes into one. */
export function scanEvent(input: McpScanInput | undefined, error?: unknown): string {
  if (error instanceof McpScanError)
    return error.code === "auth-required" ? "auth-required" : `error:${error.code}`;
  if (error) return "error:internal";
  return input?.kind === "json" ? "scan-json" : "scan-url";
}

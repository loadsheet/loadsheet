import { checkMcpToolList, MCP_CLIENT_LABELS } from "./tool-list.ts";
import type { McpClient, McpCode, McpDiagnostic, McpFinding, McpToolList } from "./types.ts";

export type McpCellStatus = "ok" | "info" | "warn" | "error";

/** What one client does to one tool, or to the server as a whole. */
export interface McpMatrixCell {
  status: McpCellStatus;
  codes: McpCode[];
}

/** `checkMcpToolList`'s diagnostics for one server, with the server, its size and a client-by-tool matrix. */
export interface McpReport {
  /** The server's `initialize` result, when the list had one. */
  server?: { name?: string; version?: string; protocolVersion?: string };
  toolCount: number;
  clients: { id: McpClient; label: string }[];
  diagnostics: McpDiagnostic[];
  /** Per client: what happens to the server as a whole (instructions, tool count), then to each tool, in list order. */
  matrix: {
    server: Record<string, McpMatrixCell>;
    tools: { tool: string; clients: Record<string, McpMatrixCell> }[];
  };
}

export interface McpReportOptions {
  /** The clients to check. @default every client */
  clients?: McpClient[];
  /** The endpoint the list was read from, which the diagnostics' messages name. */
  url?: string;
}

const CLIENTS = Object.keys(MCP_CLIENT_LABELS) as McpClient[];
const RANK: Record<McpCellStatus, number> = { ok: 0, info: 1, warn: 2, error: 3 };

/** Checks a server's `tools/list` and lays the result out per client: what loadsheet.dev and `loadsheet mcp` print. */
export function mcpReport(list: McpToolList, options: McpReportOptions = {}): McpReport {
  const diagnostics = checkMcpToolList(list, {
    ...(options.clients ? { clients: options.clients } : {}),
    ...(options.url ? { url: options.url } : {}),
  });
  const ids = options.clients ?? CLIENTS;
  const row = () =>
    Object.fromEntries(ids.map((id) => [id, { status: "ok", codes: [] }])) as Record<
      string,
      McpMatrixCell
    >;
  const server = row();
  const tools = new Map(list.tools.map((tool) => [tool.name, row()]));
  for (const diagnostic of diagnostics) {
    const cells = diagnostic.tool === undefined ? server : tools.get(diagnostic.tool);
    if (!cells) continue;
    for (const finding of backing(diagnostic))
      mark(cells[finding.client], diagnostic.code, finding.severity);
  }
  const info = list.initialize;
  const serverInfo = {
    ...(typeof info?.serverInfo?.name === "string" ? { name: info.serverInfo.name } : {}),
    ...(typeof info?.serverInfo?.version === "string" ? { version: info.serverInfo.version } : {}),
    ...(typeof info?.protocolVersion === "string" ? { protocolVersion: info.protocolVersion } : {}),
  };
  return {
    ...(Object.keys(serverInfo).length ? { server: serverInfo } : {}),
    toolCount: list.tools.length,
    clients: ids.map((id) => ({ id, label: MCP_CLIENT_LABELS[id] })),
    diagnostics,
    matrix: { server, tools: [...tools].map(([tool, cells]) => ({ tool, clients: cells })) },
  };
}

/** Where a Diagnostic Code is documented. */
export function mcpDocsUrl(code: string): string {
  return `https://loadsheet.dev/docs/reference/mcp#${code.toLowerCase()}`;
}

/** A diagnostic's client findings; MCP0003 and MCP0010 can have none, and then count against each client they name. */
function backing(diagnostic: McpDiagnostic): Pick<McpFinding, "client" | "severity">[] {
  if (diagnostic.findings.length) return diagnostic.findings;
  return diagnostic.clients.map((client) => ({ client, severity: diagnostic.severity }));
}

function mark(cell: McpMatrixCell | undefined, code: McpCode, severity: McpFinding["severity"]) {
  if (!cell) return;
  if (RANK[severity] > RANK[cell.status]) cell.status = severity;
  if (!cell.codes.includes(code)) cell.codes.push(code);
}

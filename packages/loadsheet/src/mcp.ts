import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  fetchMcpToolList,
  isMcpHeaderName,
  MCP_CLIENT_LABELS,
  McpFetchError,
  mcpDocsUrl,
  mcpEndpointLabel,
  mcpReport,
  normalizeToolList,
  parseMcpEndpoint,
  type McpClient,
  type McpDiagnostic,
  type McpToolList,
} from "@loadsheet/mcp";
import pkg from "../package.json" with { type: "json" };

const CLIENTS = Object.keys(MCP_CLIENT_LABELS) as McpClient[];

const usage = `loadsheet ${pkg.version}
Checks an MCP server's tools/list against what each MCP client does with it: the tools a client
leaves out, cuts, rewrites or asks the user to confirm.

Usage: loadsheet mcp <url> [options]    Read a running server over Streamable HTTP, as a client
                                        does when it connects: initialize, then every page of
                                        tools/list
       loadsheet mcp <file> [options]   Check a tools/list saved as JSON: a tools array,
                                        { tools }, { initialize, tools } or a JSON-RPC response

Options:
  --header "Name: value"  Send this header with every request, repeatable, such as
                          --header "Authorization: Bearer $TOKEN". Never printed
  --client <id>           Check only this client, repeatable:
                          ${CLIENTS.join(", ")}
  --max-warnings <n>      Also exit 1 when there are more than <n> warnings
  --json                  Print the result as JSON: the shape loadsheet.dev's POST /api/mcp answers
  -h, --help              Print this help

Exit codes: 0 with no error diagnostics and within any --max-warnings limit, 1 on an error
diagnostic or when that limit is exceeded, 2 on invalid usage or file input, 3 when the server
can't be read. Warnings alone pass by default; use --max-warnings 0 to fail on any warning.
Each code is explained at https://loadsheet.dev/docs/reference/mcp.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${usage}`);
  process.exit(2);
}

export async function run(argv: string[]): Promise<void> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        header: { type: "string", multiple: true },
        client: { type: "string", multiple: true },
        "max-warnings": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail((error as Error).message);
  }
  const { values, positionals } = args;
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  if (positionals.length !== 1)
    fail(`Expected one MCP server URL or tools/list file, got ${positionals.length}`);
  const target = positionals[0]!;

  const clients = values.client?.map((client) => {
    if (!CLIENTS.includes(client as McpClient))
      fail(`Unknown client ${client}; expected one of ${CLIENTS.join(", ")}`);
    return client as McpClient;
  });
  const maxWarnings = values["max-warnings"];
  if (maxWarnings !== undefined && !/^\d+$/u.test(maxWarnings))
    fail(`--max-warnings takes a whole number, got ${maxWarnings}`);

  const isUrl = /^[a-z][a-z\d+.-]*:\/\//iu.test(target);
  if (!isUrl && values.header) fail("--header is sent to a server; a file has none");
  const headers: Record<string, string> = {};
  for (const header of values.header ?? []) {
    const colon = header.indexOf(":");
    const name = colon === -1 ? "" : header.slice(0, colon).trim();
    if (!isMcpHeaderName(name)) fail('--header takes "Name: value" with a valid header name');
    headers[name] = header.slice(colon + 1).trim();
  }

  // Messages and output name the origin only: a path or query can hold a token.
  const endpoint = isUrl ? mcpEndpointLabel(target) : undefined;
  let list: McpToolList;
  if (isUrl) {
    if (!parseMcpEndpoint(target)) fail(`${endpoint} is not an http or https URL`);
    try {
      list = await fetchMcpToolList(target, {
        headers,
        clientInfo: { name: "loadsheet", version: pkg.version },
        // No Worker's subrequest budget here, so read more pages than loadsheet.dev does.
        maxPages: 100,
      });
    } catch (error) {
      if (!(error instanceof McpFetchError)) throw error;
      const hint =
        error.status === 401 || error.status === 403
          ? `\nThe server wants a token: pass it with --header "Authorization: Bearer $TOKEN".`
          : "";
      process.stderr.write(`Cannot read the MCP server at ${endpoint}: ${error.message}${hint}\n`);
      process.exit(3);
    }
  } else {
    let text: string;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      fail(
        `Cannot read ${target}: ${code === "ENOENT" ? "no such file" : (error as Error).message}`,
      );
    }
    try {
      list = normalizeToolList(JSON.parse(text));
    } catch (error) {
      fail(`${target} is not a tools/list: ${(error as Error).message}`);
    }
  }

  const report = {
    source: isUrl ? ("url" as const) : ("json" as const),
    ...(endpoint ? { endpoint } : {}),
    ...mcpReport(list, { ...(clients ? { clients } : {}), ...(endpoint ? { url: endpoint } : {}) }),
  };
  const errors = report.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = report.diagnostics.filter((d) => d.severity === "warn").length;
  process.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMcpText(report, endpoint ?? target),
  );
  if (errors > 0 || (maxWarnings !== undefined && warnings > Number(maxWarnings)))
    process.exitCode = 1;
}

const ORDER = { error: 0, warn: 1, info: 2 } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function renderMcpText(report: ReturnType<typeof mcpReport>, where: string): string {
  const name = [report.server?.name, report.server?.version].filter(Boolean).join(" ");
  const count = (severity: McpDiagnostic["severity"]) =>
    report.diagnostics.filter((d) => d.severity === severity).length;
  const lines = [
    `loadsheet@${pkg.version}: MCP server ${name ? `${name} at ` : ""}${where}, ${plural(report.toolCount, "tool")}, ${plural(report.clients.length, "client")} checked`,
    `${plural(count("error"), "error")}, ${plural(count("warn"), "warning")}, ${count("info")} info`,
  ];
  const sorted = [...report.diagnostics].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || a.code.localeCompare(b.code),
  );
  const subject = (d: McpDiagnostic) => (d.tool === undefined ? "server" : d.tool);
  for (const d of sorted.filter((d) => d.severity !== "info")) {
    lines.push(
      "",
      `${d.severity} ${d.code} ${subject(d)}`,
      `  ${d.message}`,
      `  fix: ${d.fix}`,
      `  docs: ${mcpDocsUrl(d.code)}`,
    );
  }
  const notes = sorted.filter((d) => d.severity === "info");
  if (notes.length) {
    lines.push("", "info: client behavior notes (--json has each in full)");
    for (const d of notes) lines.push(`  ${d.code} ${subject(d)}: ${d.brief}`);
  }
  if (!sorted.length) lines.push("", "No diagnostics for the selected clients.");
  return `${lines.join("\n")}\n`;
}

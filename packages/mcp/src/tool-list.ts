import { checkMcpClientLimits, type CheckMcpClientLimitsOptions } from "./check.ts";
import { declaredHintFix } from "./clients/claude-directory.ts";
import { mcpEndpointLabel } from "./endpoint.ts";
import { normalizeToolList } from "./input.ts";
import type {
  McpClient,
  McpCode,
  McpDiagnostic,
  McpEffect,
  McpFinding,
  McpTool,
  McpToolList,
} from "./types.ts";

/** Every Diagnostic Code a `tools/list` can raise, in order. MCP0004 needs the server's source. */
export const MCP_TOOL_LIST_CODES: readonly McpCode[] = [
  "MCP0001",
  "MCP0002",
  "MCP0003",
  "MCP0005",
  "MCP0006",
  "MCP0007",
  "MCP0008",
  "MCP0009",
  "MCP0010",
];

export const MCP_CLIENT_LABELS: Record<McpClient, string> = {
  "claude-code": "Claude Code",
  claude: "Claude",
  "claude-directory": "Anthropic's Connectors Directory",
  chatgpt: "ChatGPT",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code",
  "gemini-cli": "Gemini CLI",
  "copilot-studio": "Copilot Studio",
};

export interface CheckMcpToolListOptions extends CheckMcpClientLimitsOptions {
  /** The server's endpoint. Findings name the server by its origin when it has no name. */
  url?: string;
  /**
   * The codes to report, every code in `MCP_TOOL_LIST_CODES` by default. With MCP0010 on, a tool
   * whose `annotations` aren't ToolAnnotations gets no MCP0001 or MCP0002 from them.
   */
  codes?: readonly McpCode[];
  /**
   * Tools whose definition the caller found in the server's source. A client renaming one of
   * these for a name MCP0003 already reports adds nothing to MCP0003's fix, so it is dropped.
   */
  definedTools?: Iterable<string>;
}

interface ClientLimit {
  code: McpCode;
  ruleId: string;
  effect: McpEffect;
  /** Completes "Tool `x` of MCP server "y" …" and "MCP server "y" …", such as "is left out". */
  outcome: string;
  /** Completes "`limit.minimum` … in Codex" on the brief, such as "dropped". */
  brief: string;
}

const CLIENT_LIMITS: ClientLimit[] = [
  {
    code: "MCP0005",
    ruleId: "mcp/clients/no-excluded-tool",
    effect: "excluded",
    outcome: "is left out, or makes requests fail,",
    brief: "left out or failing",
  },
  {
    code: "MCP0006",
    ruleId: "mcp/clients/no-truncated-text",
    effect: "truncated",
    outcome: "has text cut",
    brief: "cut",
  },
  {
    code: "MCP0007",
    ruleId: "mcp/clients/no-rewritten-schema",
    effect: "rewritten",
    outcome: "is rewritten",
    brief: "rewritten",
  },
  {
    code: "MCP0008",
    ruleId: "mcp/clients/no-stripped-constraint",
    effect: "stripped",
    outcome: "loses part of its input schema",
    brief: "dropped",
  },
  {
    code: "MCP0009",
    ruleId: "mcp/clients/no-reduced-context",
    effect: "context",
    outcome: "reaches the model with less context",
    brief: "reduced",
  },
];

/**
 * Checks a server's `tools/list` the way Doctor's MCP Rule Pack does, and returns one finding per
 * Diagnostic Code and tool, each with the client findings behind it. Accepts a tools array,
 * `{ tools }`, `{ initialize, tools }`, or a JSON-RPC `tools/list` response.
 */
export function checkMcpToolList(
  input: unknown,
  options: CheckMcpToolListOptions = {},
): McpDiagnostic[] {
  const list = normalizeToolList(input);
  const findings = checkMcpClientLimits(list, options);
  const codes = new Set(options.codes ?? MCP_TOOL_LIST_CODES);
  const defined = new Set(options.definedTools);
  const name = serverName(list, options.serverName);
  const label =
    name ??
    (options.url === undefined ? undefined : mcpEndpointLabel(options.url)) ??
    "an MCP server";
  const diagnostics: McpDiagnostic[] = [];
  for (const tool of list.tools) {
    // When MCP0010 explains annotations that aren't ToolAnnotations, a missing title or hint in
    // them would point the author at the wrong fix.
    const replaced = codes.has("MCP0010") && !!annotationsProblem(tool);
    const wire = findings.filter(
      (finding) =>
        finding.tool === tool.name && !(replaced && finding.pointer?.startsWith("/annotations")),
    );
    diagnostics.push(...toolDiagnostics(tool, wire, toolLabel(tool, label)));
  }
  for (const limit of CLIENT_LIMITS) {
    for (const [tool, grouped] of groupByTool(findings.filter((f) => f.effect === limit.effect))) {
      const kept =
        tool !== undefined && defined.has(tool)
          ? grouped.filter((finding) => !repeatsValidName(finding, tool))
          : grouped;
      if (kept.length) diagnostics.push(clientLimitDiagnostic(limit, label, tool, kept));
    }
  }
  return diagnostics
    .filter((diagnostic) => codes.has(diagnostic.code))
    .sort(
      (left, right) =>
        MCP_TOOL_LIST_CODES.indexOf(left.code) - MCP_TOOL_LIST_CODES.indexOf(right.code),
    );
}

function serverName(list: McpToolList, alias: string | undefined): string | undefined {
  const name = alias ?? list.initialize?.serverInfo?.name;
  return typeof name === "string" && name ? name : undefined;
}

function toolLabel(tool: McpTool, server: string): string {
  return `${JSON.stringify(tool.name)} of MCP server ${JSON.stringify(server)}`;
}

const SAFETY_BRIEF = "neither readOnlyHint nor destructiveHint is true";

const UNDECLARED_FIX =
  "Add `readOnlyHint: true` to the annotations if the tool only reads, or `destructiveHint: true` if it changes or deletes data. Only you can tell which one is true.";

const TYPE_FIX =
  "Send `annotations` as an object whose `title` is a string and whose `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` are booleans, such as `{ title: 'Search docs', readOnlyHint: true }`.";

const SCHEMA_FIX =
  "A schema landed where the annotations go. With `server.tool()`, pass the input schema as a raw Zod shape (`{ path: z.string() }`, not `z.object(...)`). With `server.registerTool(name, { inputSchema, annotations }, cb)`, pass a raw shape or a `z.object(...)`: a root `z.union(...)` or `.nullable()` still publishes an empty object schema, so make optional arguments optional fields (`{ path: z.string().optional() }`). Then set `annotations` to `{ title, readOnlyHint: true }` or `{ title, destructiveHint: true }`.";

function toolDiagnostics(tool: McpTool, wire: McpFinding[], label: string): McpDiagnostic[] {
  const diagnostics: McpDiagnostic[] = [];
  const titles = wire.filter((finding) => finding.rule === "claude-directory/missing-title");
  if (titles.length) {
    const topLevel = typeof tool.title === "string" && tool.title.trim();
    const suggested = topLevel ? (tool.title as string) : "<Human-readable name>";
    diagnostics.push(
      toolDiagnostic("MCP0001", "mcp/tools/require-annotation-title", tool, titles, {
        message: `MCP tool ${label} has no non-empty string in \`annotations.title\` in its tools/list entry.${topLevel ? ` It has a top-level title ${JSON.stringify(tool.title)}, which clients that read only \`annotations.title\` never show.` : ""} Anthropic's Connectors Directory flags tools without one, and clients on the 2025-03-26 revision show only the bare name.`,
        fix: `Add \`title: ${JSON.stringify(suggested)}\` to the tool's annotations.`,
        brief: `no annotations.title; add title: ${JSON.stringify(suggested)}`,
      }),
    );
  }
  if (wire.some((finding) => finding.rule === "claude-directory/missing-hint")) {
    // ChatGPT's confirmation prompt is the same condition seen from a client, so its source backs
    // this finding instead of becoming a second one.
    const hints = wire.filter(
      (finding) =>
        finding.rule === "claude-directory/missing-hint" ||
        finding.rule === "chatgpt/missing-read-only-hint",
    );
    const chatgpt = hints.some((finding) => finding.client === "chatgpt");
    diagnostics.push(
      toolDiagnostic("MCP0002", "mcp/tools/require-safety-hint", tool, hints, {
        message: `MCP tool ${label} sets neither \`readOnlyHint\` nor \`destructiveHint\` to true in its tools/list entry. Anthropic's Connectors Directory requires \`readOnlyHint: true\` for read-only tools or \`destructiveHint: true\` for tools that modify or delete data.${chatgpt ? " ChatGPT also treats it as a write action that needs the user's confirmation by default, because it has no `readOnlyHint`." : ""}`,
        fix: declaredHintFix(tool.annotations ?? {}) ?? UNDECLARED_FIX,
        brief: SAFETY_BRIEF,
      }),
    );
  }
  const problems = nameProblems(tool.name);
  if (problems.length)
    diagnostics.push(
      toolDiagnostic(
        "MCP0003",
        "mcp/tools/valid-name",
        tool,
        wire.filter((finding) => finding.pointer === "/name"),
        {
          message: `MCP tool ${label} has a name that ${problems.join(" and ")} in its tools/list entry. Anthropic's Connectors Directory rejects names over 64 characters, and MCP allows only letters, digits, \`_\`, \`-\`, and \`.\`.`,
          fix: "Rename the tool to at most 64 letters, digits, `_`, `-`, or `.`.",
          brief: `name ${problems.join(" and ")}`,
        },
      ),
    );
  const problem = annotationsProblem(tool);
  if (problem) {
    const empty =
      problem.schema && emptyInputSchema(tool)
        ? " Its `inputSchema` is empty too, so the tool's real input schema was likely passed as the annotations and never reached clients."
        : "";
    diagnostics.push(
      toolDiagnostic("MCP0010", "mcp/tools/valid-annotations", tool, [], {
        message: `In its tools/list entry, MCP tool ${label} ${problem.why}${empty}`,
        fix: problem.schema ? SCHEMA_FIX : TYPE_FIX,
        brief: problem.schema
          ? "annotations hold a serialized schema"
          : "annotations aren't valid ToolAnnotations",
      }),
    );
  }
  return diagnostics;
}

function toolDiagnostic(
  code: McpCode,
  ruleId: string,
  tool: McpTool,
  findings: McpFinding[],
  text: { message: string; fix: string; brief: string },
): McpDiagnostic {
  return {
    code,
    ruleId,
    severity: "warn",
    confidence: "high",
    tool: tool.name,
    clients: clientsOf(findings),
    ...text,
    findings,
  };
}

const SEVERITY_RANK: Record<McpFinding["severity"], number> = { info: 0, warn: 1, error: 2 };

/**
 * One finding for every client that applies the limit's effect to a tool, or to the server when
 * `tool` is undefined. It takes the worst severity and the lowest confidence of its client
 * findings, so neither overstates what a client does.
 */
function clientLimitDiagnostic(
  limit: ClientLimit,
  label: string,
  tool: string | undefined,
  findings: McpFinding[],
): McpDiagnostic {
  const subject =
    tool === undefined
      ? `MCP server ${JSON.stringify(label)}`
      : `Tool \`${tool}\` of MCP server ${JSON.stringify(label)}`;
  const clients = [...new Set(findings.map((finding) => MCP_CLIENT_LABELS[finding.client]))];
  const details = findings.map((finding) => `${finding.message}${measured(finding)}`).join(" ");
  return {
    code: limit.code,
    ruleId: limit.ruleId,
    severity: findings.reduce<McpFinding["severity"]>(
      (worst, finding) =>
        SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst,
      "info",
    ),
    confidence: findings.some((finding) => finding.confidence === "medium") ? "medium" : "high",
    ...(tool === undefined ? {} : { tool }),
    clients: clientsOf(findings),
    message: `${subject} ${limit.outcome} in ${list(clients)}. ${details}`,
    fix: [...new Set(findings.map((finding) => finding.fix))].join(" "),
    brief: briefRow(limit.brief, findings),
    findings,
  };
}

function clientsOf(findings: McpFinding[]): McpClient[] {
  return [...new Set(findings.map((finding) => finding.client))];
}

function groupByTool(findings: McpFinding[]): Map<string | undefined, McpFinding[]> {
  const byTool = new Map<string | undefined, McpFinding[]>();
  for (const finding of findings)
    byTool.set(finding.tool, [...(byTool.get(finding.tool) ?? []), finding]);
  return byTool;
}

// MCP0003 already asks to rename a tool whose name breaks MCP's rules; a client renaming that
// same name says nothing the fix doesn't cover.
function repeatsValidName(finding: McpFinding, name: string): boolean {
  return (
    finding.effect === "rewritten" && finding.pointer === "/name" && nameProblems(name).length > 0
  );
}

/** Such as "limit.minimum, offset.default dropped in Codex and VS Code". */
function briefRow(participle: string, findings: McpFinding[]): string {
  const clientsByPointer = new Map<string, Set<string>>();
  for (const { client, pointer, affectedPointers } of findings) {
    const pointers = affectedPointers?.length ? affectedPointers : [pointer ?? ""];
    for (const target of pointers) {
      let clients = clientsByPointer.get(target);
      if (!clients) clientsByPointer.set(target, (clients = new Set()));
      clients.add(MCP_CLIENT_LABELS[client]);
    }
  }
  const fieldsByClients = new Map<string, string[]>();
  for (const [pointer, clients] of clientsByPointer) {
    const label = list([...clients].sort());
    let fields = fieldsByClients.get(label);
    if (!fields) fieldsByClients.set(label, (fields = []));
    if (pointer) fields.push(pointerField(pointer));
  }
  const clauses = [...fieldsByClients].map(([clients, fields]) => {
    const shown = fields.length > 4 ? [...fields.slice(0, 3), `${fields.length - 3} more`] : fields;
    return `${shown.length ? `${shown.join(", ")} ` : ""}${participle} in ${clients}`;
  });
  const value = findings.length === 1 ? findings[0]!.measured : undefined;
  return `${clauses.join("; ")}${value ? ` (${value.value} ${value.unit}, limit ${value.limit})` : ""}`;
}

/** `/inputSchema/properties/limit/minimum` as `limit.minimum`. */
function pointerField(pointer: string): string {
  return pointer
    .replace(/^\/inputSchema\/properties\//, "/")
    .replace(/^\/initialize\//, "/")
    .replaceAll("/properties/", "/")
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function measured(finding: McpFinding): string {
  const value = finding.measured;
  return value ? ` Measured: ${value.value} ${value.unit}, limit ${value.limit}.` : "";
}

function list(items: string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

const NAME_CHARACTERS = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME_LENGTH = 64;

/** What makes a tool name break MCP's character set or the Connectors Directory's length limit. */
export function nameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length === 0) problems.push("is empty");
  if (name.length > MAX_NAME_LENGTH) problems.push(`is ${name.length} characters long`);
  if (name.length > 0 && !NAME_CHARACTERS.test(name))
    problems.push("uses characters other than letters, digits, `_`, `-`, and `.`");
  return problems;
}

const ANNOTATION_TYPES: Record<string, string> = {
  title: "string",
  readOnlyHint: "boolean",
  destructiveHint: "boolean",
  idempotentHint: "boolean",
  openWorldHint: "boolean",
};

const SDK_REJECTS =
  "The MCP TypeScript SDK's client rejects the whole tools/list response when it can't parse a tool's annotations, so clients built on it get none of the tools on that page, or none at all when the server sends one page.";

export interface AnnotationsProblem {
  why: string;
  /** The annotations hold a serialized schema, so the input schema likely went missing too. */
  schema: boolean;
}

/**
 * How a tool's `annotations` fail to be ToolAnnotations, checked the way the MCP SDK's client
 * parses them: an object whose known fields have their declared types. Unknown fields are allowed
 * and dropped, so only keys a serialized schema carries count against them.
 */
export function annotationsProblem(tool: McpTool): AnnotationsProblem | undefined {
  if (tool.annotations === undefined) return;
  const annotations: unknown = tool.annotations;
  if (annotations === null || typeof annotations !== "object" || Array.isArray(annotations)) {
    const kind =
      annotations === null
        ? "null"
        : Array.isArray(annotations)
          ? "an array"
          : `a ${typeof annotations}`;
    return {
      why: `sends \`annotations\` as ${kind}, not an object. ${SDK_REJECTS}`,
      schema: false,
    };
  }
  const record = annotations as Record<string, unknown>;
  const wrong = Object.entries(ANNOTATION_TYPES).flatMap(([key, type]) =>
    key in record && typeof record[key] !== type
      ? [`\`${key}\` to ${valueKind(record[key])} instead of a ${type}`]
      : [],
  );
  if (wrong.length) {
    return {
      why: `sets ${wrong.join(", ")} in \`annotations\`. ${SDK_REJECTS}`,
      schema: false,
    };
  }
  const markers = ["_def", "~standard", "_zod"].filter((key) => key in record);
  // Zod 4 schemas serialize to their `def`, whose `type` repeats at the top level.
  const def = record.def as Record<string, unknown> | null | undefined;
  if (
    typeof record.type === "string" &&
    def &&
    typeof def === "object" &&
    def.type === record.type
  ) {
    markers.push("def");
  }
  if (!markers.length) return;
  return {
    why: `sends a serialized schema as \`annotations\` (it has ${markers.map((key) => `\`${key}\``).join(", ")}). Clients drop the fields \`ToolAnnotations\` doesn't define, so the tool reaches them with no title or safety hints.`,
    schema: true,
  };
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return type === "object" ? "an object" : `a ${type}`;
}

/** A schema that declares no arguments, as the SDK publishes for a schema it couldn't convert. */
function emptyInputSchema(tool: McpTool): boolean {
  const schema = tool.inputSchema;
  if (!schema) return true;
  return Object.entries(schema).every(([key, value]) => {
    if (key === "type") return value === "object";
    if (key === "properties")
      return !!value && typeof value === "object" && !Object.keys(value).length;
    if (key === "additionalProperties") return typeof value === "boolean";
    return key === "$schema";
  });
}

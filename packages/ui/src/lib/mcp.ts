/**
  The MCP check page's reading of a `POST /api/mcp` answer: each client's worst status, the problems worst first, the
  verdict line, and the prompt that hands the fixes to an agent. The types name only what the page reads.
*/

export type McpSeverity = "error" | "warn" | "info";
export type McpStatus = "ok" | McpSeverity;

export interface McpCheckFinding {
  client: string;
  severity: McpSeverity;
  message: string;
  source?: { url?: string };
}

export interface McpCheckDiagnostic {
  code: string;
  severity: McpSeverity;
  tool?: string;
  clients: string[];
  fix: string;
  findings: McpCheckFinding[];
}

export interface McpCheck {
  server?: { name?: string; version?: string };
  toolCount: number;
  clients: { id: string; label: string }[];
  diagnostics: McpCheckDiagnostic[];
  matrix: {
    server: Record<string, { status: McpStatus }>;
    tools: { tool: string; clients: Record<string, { status: McpStatus }> }[];
  };
  ci?: string;
}

/** A failed check: the API's `error` code (or `rate-limited` for a 429), what the server said, and for a server that wants a token, the command that reads it locally. */
export interface McpCheckError {
  code: string;
  message?: string;
  command?: string;
}

/** Where a Diagnostic Code is documented, as `mcpDocsUrl` in `@loadsheet/mcp` gives it. */
export const mcpDocs = (code: string) =>
  `https://loadsheet.dev/docs/reference/mcp#${code.toLowerCase()}`;

const RANK: Record<McpStatus, number> = { ok: 0, info: 1, warn: 2, error: 3 };

const TITLES: Record<string, string> = {
  MCP0001: "Tools have no display title",
  MCP0002: "Tools don't say whether they only read",
  MCP0003: "Tool names that clients reject",
  MCP0004: "Tool output is indented JSON",
  MCP0005: "Clients leave tools out",
  MCP0006: "Clients cut long text",
  MCP0007: "Clients rewrite names or schemas",
  MCP0008: "Clients drop schema rules",
  MCP0009: "Clients shorten the server's instructions",
  MCP0010: "Annotations aren't valid",
};
export const problemTitle = (code: string) => TITLES[code] ?? code;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const andList = (xs: string[]) =>
  xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
export const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
export const hostOf = (url: string) => shortUrl(url).split("/")[0]!;
export const localCommand = (url: string) => `npx loadsheet mcp ${url}`;

/** What someone typed, as the URL to check: a bare host gets `https://`. */
export function mcpUrl(input: string): string {
  const value = input.trim();
  return !value || /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/** Each client's worst status, over the server as a whole and every tool. */
export function clientStatus(r: McpCheck): Record<string, McpStatus> {
  const out: Record<string, McpStatus> = Object.fromEntries(r.clients.map((c) => [c.id, "ok"]));
  for (const row of [r.matrix.server, ...r.matrix.tools.map((t) => t.clients)])
    for (const [id, cell] of Object.entries(row))
      if (RANK[cell.status] > RANK[out[id] ?? "ok"]) out[id] = cell.status;
  return out;
}

export interface McpProblem {
  code: string;
  severity: McpSeverity;
  items: McpCheckDiagnostic[];
  /** Each client it hits, with that client's worst finding. */
  clients: Map<string, McpCheckFinding>;
}

/** One problem per Diagnostic Code, with notes (info) apart; worst first, then by how many clients and tools it hits. */
export function mcpProblems(r: McpCheck): McpProblem[] {
  const groups = new Map<string, McpProblem>();
  for (const d of r.diagnostics) {
    const key = d.severity === "info" ? `${d.code}:info` : d.code;
    let g = groups.get(key);
    if (!g)
      groups.set(key, (g = { code: d.code, severity: d.severity, items: [], clients: new Map() }));
    if (RANK[d.severity] > RANK[g.severity]) g.severity = d.severity;
    g.items.push(d);
    for (const f of d.findings) {
      const cur = g.clients.get(f.client);
      if (!cur || RANK[f.severity] > RANK[cur.severity]) g.clients.set(f.client, f);
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      b.clients.size - a.clients.size ||
      b.items.length - a.items.length,
  );
}

/**
  A diagnostic's anchor in the report's URL fragment: its code and tool (`MCP0001-get-blog-post`), or the code alone
  for one about the server. Shared links carry it, so keep the format stable.
*/
export const mcpAnchor = (d: { code: string; tool?: string }) =>
  d.tool === undefined ? d.code : `${d.code}-${d.tool}`;
export const mcpHash = (anchor: string) => `#${encodeURIComponent(anchor)}`;

/** The anchor a URL fragment names, or "" when it names none. */
export function anchorOf(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

/**
  The problem an anchor points at, and the diagnostic when it names one. A bare code picks that code's first problem,
  and the code part matches in any case, as the docs' own `#mcp0001` anchors are lower case.
*/
export function mcpTarget(
  problems: McpProblem[],
  anchor: string,
): { problem: McpProblem; item?: McpCheckDiagnostic; anchor: string } | undefined {
  if (!anchor) return undefined;
  const lower = anchor.toLowerCase();
  for (const same of [(a: string) => a === anchor, (a: string) => a.toLowerCase() === lower])
    for (const problem of problems)
      for (const item of problem.items)
        if (same(mcpAnchor(item))) return { problem, item, anchor: mcpAnchor(item) };
  const problem = problems.find((p) => p.code.toLowerCase() === lower);
  return problem && { problem, anchor: problem.code };
}

/** The headline and the line under it. */
export function mcpVerdict(r: McpCheck, problems = mcpProblems(r)) {
  const st = clientStatus(r);
  const total = r.clients.length;
  const errs = r.clients.filter((c) => st[c.id] === "error");
  const warns = r.clients.filter((c) => st[c.id] === "warn");
  const real = problems.filter((p) => p.severity !== "info").length;
  const notes = problems.length - real;
  const names = (cs: { label: string }[]) => andList(cs.map((c) => c.label));
  if (errs.length) {
    const one = errs.length === 1;
    const more = warns.length
      ? ` ${plural(warns.length, "more client")} ${warns.length === 1 ? "has" : "have"} problems.`
      : "";
    return {
      breaks: true,
      title: `Breaks in ${errs.length} of ${total} clients`,
      sub: `${names(errs)} ${one ? "leaves" : "leave"} tools out or ${one ? "fails" : "fail"} on them.${more}`,
    };
  }
  return {
    breaks: false,
    title: `Works in all ${total} clients`,
    sub: warns.length
      ? `${plural(real, "problem")} to fix for ${names(warns)}.`
      : notes
        ? `No problems. ${plural(notes, "note")} below, nothing to fix.`
        : "No problems found.",
  };
}

/** The request that hands every problem to the user's agent, with the command that confirms the fix. */
export function mcpFixPrompt(r: McpCheck, url: string, problems = mcpProblems(r)): string {
  const label = Object.fromEntries(r.clients.map((c) => [c.id, c.label]));
  const lines = [
    `Fix my MCP server's tools/list. loadsheet.dev checked it at ${url} against ${r.clients.length} MCP clients and found these problems, worst first:`,
    "",
  ];
  let n = 0;
  for (const p of problems.filter((p) => p.severity !== "info"))
    for (const d of p.items) {
      const who = d.clients.length
        ? d.clients.map((c) => label[c] ?? c).join(", ")
        : "every client";
      const what = d.tool ? `tool \`${d.tool}\`` : "server";
      lines.push(
        `${++n}. ${d.code} (${d.severity}) ${what} in ${who}: ${d.fix} Docs: ${mcpDocs(d.code)}`,
      );
    }
  lines.push(
    "",
    "Only change what each fix names. Where a fix asks you to choose (for example readOnlyHint), check what the tool does first.",
    `Then run \`${localCommand(url)}\` and confirm no errors or warnings remain.`,
  );
  return lines.join("\n");
}

/**
  A failed check in plain words: `local` when running loadsheet on your machine gets past it, and `said`, what the API
  answered, when it tells the reader more than the line does.
*/
export function mcpFailure(e: McpCheckError): {
  title: string;
  text: string;
  local?: boolean;
  said?: string;
} {
  const plain = failureText(e.code);
  const said =
    e.message && !QUIET.has(e.code) && !plain.text.includes(e.message) ? e.message : undefined;
  return said ? { ...plain, said } : plain;
}

// Codes whose own line already says all the API's message does.
const QUIET = new Set(["not-https", "private-host", "rate-limited"]);

function failureText(code: string): { title: string; text: string; local?: boolean } {
  switch (code) {
    case "not-https":
      return {
        title: "Use an https URL",
        text: "loadsheet.dev reads MCP servers over https only.",
      };
    case "invalid-url":
    case "invalid-input":
      return {
        title: "That isn't a URL we can check",
        text: "Paste the full endpoint, such as https://mcp.example.com/mcp.",
      };
    case "private-host":
      return {
        title: "That address isn't public",
        text: "loadsheet.dev only reads public servers. Run the check on your machine instead:",
        local: true,
      };
    case "timeout":
      return {
        title: "The server took too long",
        text: "It didn't finish answering within 15 seconds. Run the check on your machine, where there's no time limit:",
        local: true,
      };
    case "too-large":
      return {
        title: "The server sent too much",
        text: "Its tools/list passed 4 MB or 40 pages. Run the check on your machine instead:",
        local: true,
      };
    case "not-mcp":
      return {
        title: "That URL isn't an MCP server",
        text: "It didn't answer like one. The endpoint often ends in /mcp.",
      };
    case "rate-limited":
      return { title: "Too many checks", text: "Wait a minute and try again." };
    default:
      return { title: "Something went wrong", text: "Try again in a minute." };
  }
}

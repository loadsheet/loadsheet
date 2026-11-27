import { createSSRApp, h } from "vue";
import { RouterView, createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { Landing, Mcp, Overlays, createLoadsheet } from "../src/index";
import {
  type McpCheck,
  mcpFailure,
  mcpFixPrompt,
  anchorOf,
  mcpAnchor,
  mcpHash,
  mcpProblems,
  mcpTarget,
  mcpUrl,
  mcpVerdict,
} from "../src/lib/mcp";

const URL = "https://mcp.example.com/mcp";
const ok = { status: "ok" as const };

// Two clients: Cursor drops a tool (error), the Directory wants titles (warn), Codex rewrites a name (info).
const check: McpCheck = {
  server: { name: "Example", version: "1.2.0" },
  toolCount: 2,
  clients: [
    { id: "cursor", label: "Cursor" },
    { id: "claude-directory", label: "Anthropic's Connectors Directory" },
    { id: "codex", label: "Codex" },
  ],
  diagnostics: [
    {
      code: "MCP0001",
      severity: "warn",
      tool: "search",
      clients: ["claude-directory"],
      fix: "Add `title` to the tool's annotations.",
      findings: [
        {
          client: "claude-directory",
          severity: "warn",
          message: "Directory review requires a title.",
          source: { url: "https://claude.com/docs/connectors" },
        },
      ],
    },
    {
      code: "MCP0005",
      severity: "error",
      tool: "fetch_everything",
      clients: ["cursor"],
      fix: "Split the tool.",
      findings: [{ client: "cursor", severity: "error", message: "Cursor leaves it out." }],
    },
    {
      code: "MCP0007",
      severity: "info",
      tool: "search",
      clients: ["codex"],
      fix: "Nothing to change.",
      findings: [{ client: "codex", severity: "info", message: "Codex prefixes the name." }],
    },
  ],
  matrix: {
    server: { cursor: ok, "claude-directory": ok, codex: ok },
    tools: [
      {
        tool: "search",
        clients: { cursor: ok, "claude-directory": { status: "warn" }, codex: { status: "info" } },
      },
      {
        tool: "fetch_everything",
        clients: { cursor: { status: "error" }, "claude-directory": ok, codex: ok },
      },
    ],
  },
  ci: `npx loadsheet mcp ${URL}`,
};

describe("the MCP check's reading of an answer", () => {
  it("sorts problems worst first and keeps notes apart", () => {
    expect(mcpProblems(check).map((p) => `${p.code} ${p.severity}`)).toEqual([
      "MCP0005 error",
      "MCP0001 warn",
      "MCP0007 info",
    ]);
  });

  it("says which clients break", () => {
    expect(mcpVerdict(check)).toEqual({
      breaks: true,
      title: "Breaks in 1 of 3 clients",
      sub: "Cursor leaves tools out or fails on them. 1 more client has problems.",
    });
    const clean = { ...check, diagnostics: [], matrix: { server: {}, tools: [] } };
    expect(mcpVerdict(clean)).toMatchObject({ breaks: false, title: "Works in all 3 clients" });
  });

  it("hands every problem but the notes to the agent, with the command that confirms the fix", () => {
    const prompt = mcpFixPrompt(check, URL);
    expect(prompt).toContain(`checked it at ${URL} against 3 MCP clients`);
    expect(prompt).toContain(
      "1. MCP0005 (error) tool `fetch_everything` in Cursor: Split the tool. Docs: https://loadsheet.dev/docs/reference/mcp#mcp0005",
    );
    expect(prompt).toContain("2. MCP0001 (warn) tool `search` in Anthropic's Connectors Directory");
    expect(prompt).not.toContain("MCP0007");
    expect(prompt).toContain(`Then run \`npx loadsheet mcp ${URL}\``);
  });

  it("names each diagnostic by code and tool in the URL fragment", () => {
    const problems = mcpProblems(check);
    expect(mcpAnchor({ code: "MCP0001", tool: "get-blog-post" })).toBe("MCP0001-get-blog-post");
    expect(mcpAnchor({ code: "MCP0009" })).toBe("MCP0009");
    expect(mcpHash("MCP0001-my tool")).toBe("#MCP0001-my%20tool");
    expect(anchorOf("#MCP0001-my%20tool")).toBe("MCP0001-my tool");
    expect(anchorOf("#%E0%A4%A")).toBe("");

    expect(mcpTarget(problems, "MCP0001-search")).toMatchObject({
      problem: { code: "MCP0001", severity: "warn" },
      item: { tool: "search" },
      anchor: "MCP0001-search",
    });
    // The code part in any case, as the docs' anchors are lower case; a bare code is its first problem.
    expect(mcpTarget(problems, "mcp0007-search")).toMatchObject({
      problem: { code: "MCP0007", severity: "info" },
      anchor: "MCP0007-search",
    });
    expect(mcpTarget(problems, "mcp0005")).toMatchObject({ anchor: "MCP0005" });
    expect(mcpTarget(problems, "MCP0005")?.item).toBeUndefined();
    expect(mcpTarget(problems, "MCP0001-nope")).toBeUndefined();
    expect(mcpTarget(problems, "")).toBeUndefined();
  });

  it("adds https to a bare host", () => {
    expect(mcpUrl(" mcp.deepwiki.com/mcp ")).toBe("https://mcp.deepwiki.com/mcp");
    expect(mcpUrl("http://example.com")).toBe("http://example.com");
  });

  it("words failures plainly, with what the server said when it adds something", () => {
    expect(mcpFailure({ code: "not-mcp", message: "initialize answered HTTP 405." })).toEqual({
      title: "That URL isn't an MCP server",
      text: "It didn't answer like one. The endpoint often ends in /mcp.",
      said: "initialize answered HTTP 405.",
    });
    expect(mcpFailure({ code: "private-host", message: "anything" })).toMatchObject({
      local: true,
    });
    expect(mcpFailure({ code: "private-host", message: "anything" }).said).toBeUndefined();
    expect(mcpFailure({ code: "boom" }).title).toBe("Something went wrong");
  });
});

async function render(url: string, props: Record<string, unknown> = {}, withMcp = true) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: Landing },
      // The landing page links to these.
      { path: "/report", name: "report", component: Landing },
      { path: "/pack/:slug+", name: "pack", component: Landing },
      ...(withMcp ? [{ path: "/mcp", name: "mcp", component: Mcp, props: () => props }] : []),
    ],
  });
  const app = createSSRApp({ render: () => [h(RouterView), h(Overlays)] })
    .use(createLoadsheet({ shareBase: () => "https://loadsheet.dev/" }))
    .use(router);
  await router.push(url);
  await router.isReady();
  return renderToString(app);
}

describe("the MCP check page on a server", () => {
  it("renders the form and three servers to try", async () => {
    const html = await render("/mcp");
    expect(html).toContain("Does your MCP server work in every client?");
    for (const s of ["mcp.deepwiki.com/mcp", "nuxt.com/mcp", "mcp.linear.app/mcp"])
      expect(html).toContain(s);
  });

  it("renders a result: verdict, a pill per client, problems with doc links, notes and CI folded", async () => {
    const html = await render("/mcp", { url: URL, result: check });
    expect(html).toContain("Breaks in 1 of 3 clients");
    expect(html).toContain("Example 1.2.0 · 2 tools · mcp.example.com/mcp");
    expect(html).toContain("Copy fix prompt");
    expect(html).toContain("2 problems, worst first");
    expect(html.indexOf("Clients leave tools out")).toBeLessThan(
      html.indexOf("Tools have no display title"),
    );
    expect(html).toContain('href="https://loadsheet.dev/docs/reference/mcp#mcp0005"');
    expect(html).toContain("1 note on client behavior");
    expect(html).toContain("Run this check in CI");
    // Each card carries its code as an id, and the shared-link button.
    expect(html).toContain('id="MCP0005"');
    expect(html).toContain('id="MCP0001"');
    expect(html).toContain('aria-label="Copy a link to MCP0005"');
  });

  it("links each tool row to its diagnostic", async () => {
    const tools = ["a", "b", "c", "d", "get-blog-post"];
    const many: McpCheck = {
      ...check,
      diagnostics: tools.map((tool) => ({
        code: "MCP0001",
        severity: "warn" as const,
        tool,
        clients: ["claude-directory"],
        fix: `Add a title to \`${tool}\`.`,
        findings: [
          { client: "claude-directory", severity: "warn" as const, message: "Needs one." },
        ],
      })),
    };
    const html = await render("/mcp", { url: URL, result: many });
    expect(html).toContain('<li id="MCP0001-get-blog-post">');
    expect(html).toContain('href="#MCP0001-get-blog-post"');
  });

  it("gives a server that wants a token the command to run locally", async () => {
    const command = `npx loadsheet mcp ${URL} --header "Authorization: Bearer $TOKEN"`;
    const html = await render("/mcp", { url: URL, error: { code: "auth-required", command } });
    expect(html).toContain("This server needs a token");
    expect(html).toContain("mcp.example.com answered HTTP 401");
    expect(html).toContain("Copy prompt for your agent");
  });

  it("renders a failure as a plain line", async () => {
    const html = await render("/mcp", {
      url: "https://example.com",
      error: { code: "not-mcp", message: "initialize answered HTTP 405." },
    });
    expect(html).toContain("That URL isn&#39;t an MCP server");
    expect(html).toContain("The server said: initialize answered HTTP 405.");
  });

  it("links the header to the check only where a host registers it", async () => {
    expect(await render("/")).toContain('href="/mcp"');
    expect(await render("/", {}, false)).not.toContain('href="/mcp"');
  });
});

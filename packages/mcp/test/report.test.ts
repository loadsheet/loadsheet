import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { checkMcpToolList, mcpDocsUrl, mcpReport, normalizeToolList } from "../src/index.ts";

const list = normalizeToolList(
  JSON.parse(readFileSync(new URL("./fixtures/nuxt.json", import.meta.url), "utf8")),
);

test("mcpReport holds checkMcpToolList's diagnostics and a cell per client and tool", () => {
  const report = mcpReport(list);
  expect(report.diagnostics).toEqual(checkMcpToolList(list));
  expect(report.toolCount).toBe(list.tools.length);
  expect(report.matrix.tools.map((row) => row.tool)).toEqual(list.tools.map((tool) => tool.name));
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.tool === undefined) continue;
    const row = report.matrix.tools.find((r) => r.tool === diagnostic.tool)!;
    const clients = diagnostic.findings.length
      ? diagnostic.findings.map((f) => f.client)
      : diagnostic.clients;
    for (const client of clients) expect(row.clients[client]!.codes).toContain(diagnostic.code);
  }
});

test("mcpReport checks only the clients it is given", () => {
  const report = mcpReport(list, { clients: ["codex"] });
  expect(report.clients).toEqual([{ id: "codex", label: "Codex" }]);
  expect(Object.keys(report.matrix.server)).toEqual(["codex"]);
  expect(report.diagnostics).toEqual(checkMcpToolList(list, { clients: ["codex"] }));
});

test("mcpReport combines the Directory warning and ChatGPT info in MCP0002", () => {
  const report = mcpReport(
    { tools: [{ name: "search" }] },
    {
      clients: ["claude-directory", "chatgpt"],
    },
  );
  expect(report.diagnostics.filter(({ code }) => code === "MCP0002")).toMatchObject([
    { severity: "warn", clients: ["claude-directory", "chatgpt"] },
  ]);
  expect(report.matrix.tools[0]?.clients.chatgpt).toEqual({ status: "info", codes: ["MCP0002"] });
});

test("mcpDocsUrl points at the code's anchor on loadsheet.dev", () => {
  expect(mcpDocsUrl("MCP0005")).toBe("https://loadsheet.dev/docs/reference/mcp#mcp0005");
});

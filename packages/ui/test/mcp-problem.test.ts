import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { expect, it, vi } from "vite-plus/test";
import McpProblem from "../src/components/McpProblem.vue";
import type { McpCheckDiagnostic, McpProblem as Problem } from "../src/lib/mcp";

function render(fixes: string[], target?: string, toolNames?: string[]) {
  const code = "MCP0001";
  const problem: Problem = {
    code,
    severity: "warn",
    clients: new Map(),
    items: fixes.map((fix, index): McpCheckDiagnostic => ({
      code,
      severity: "warn",
      tool: toolNames?.[index] ?? `get_records_${index}`,
      clients: [],
      findings: [],
      fix,
    })),
  };
  return renderToString(
    createSSRApp({
      render: () => h(McpProblem, { problem, labels: {}, tools: fixes.length, target }),
    }),
  );
}

it("keeps the all-tools summary but reveals and marks a deep-linked tool", async () => {
  const fixes = ["Add a title.", "Add a title."];
  const idle = await render(fixes);
  expect(idle).toContain("All 2 tools");
  expect(idle).not.toContain("get_records_");

  const targeted = await render(fixes, "MCP0001-get_records_1");
  expect(targeted).toContain("All 2 tools");
  expect(targeted).toContain('id="MCP0001-get_records_1" data-on=""');
  expect(targeted).not.toContain("get_records_0");
});

it("unfolds a long tool list when the fragment names a folded tool", async () => {
  const fixes = Array.from({ length: 44 }, (_, index) => `Set \`title: "Record ${index}"\`.`);
  const idle = await render(fixes);
  expect(idle).toContain("14 more");
  expect(idle).not.toContain('id="MCP0001-get_records_43"');

  const targeted = await render(fixes, "MCP0001-get_records_43");
  expect(targeted).toContain('id="MCP0001-get_records_43" data-on=""');
  expect(targeted).not.toContain("14 more");
});

it("associates a templated tool link and its disclosure with the exact fix", async () => {
  const html = await render(['Set `title: "Draft records"`.', 'Set `title: "Final records"`.']);
  const id = html.match(/href="#MCP0001-get_records_0" aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  expect(html).toContain('aria-label="Fix for get_records_0"');
  expect(html).toContain(`aria-expanded="false" aria-controls="${id}"`);
  expect(html).toContain(`id="${id}" class="mc-exact" style="display:none;"`);
  expect(html).toContain("Set <code>title: &quot;Draft records&quot;</code>.");
});

it("gives duplicate tool names distinct exact-fix descriptions without changing their links", async () => {
  const html = await render(
    ['Set `title: "Draft records"`.', 'Set `title: "Final records"`.'],
    undefined,
    ["get_records", "get_records"],
  );
  const ids = [...html.matchAll(/href="#MCP0001-get_records" aria-describedby="([^"]+)"/g)].map(
    ([, id]) => id,
  );
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const [index, title] of ["Draft records", "Final records"].entries()) {
    const id = ids[index];
    expect(html).toContain(`aria-controls="${id}"`);
    expect(html).toContain(
      `id="${id}" class="mc-exact" style="display:none;">Set <code>title: &quot;${title}&quot;</code>.`,
    );
  }
});

it("groups mixed fixes and shared suffixes in input order without Map.groupBy", async () => {
  const groupBy = vi.spyOn(Map, "groupBy").mockImplementation(() => {
    throw new Error("Map.groupBy is unavailable");
  });
  try {
    for (const prefix of ["", "Check the annotations. "]) {
      const html = await render([
        `${prefix}Remove the bad title.`,
        `${prefix}Use a boolean.`,
        `${prefix}Remove the bad title.`,
      ]);
      expect(html).toContain("Remove the bad title.");
      expect(html).toContain("Use a boolean.");
      expect(html.indexOf("Remove the bad title.")).toBeLessThan(html.indexOf("Use a boolean."));
      expect(html).toContain('id="MCP0001-get_records_2"');
    }
  } finally {
    groupBy.mockRestore();
  }
});

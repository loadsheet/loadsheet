import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { checkMcpToolList, MCP_TOOL_LIST_CODES, type McpDiagnostic } from "../src/index.ts";

// What Doctor's MCP Rule Pack reported for each fixture, by `fixture:alias` (`-` for none). Doctor
// read the fixture as a server at `url` with the `mcp/strict` preset. To refresh, run Doctor on the
// fixtures and map each MCP Diagnostic's `why` to `message`, `suggestion` to `fix`, and
// `data.findings` to `findings`.
const expected: {
  doctor: string;
  url: string;
  runs: Record<string, McpDiagnostic[]>;
} = JSON.parse(readFileSync(new URL("./fixtures/doctor-expected.json", import.meta.url), "utf8"));

// Doctor orders Diagnostics by Rule, and Rules don't run in code order. Within a code both list
// tools in tools/list order, which a stable sort keeps.
const byCode = (diagnostics: McpDiagnostic[]) =>
  diagnostics.toSorted(
    (left, right) =>
      MCP_TOOL_LIST_CODES.indexOf(left.code) - MCP_TOOL_LIST_CODES.indexOf(right.code),
  );

for (const [run, diagnostics] of Object.entries(expected.runs)) {
  const [fixture, alias] = run.split(":") as [string, string];
  test(`matches ${expected.doctor} on ${fixture} ${alias === "-" ? "without an alias" : `as ${alias}`}`, () => {
    const list: unknown = JSON.parse(
      readFileSync(new URL(`./fixtures/${fixture}.json`, import.meta.url), "utf8"),
    );
    const actual = checkMcpToolList(list, {
      serverName: alias === "-" ? undefined : alias,
      url: expected.url,
    });
    expect(actual).toEqual(byCode(diagnostics));
  });
}

test("the fixtures raise every code a tools/list can", () => {
  const codes = new Set(Object.values(expected.runs).flatMap((run) => run.map((d) => d.code)));
  expect([...codes].sort()).toEqual([...MCP_TOOL_LIST_CODES]);
});

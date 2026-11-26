import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { annotationsProblem, checkMcpToolList, nameProblems } from "../src/index.ts";

const edge: { tools: { name: string }[] } = JSON.parse(
  readFileSync(new URL("./fixtures/edge.json", import.meta.url), "utf8"),
);
const longName = edge.tools[1]!.name;

describe("checkMcpToolList", () => {
  test("accepts a bare tools array and names the server by its endpoint", () => {
    const [title] = checkMcpToolList([{ name: "search", annotations: { readOnlyHint: true } }], {
      url: "https://docs.example.com/mcp?token=secret",
    });
    expect(title).toMatchObject({
      code: "MCP0001",
      tool: "search",
      clients: ["claude-directory"],
      message: expect.stringContaining('"search" of MCP server "https://docs.example.com"'),
    });
    expect(checkMcpToolList([{ name: "search" }])[0]?.message).toContain('"an MCP server"');
  });

  test("reports only the given codes", () => {
    const codes = checkMcpToolList(edge, { codes: ["MCP0003", "MCP0005"] }).map((d) => d.code);
    expect(new Set(codes)).toEqual(new Set(["MCP0003", "MCP0005"]));
  });

  test("keeps title and hint findings in annotations MCP0010 isn't reporting", () => {
    const zod = (codes?: ("MCP0001" | "MCP0002" | "MCP0010")[]) =>
      checkMcpToolList(edge, { codes })
        .filter((d) => d.tool === "zod_schema")
        .map((d) => d.code);
    expect(zod()).toEqual(["MCP0010"]);
    expect(zod(["MCP0001", "MCP0002"])).toEqual(["MCP0001", "MCP0002"]);
  });

  test("drops a client's rename of a defined tool that MCP0003 already asks to rename", () => {
    const renames = (definedTools?: string[]) =>
      checkMcpToolList(edge, { codes: ["MCP0007"], definedTools })
        .filter((d) => d.tool === longName || d.tool === "search docs!")
        .map((d) => d.tool);
    expect(renames()).toEqual(["search docs!", longName]);
    expect(renames(["search docs!", longName])).toEqual([]);
  });

  test("checks only the given clients", () => {
    const clients = checkMcpToolList(edge, { clients: ["codex"] }).flatMap((d) => d.clients);
    expect(new Set(clients)).toEqual(new Set(["codex"]));
  });
});

test("nameProblems lists every way a name breaks the rules", () => {
  expect(nameProblems("search")).toEqual([]);
  expect(nameProblems("")).toEqual(["is empty"]);
  expect(nameProblems(`${"a".repeat(65)}!`)).toEqual([
    "is 66 characters long",
    "uses characters other than letters, digits, `_`, `-`, and `.`",
  ]);
});

test("annotationsProblem tells a serialized schema from wrong types", () => {
  expect(annotationsProblem({ name: "a", annotations: { title: "A", extra: 1 } })).toBeUndefined();
  expect(
    annotationsProblem({ name: "a", annotations: { type: "object", def: { type: "object" } } }),
  ).toMatchObject({ schema: true, why: expect.stringContaining("(it has `def`)") });
  expect(annotationsProblem({ name: "a", annotations: [] as never })).toMatchObject({
    schema: false,
    why: expect.stringContaining("as an array, not an object"),
  });
});

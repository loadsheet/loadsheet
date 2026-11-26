import { describe, expect, test } from "vite-plus/test";
import {
  checkMcpToolResult,
  mcpClientRules,
  type CheckMcpToolResultOptions,
  type McpToolResult,
} from "../src/index.ts";

const text = (length: number, fields: Partial<McpToolResult> = {}): McpToolResult => ({
  content: [{ type: "text", text: "x".repeat(length) }],
  ...fields,
});

interface Case {
  fail: McpToolResult;
  pass: McpToolResult;
  options?: CheckMcpToolResultOptions;
}

const cases: Record<string, Case> = {
  "claude-code/result-saved-to-file": { fail: text(50_001), pass: text(50_000) },
  "claude-code/error-result-truncated": {
    fail: text(11_025, { isError: true }),
    pass: text(11_024, { isError: true }),
  },
  "claude-code/result-token-warning": { fail: text(40_002), pass: text(40_001) },
  "claude/result-size": { fail: text(150_001), pass: text(150_000) },
  "codex/structured-content-replaces-text": {
    fail: { content: [{ type: "text", text: "Found 2 pages." }], structuredContent: { count: 2 } },
    pass: { content: [{ type: "text", text: '{"count":2}' }], structuredContent: { count: 2 } },
  },
  "vscode/structured-content-replaces-text": {
    fail: { content: [{ type: "text", text: "Found 2 pages." }], structuredContent: { count: 2 } },
    pass: { content: [{ type: "text", text: "Found 2 pages." }] },
  },
  "cursor/structured-content-without-content": {
    fail: { content: [], structuredContent: { count: 2 } },
    pass: { content: [{ type: "text", text: '{"count":2}' }], structuredContent: { count: 2 } },
  },
};

function hits(rule: string, result: unknown, options: CheckMcpToolResultOptions = {}) {
  const client = mcpClientRules.find((candidate) => candidate.rule === rule)!.client;
  return checkMcpToolResult(result, { clients: [client], ...options }).filter(
    (finding) => finding.rule === rule,
  );
}

describe("tools/call result rules", () => {
  test("every result rule has a failing and a passing case", () => {
    const resultRules = mcpClientRules.filter((rule) => rule.scope === "result").map((r) => r.rule);
    expect(Object.keys(cases).sort()).toEqual(resultRules.sort());
  });

  for (const [rule, { fail, pass, options }] of Object.entries(cases)) {
    test(rule, () => {
      const definition = mcpClientRules.find((candidate) => candidate.rule === rule)!;
      const found = hits(rule, fail, options);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        client: definition.client,
        effect: definition.effect,
        severity: definition.severity,
        source: definition.source,
      });
      expect(hits(rule, pass, options)).toEqual([]);
    });
  }
});

describe("Claude Code result limits", () => {
  test("a tool's declared maxResultSizeChars sets the file threshold, up to 500,000", () => {
    const tool = (limit: number) => ({
      name: "export",
      _meta: { "anthropic/maxResultSizeChars": limit },
    });
    expect(
      hits("claude-code/result-saved-to-file", text(100_000), { tool: tool(100_000) }),
    ).toEqual([]);
    const [capped] = hits("claude-code/result-saved-to-file", text(500_001), {
      tool: tool(1_000_000),
    });
    expect(capped?.measured).toEqual({ value: 500_001, limit: 500_000, unit: "characters" });
    expect(capped?.tool).toBe("export");
    const [lower] = hits("claude-code/result-saved-to-file", text(30_000), { tool: tool(20_000) });
    expect(lower?.measured?.limit).toBe(20_000);
    expect(lower?.fix).toContain("raise");
    const [ignored] = hits("claude-code/result-saved-to-file", text(50_001), { tool: tool(0) });
    expect(ignored?.measured?.limit).toBe(50_000);
  });

  test("errors and results with images are not saved to a file", () => {
    expect(hits("claude-code/result-saved-to-file", text(60_000, { isError: true }))).toEqual([]);
    const withImage = {
      content: [
        { type: "text", text: "x".repeat(60_000) },
        { type: "image", data: "", mimeType: "image/png" },
      ],
    };
    expect(hits("claude-code/result-saved-to-file", withImage)).toEqual([]);
  });

  test("a cut error names the marker Claude Code puts in its middle", () => {
    const [finding] = hits("claude-code/error-result-truncated", text(11_025, { isError: true }));
    expect(finding?.message).toContain("`... [1025 characters truncated] ...`");
  });

  test("the token warning estimates a quarter of each text item and 1,600 per image", () => {
    const image = { type: "image", data: "", mimeType: "image/png" };
    const result = (length: number) => ({
      content: [{ type: "text", text: "x".repeat(length) }, image],
    });
    expect(hits("claude-code/result-token-warning", result(33_601))).toEqual([]);
    const [finding] = hits("claude-code/result-token-warning", result(33_602));
    expect(finding?.measured).toEqual({ value: 10_001, limit: 10_000, unit: "tokens" });
  });
});

describe("structured content", () => {
  test("text that is the same JSON in another key order does not count as hidden", () => {
    const result = {
      content: [{ type: "text", text: '{"b":[1,{"c":true}],"a":"x"}' }],
      structuredContent: { a: "x", b: [1, { c: true }] },
    };
    expect(checkMcpToolResult(result)).toEqual([]);
  });

  test("Codex ignores a null structuredContent", () => {
    const result = { content: [{ type: "text", text: "Done." }], structuredContent: null };
    expect(hits("codex/structured-content-replaces-text", result)).toEqual([]);
  });

  test("findings carry the tool name only when the tool is given", () => {
    const [finding] = hits("claude/result-size", text(150_001));
    expect(finding).not.toHaveProperty("tool");
  });

  test("accepts a JSON-RPC response", () => {
    const response = {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [], structuredContent: { a: 1 } },
    };
    expect(hits("cursor/structured-content-without-content", response)).toHaveLength(1);
  });
});

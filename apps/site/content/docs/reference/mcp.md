---
title: MCP servers
description: What loadsheet mcp checks in an MCP server's tools/list, each Diagnostic Code it reports, and its exit codes for CI.
navigation.order: 4
---

A tool that passes the MCP specification can still lose something in a client. Claude Code leaves out a tool whose schema isn't valid draft 2020-12, VS Code omits one that isn't valid draft-07, Copilot Studio drops one with `$ref`, and Codex removes `minimum` and `maxLength` before the model sees the schema. None of this is an error on the server: `tools/list` answers normally, and the tool is missing or different only in that client.

`loadsheet mcp` reads a server's `tools/list` and reports what each client does with it. [loadsheet.dev/mcp](/mcp) runs the same checks on a public server.

```sh
npx loadsheet mcp <url | file> [options]
```

## Read a server

Give it a Streamable HTTP endpoint. loadsheet sends the requests a client sends when it connects, `initialize` and then every page of `tools/list`:

```sh
npx loadsheet mcp http://localhost:3000/mcp
```

Or give it a `tools/list` saved as JSON: a tools array, `{ tools }`, `{ initialize, tools }`, or a JSON-RPC `tools/list` response.

```sh
npx loadsheet mcp tools.json
```

Use the final endpoint URL: loadsheet does not follow redirects. The output names only the endpoint's origin, since a path or query can hold a token.

| Option                   | What it does                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--header "Name: value"` | Send this header with every request, such as `--header "Authorization: Bearer $TOKEN"`. Repeatable. loadsheet never prints its value. |
| `--client <id>`          | Check only this client. Repeatable.                                                                                                   |
| `--max-warnings <n>`     | Also exit `1` when there are more than `<n>` warnings.                                                                                |
| `--json`                 | Print the result as JSON, the same shape `POST /api/mcp` on loadsheet.dev answers.                                                    |
| `-h`, `--help`           | Print the help.                                                                                                                       |

The client ids are `claude-code`, `claude`, `claude-directory`, `chatgpt`, `codex`, `cursor`, `vscode`, `gemini-cli` and `copilot-studio`.

The text output prints each error and warning with its message, its fix and a link to its code below. Info findings, such as client rewrites or confirmation prompts, get one line each. `--json` has every finding in full, with the client findings behind it, the client's source, and a client-by-tool matrix.

## Diagnostic Codes

Severity reflects how serious and certain the reported problem is, not just what a client does. Tool exclusion or request failure can be a `warn` rather than an `error` when the failure is inferred. Use `--max-warnings 0` if you want either severity to fail CI.

### MCP0001

**Tools have no display title.** The tool has no non-empty string in `annotations.title`. Clients show the bare name instead. A top-level `title` isn't enough: Claude Code's transcript ignores it, and clients on the 2025-03-26 revision know only `annotations.title`. Anthropic's Connectors Directory review asks every tool for a title and flags tools without one. Add `title` to the tool's annotations.

### MCP0002

**Tools don't say whether they only read.** The Connectors Directory expects `readOnlyHint: true` for tools that only read or `destructiveHint: true` for tools that change or delete data. It warns if neither is `true`, including when both are `false`. ChatGPT separately asks users who select “Allow read-only tools” to confirm calls to tools without a boolean `readOnlyHint`. If the tool already declares `destructiveHint: true`, that prompt is expected. The ChatGPT finding alone is informational.

### MCP0003

**Tool names that clients reject.** The name is longer than 64 characters, or holds a character other than letters, digits, `_`, `-` and `.`. The Connectors Directory rejects it. Rename the tool.

### MCP0005

**Clients leave tools out.** A client leaves the tool or the whole server out, or the request fails, such as Claude Code with a schema that isn't valid draft 2020-12, or VS Code with one that isn't valid draft-07. This is the only code that is an `error`.

### MCP0006

**Clients cut long text.** A client cuts a description, the server's instructions, or the schema to a length limit. The message gives the measured length and the limit.

### MCP0007

**Clients rewrite names or schemas.** A client renames the tool, replaces an empty description, reads an `enum` as a string, or flattens the schema's root.

### MCP0008

**Clients drop schema rules.** A client drops a constraint a model can get wrong that no description states, shrinks a large schema, or deletes a root combinator. State the constraint in the property's description, or keep the schema small enough.

### MCP0009

**Clients shorten the server's instructions.** A client shows the model less of the server: no instructions under tool search, or fewer tools than the server sends.

### MCP0010

**Annotations aren't valid.** The tool's `annotations` are not an object, set `title` to something other than a string, set `readOnlyHint`, `destructiveHint`, `idempotentHint` or `openWorldHint` to something other than a boolean, or hold a serialized Zod schema (`_def`, `~standard`, `_zod`). The MCP TypeScript SDK's client rejects the whole `tools/list` response in the first two cases, which loses every tool on that page. A serialized schema is usually one passed where `server.tool()` expects annotations, and the tool then ships with an empty input schema. When MCP0010 reports a tool, MCP0001 and MCP0002 don't report its missing title and hints too.

MCP0004, indented JSON in tool output, needs the server's source, so `loadsheet mcp` doesn't report it.

## Exit codes

| Code | Meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | No `error` diagnostics, and the warning count is within any `--max-warnings` limit.            |
| `1`  | At least one `error` diagnostic, or more warnings than `--max-warnings` allows.                |
| `2`  | A bad flag, a file that can't be read, or a file that isn't a `tools/list`.                    |
| `3`  | loadsheet can't read the server: the connection fails, it answers 401, or it returns an error. |

`info` never affects the exit code. Without `--max-warnings`, warnings alone don't fail a run.

## Run in CI

Start the server in the background, wait until it answers, then check it:

```yaml [.github/workflows/checks.yml]
- run: pnpm install --frozen-lockfile
- name: Check the MCP server
  run: |
    nohup pnpm dev --port 3000 > dev.log 2>&1 &
    for i in $(seq 1 60); do curl -sf -o /dev/null http://localhost:3000/ && break; sleep 1; done
    npx loadsheet mcp http://localhost:3000/mcp --max-warnings 0
```

To check a deployed server, pass its token from a secret:

```yaml [.github/workflows/checks.yml]
- name: Check the staging MCP server
  run: npx loadsheet mcp https://staging.example.com/mcp --header "Authorization: Bearer $MCP_TOKEN" --max-warnings 0
  env:
    MCP_TOKEN: ${{ secrets.MCP_TOKEN }}
```

## Check tools in your own tests

The checks come from `@loadsheet/mcp`, so an end-to-end test can run them on what the server returns, including each `tools/call` result, which `loadsheet mcp` never calls. `checkMcpToolList` returns the diagnostics above. `checkMcpClientLimits` and `checkMcpToolResult` return the client findings, each with the client, the rule, a message, a fix and its source:

```ts [tests/e2e/mcp.spec.ts]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkMcpClientLimits, checkMcpToolResult } from "@loadsheet/mcp";
import { expect, test } from "vitest";
import { sampleArguments } from "./mcp-arguments";

test("every client gets every tool intact", async () => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp")));
  let page = await client.listTools();
  const tools = [...page.tools];
  while (page.nextCursor !== undefined) {
    page = await client.listTools({ cursor: page.nextCursor });
    tools.push(...page.tools);
  }
  const lost = (finding: { severity: string }) => finding.severity !== "info";

  expect(checkMcpClientLimits({ tools }, { serverName: "portal" }).filter(lost)).toEqual([]);
  for (const tool of tools) {
    const result = await client.callTool({
      name: tool.name,
      arguments: sampleArguments[tool.name],
    });
    expect(checkMcpToolResult(result, { tool }).filter(lost)).toEqual([]);
  }
});
```

Pass `clients: ["claude-code", "vscode"]` to check only the clients you support, and `codes` to `checkMcpToolList` to report only some codes. `mcpReport` returns what `loadsheet mcp --json` prints, without `source` and `endpoint`.

## What each client is checked for

| Client                           | What is checked                                                                                                                                                                              | Source                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                      | Full name length, top-level property names, draft 2020-12 schema, root combinators, description and instruction length, missing instructions; result size, error length and estimated tokens | [Claude Code MCP docs](https://code.claude.com/docs/en/mcp), [Claude Code 2.1.332](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.332), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/3b73021a0a2272c0c04c3917bcdb03398b3ec63f/src/types.ts#L1389-L1393) |
| Claude                           | Result size                                                                                                                                                                                  | [Connector building docs](https://claude.com/docs/connectors/building#design-within-the-size-and-timeout-limits)                                                                                                                                                                                           |
| Anthropic's Connectors Directory | Name length, `annotations.title`, safety hints (reported as MCP0001 to MCP0003)                                                                                                              | [Review criteria](https://claude.com/docs/connectors/building/review-criteria), [submission checklist](https://claude.com/docs/connectors/building/submission#pre-submission-checklist-for-connectors)                                                                                                     |
| ChatGPT                          | `readOnlyHint` on a tool not marked destructive, which users who allow only read-only tools must confirm (evidence on MCP0002)                                                               | [Custom MCP server docs](https://developers.openai.com/api/docs/guides/developer-mode)                                                                                                                                                                                                                     |
| Codex                            | Name characters and length, dropped constraints, schema size; `structuredContent` in results                                                                                                 | [openai/codex source](https://github.com/openai/codex/tree/ebd0765aafa255d63ebf690ebdffe0164dc14a0c/codex-rs), [Codex 0.172.0](https://github.com/openai/codex/tree/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs)                                                                                     |
| Cursor                           | Name length; results with only `structuredContent`                                                                                                                                           | [Cursor forum](https://forum.cursor.com/t/posthog-mcp-tool-names-too-long/155408/6)                                                                                                                                                                                                                        |
| VS Code                          | Draft-07 schema, arrays without `items`, root combinators, descriptions, tool count, names, gpt-4\* description length and constraints; `structuredContent` in results                       | [microsoft/vscode source](https://github.com/microsoft/vscode/tree/24bc9d5278687dbdd90e8013b93e1daac453ae2b)                                                                                                                                                                                               |
| Gemini CLI                       | Name characters and length                                                                                                                                                                   | [google-gemini/gemini-cli source](https://github.com/google-gemini/gemini-cli/blob/08e9a20f749aefcbda38622ac757899c3d6216e0/packages/core/src/tools/mcp-tool.ts)                                                                                                                                           |
| Copilot Studio                   | `$ref`, numeric `exclusiveMinimum`, type arrays, `enum`                                                                                                                                      | [Copilot Studio MCP troubleshooting](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-troubleshooting#known-issues-and-workarounds)                                                                                                                                                          |

Each finding in `--json` cites its client's source by URL with the date it was checked.

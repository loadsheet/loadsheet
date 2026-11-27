# @loadsheet/mcp

Checks an MCP server's `tools/list` against what each MCP client does with it: names a client renames or drops, schemas it rejects or rewrites, missing annotations, and results it truncates. Runs in Node, the browser and a Cloudflare Worker.

```ts
import { checkMcpToolList, fetchMcpToolList } from "@loadsheet/mcp";

const list = await fetchMcpToolList("https://mcp.example.com/mcp");
for (const d of checkMcpToolList(list)) console.log(d.code, d.severity, d.message);
```

It powers [loadsheet.dev/mcp](https://loadsheet.dev/mcp) and `npx loadsheet mcp <url>`. `mcpReport(list)` returns what both print: the diagnostics with a client-by-tool matrix. Each Diagnostic Code is documented at [loadsheet.dev/docs/reference/mcp](https://loadsheet.dev/docs/reference/mcp), and `mcpDocsUrl(code)` gives its anchor.

Part of [loadsheet](https://github.com/loadsheet/loadsheet). MIT licensed.

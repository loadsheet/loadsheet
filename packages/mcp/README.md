# @loadsheet/mcp

Checks an MCP server's `tools/list` against what each MCP client does with it: names a client renames or drops, schemas it rejects or rewrites, missing annotations, and results it truncates. Runs in Node, the browser and a Cloudflare Worker.

```ts
import { checkMcpToolList, fetchMcpToolList } from "@loadsheet/mcp";

const list = await fetchMcpToolList("https://mcp.example.com/mcp");
for (const d of checkMcpToolList(list)) console.log(d.code, d.severity, d.message);
```

It powers [loadsheet.dev/mcp](https://loadsheet.dev/mcp) and the MCP Rule Pack in [vite-doctor](https://github.com/loadsheet/vite-doctor). Each diagnostic's code is documented at `https://vite-doctor.onmax.me/diagnostics/<code>`.

Part of [loadsheet](https://github.com/loadsheet/loadsheet). MIT licensed.

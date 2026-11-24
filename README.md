# loadsheet

Inspect, weigh and diagnose your coding agents' context: skills, `AGENTS.md`/`CLAUDE.md`, MCP servers and subagents, across every harness and every machine.

loadsheet reads session transcripts locally, tells you what each piece of context costs and whether it gets used, and hands your agent the exact commands to fix it. It never edits anything itself.

Plan: https://drop.vitehub.dev/d/hv062ma8d98s/loadsheet-v001

## Development

Node 24 and pnpm. `pnpm install`, then `pnpm build` builds every package and `pnpm check` runs format, lint and typecheck. `pnpm test` runs the tests against the built CLI. [`AGENTS.md`](AGENTS.md) describes the package layers.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.svg">
    <img src=".github/banner-light.svg" alt="loadsheet. Find the dead weight in your agent’s context." width="100%">
  </picture>
</p>

[![release](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=loadsheet&label=release&icon=npm)](https://www.npmjs.com/package/loadsheet)
[![license: MIT](https://comark-ui.onmax.me/badge.svg?label=license&value=MIT)](./LICENSE)
[![site](https://comark-ui.onmax.me/badge.svg?label=site&value=loadsheet.dev)](https://loadsheet.dev)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=loadsheet&icon=npm)](https://www.npmjs.com/package/loadsheet)

Inspect, weigh and diagnose your coding agents' context: skills, `AGENTS.md`/`CLAUDE.md`, MCP servers and subagents, across every harness and every machine.

loadsheet reads session transcripts locally, tells you what each piece of context costs and whether it gets used, and hands your agent the exact commands to fix it. It never edits anything itself.

## Usage

```sh
npx loadsheet          # report for this machine
npx loadsheet --ui     # the same report as a web page on 127.0.0.1
npx loadsheet --json   # the Report as JSON
```

To have your agent apply the fixes you accept, paste it the prompt in [`docs/agent-prompt.md`](docs/agent-prompt.md).

## Development

Node 24 and pnpm. `pnpm install`, then `pnpm build` builds every package and `pnpm check` runs format, lint and typecheck. `pnpm test` runs the tests against the built CLI. [`AGENTS.md`](AGENTS.md) describes the package layers.

---
title: What loadsheet measures
description: loadsheet reports which skills, instruction files and MCP servers cost your coding agents context without being used.
---

loadsheet inspects, weighs and diagnoses your coding agents' context: skills, `AGENTS.md` and `CLAUDE.md` files, MCP servers and subagents, across every harness and every machine you use.

## How it works

loadsheet reads your agents' session transcripts on your own machine. For each piece of context it tells you how many tokens it costs before you type anything and whether your agent used it in the sessions it read. It never edits your files: it hands your agent the exact commands to fix what you accept.

## First run

```sh
npx loadsheet          # report for this machine
npx loadsheet --ui     # the same report as a web page on 127.0.0.1
npx loadsheet --json   # the Report as JSON
```

The Report the CLI writes follows the JSON Schema at [loadsheet.dev/schema/v1.json](https://loadsheet.dev/schema/v1.json). Transcript text, tool input and output and skill bodies stay on your machine; a Report you share through loadsheet.dev drops each skill's description too.

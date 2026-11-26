---
title: What loadsheet measures
description: loadsheet reports which skills, instruction files and MCP servers cost your coding agents context without being used.
---

Every session of a coding agent starts with text you never typed. The harness lists each installed skill with its description, loads `AGENTS.md` and `CLAUDE.md`, and describes the tools of each MCP server. All of it counts against the model's context window before your first message.

loadsheet reads your agents' session transcripts on your own machine and answers two questions for each piece of that context:

- How many tokens does it add to every session?
- Did the agent use it in the sessions it read?

It then lists what to cut or fix, with the exact change for each. It never edits your files. Your agent applies the fixes you accept.

## What it reads

| Item              | What loadsheet reports                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Skills            | Tokens of the listing entry, sessions that listed it, times the model or you invoked it          |
| Instruction files | Tokens of each `AGENTS.md`, `CLAUDE.md` or memory file, and the share of sessions that loaded it |
| MCP servers       | Tokens of their tool list, and how often a session called them                                   |
| Subagents         | Tokens of their listing entry, and how often they ran                                            |

It reads Claude Code, Codex, Grok, Pi, OpenCode, Cursor, Gemini and Kiro. Each harness writes different transcripts, so each report says what it could see for each harness. See [Read the report](/docs/guide/reading).

## Start

```sh
npx loadsheet
```

[Install and first run](/docs/guide) has the rest. To weigh a skill pack before you install it, see [Weigh a skill pack](/docs/guide/packs). To see whether an MCP server's tools work in Claude, ChatGPT, Cursor and other clients, paste its URL into [the MCP check](/mcp).

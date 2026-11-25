---
title: Read the report
description: What each part of loadsheet's text report means, from the session budget to the findings.
navigation.order: 1
---

`npx loadsheet` prints the report in five parts. `npx loadsheet --json` prints the same numbers as a [Report](/docs/reference/schemas).

## The machine

```txt
loadsheet@0.1.0: local report, 2026-10-27 to 2026-11-25 (30 days)
Machine: laptop
  claude-code  2,535 sessions  each starts with ~60,438 of ~200,000 tokens (measured)
                               your setup ~16,518, the harness's own ~43,920
```

For each harness: how many sessions it read, and how many tokens a session holds before you type. "Your setup" is the part loadsheet can trace to your skills, instruction files and MCP servers. "The harness's own" is the rest: its system prompt and built-in tools. `(measured)` means the harness logged the number. A harness that logs none shows your setup only.

## The sheets

One sheet per harness, with its 10 heaviest lines:

```txt
claude-code: 248 lines, your setup ~16,518 tokens; the 10 heaviest
  tokens    in    uses  item
   1,861  100%       -  instructions:CLAUDE.md
     580   99%  21,707  mcp:github
     334   97%       7  skill:pdf
```

| Column   | Meaning                                                                                  |
| -------- | ---------------------------------------------------------------------------------------- |
| `tokens` | What the line adds to every session it is in.                                            |
| `in`     | Share of the harness's sessions that listed or loaded it.                                |
| `uses`   | Times the model or you invoked it. `-` for instruction files, which are always read.     |
| `item`   | The line's id, `kind:name`. The kinds are `skill`, `instructions`, `mcp` and `subagent`. |

A pack report shows `listed` and `body` instead of `in` and `uses`: the characters of the listing entry and of the whole file. A pack has no sessions. See [Weigh a skill pack](/docs/guide/packs).

## What each harness lets loadsheet see

Harnesses log different things. For each harness and each signal, the table says `exact`, `inferred`, or `-` for nothing. `listing` is whether a transcript shows which skills the session listed. `modelUse` and `userUse` are invocations by the model and by you. A rule that needs a signal the harness does not log does not run on it, and the report says so under "Rules not run".

## Findings

Findings come grouped by rule, cut first, then fix, then info:

```txt
dead-skill (cut), 145: listed for weeks and never invoked
  ~180  skill:frontend-design      in 3,863 sessions over 30 days, never invoked
    hide-from-model ~/.claude/settings.json
```

- The level in brackets says how strongly the rule asks for action. `cut` removes context that does nothing. `fix` keeps the item and changes it. `info` is for you to know, with nothing to change.
- `~180` is the tokens each session would save once the finding is fixed.
- The indented lines are the fixes: an action and the file it changes. The JSON Report holds the exact key and value or command for each. [Rules](/docs/reference/rules) lists what each rule checks.

## The summary

The last lines count the findings by rule, with the tokens they would save per session and how many have a fix. loadsheet changes none of your files. To act on the findings, see [Apply fixes with your agent](/docs/guide/fixes).

---
title: Read the report
description: What loadsheet prints, from how much context each harness sends with the first message of a chat to what you can get back.
navigation.order: 1
---

`npx loadsheet` prints a short summary. `npx loadsheet <harness>` breaks one harness down item by item. `npx loadsheet --full` prints every finding and fix in full, and `npx loadsheet --json` prints the same numbers as a [Report](/docs/reference/schemas).

## The first message of a chat

```txt
loadsheet 0.1.3

Learn what you send to Claude Code and Codex with the first message of every chat.

Claude Code  17.3k tokens · 9% context window
████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░ 91% free (182.7k)
■ built-in 5.6k  ■ instructions 6.7k  ■ skills 0.8k (14 skills)  ■ MCP 4.1k
■ agents 0.1k
```

For each harness with chats in the window: how many tokens every chat sends before you type, and what share of the model's context window that is. The bar splits them by part. `built-in` is the harness's own system prompt and built-in tools; the rest is your setup: instruction files, skills, MCP servers and agents. The skill count leaves out skills that cost no tokens. The heaviest harness fills two thirds of its bar and the others are drawn on the same scale, so a lighter harness has a shorter bar; the percentages give the real share.

## Breakdown

```txt
Breakdown                                                 saved per chat
  Claude Code  shorten 1 skill description over 300 chars          −0.1k
               remove 1 skill never used in 30 days                  −53
  Needs your OK data-toolkit plugin: 6 skills never used           −0.3k
```

Each row is one kind of change, with the tokens every chat would save once it is made. A skill that two rules flag is counted once. `Needs your OK` is the biggest change loadsheet has no safe edit for, such as skills that come with a plugin: turning the plugin off also turns off its hooks and commands, so that call is yours. [Rules](/docs/reference/rules) lists what each rule checks.

On a stock install with nothing added, the summary says that skills, MCP servers and instruction files show up once you add them.

The summary ends with the command for each harness's breakdown and for the web page, `npx loadsheet --ui`. loadsheet changes none of your files: when there is something to change, it tells you how to apply it. See [Apply fixes with your agent](/docs/guide/fixes).

## One harness

```txt
skills · 9 listed                     0.4k     uses
  used, heaviest first
  terraform-plan                        57        1
  bench-compare                         47        5

  never used in 30 days, heaviest first
  docx-builder                          49    never   hide
  + 3 more: 3 used, 0 never used   npx loadsheet codex --all
```

`npx loadsheet claude-code`, or `npx loadsheet claude`, lists the harness's instruction files, skills, MCP servers and agents with their tokens and uses. Skills come in two groups, used and never used, the heaviest first; `--all` lists every one. `hide` marks a skill loadsheet has a fix for. Under "Fixes" each change names the file it edits, with the skill's name as `<name>`.

## The full report

`npx loadsheet --full` prints what the summary is built from: each harness's heaviest lines, what each harness lets loadsheet see, every finding grouped by rule with each fix's action, file, key and command, and the rules that did not run. A skill pack's report, `npx loadsheet ./skills`, always prints in full. See [Weigh a skill pack](/docs/guide/packs).

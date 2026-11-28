---
title: Read the report
description: What loadsheet prints, from how much context each harness sends with the first message of a chat to what you can get back.
navigation.order: 1
---

`npx loadsheet` prints a short summary. `npx loadsheet <harness>` breaks one harness down item by item. `npx loadsheet --full` prints every finding and fix in full, and `npx loadsheet --json` prints the same numbers as a [Report](/docs/reference/schemas). `npx loadsheet usage` looks back instead: sessions, compactions and tokens per project.

## The first message of a chat

```txt
loadsheet 0.1.3

Learn what you send to Claude Code and Codex with the first message of every chat.

Claude Code  17.3k tokens · 9% context window
████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░ 91% free (182.7k)
■ built-in 5.6k  ■ instructions 6.7k  ■ skills 0.8k (14 skills)  ■ MCP 4.1k
■ agents 0.1k
```

For each harness with chats in the window: how many tokens every chat sends before you type, and what share of the model's context window that is. The bar splits them by part. `built-in` is the harness's own system prompt and built-in tools; the rest is your setup: instruction files, skills, MCP servers and agents. The skill count leaves out skills that cost no tokens. The heaviest harness fills two thirds of its bar and the others are drawn on the same scale, so a lighter harness has a shorter bar; the percentages give the real share. When no chat reports the built-in cost, the free space is unknown unless your setup already fills the window.

## Breakdown

```txt
Breakdown                                                 saved per chat
  Claude Code  shorten 1 skill description over 300 chars          −0.1k
               remove 1 skill never used in 30 days                  −53
  Needs your OK data-toolkit plugin: 6 skills never used           −0.3k
```

Each row is one kind of change, with the tokens every chat would save once it is made. A skill that two rules flag is counted once. `Needs your OK` is the biggest change loadsheet has no safe edit for, such as skills that come with a plugin: turning the plugin off also turns off its hooks and commands, so that call is yours. [Rules](/docs/reference/rules) lists what each rule checks.

On a stock install with nothing added, the summary says that skills, MCP servers and instruction files show up once you add them.

The summary ends with the command for each harness's breakdown and for the web page, `npx loadsheet --ui`. Fleet reports include `--fleet` in these commands. loadsheet changes none of your files: when it has exact edits, it tells you how to apply them, even if they don't save tokens. See [Apply fixes with your agent](/docs/guide/fixes).

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

## Usage by project

```txt
Sessions, compactions and tokens, 2026-08-03 to 2026-11-21, on 2 machines.

Totals                          sessions     compacted      tokens   share
  Claude Code                         17        3  18%       62.0M     90%
  Codex                                5        1  20%        7.1M     10%
  all                                 22        4  18%       69.1M    100%
  plus 22 subagent sessions, whose tokens are counted above

Orgs                            sessions     compacted      tokens   share
  acme                                19        4  21%       68.6M     99%
  no repository                        3        0   0%      507.4k      1%

Projects                        sessions     compacted      tokens   share
  acme/web                            14        3  21%       61.5M     89%
  acme/api                             5        1  20%        7.1M     10%
  no repository                        3        0   0%      507.4k      1%

Settings
  Claude Code  prompt cache      5 minutes
               subagent cache    Claude Code's default
               transcripts kept  30 days
  Codex        auto-compact      Codex's default limit
```

`npx loadsheet usage` counts the sessions you started, how many compacted their context at least once, and the tokens they used, per harness, per organisation and for the 10 biggest projects. It covers every day your machines still have a record of, not only the last 30, and the first line names the first and last of those days. `--days 90` keeps only the last 90.

Tokens are input, output, cache reads and cache writes, subagents' included; the share is of all of them. Some records keep only a session's total, with no split into input, output and cache; those totals count too.

A harness deletes its own transcripts after a while, but other stores on your machine may still hold those sessions. loadsheet fills in a gone Claude Code session from T3 Code's usage cache, else from T3 Code's database. It fills in a gone Codex thread from T3 Code's usage cache when that has the thread, else from Codex's state database, which keeps one total per thread. Each session counts once: its own transcript wins over T3 Code's usage cache, and that wins over T3 Code's database and Codex's state database. When a store filled in a harness's older days, the harness's last line under Settings names it and what it lacks. A project is its repository, `owner/repo`, from the git remote of the folder the session ran in. Folders that are no repository count under one row. A session counts on the day it started.

Settings shows what loadsheet read from each harness's settings that changes these numbers: how long the prompt cache lives, how long transcripts are kept, and when the harness compacts on its own. When a 1-hour cache followed 5-minute days, it says when the 5-minute writes stopped. Fixes for the [prompt cache rules](/docs/reference/rules#prompt-cache) and for transcripts kept too short follow it.

These counters stay on your machines. See [Privacy](/docs/guide/privacy).

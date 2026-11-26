---
title: Read the report
description: What loadsheet prints, from how much context each harness takes before you type to what you can get back.
navigation.order: 1
---

`npx loadsheet` prints a short summary. `npx loadsheet <harness>` breaks one harness down item by item. `npx loadsheet --full` prints every finding and fix in full, and `npx loadsheet --json` prints the same numbers as a [Report](/docs/reference/schemas).

## Before you type

```txt
loadsheet 0.1.1 · ~/work

Claude Code  ~17.3k of 200k before you type
████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░ 182.7k free
■ harness 5.6k  ■ instructions 6.7k  ■ skills 0.8k  ■ MCP 4.1k  ■ agents 0.1k
```

For each harness with sessions in the window: how many tokens a session holds before you type, of the model's context window. The bar splits them by part. `harness` is the harness's own system prompt and built-in tools; the rest is your setup: instruction files, skills, MCP servers and agents. Every harness is drawn on the same scale, so a lighter harness has a shorter bar.

## You can get back

```txt
You can get back                                      tokens per session
  Claude Code  shorten 1 skill description over 300 chars          −0.1k
               remove 1 skill never used in 30 days                  −53
  Ask first    data-toolkit plugin: 6 skills never used            −0.3k
```

Each row is one kind of change, with the tokens every session would save once it is made. A skill that two rules flag is counted once. `Ask first` is the biggest change loadsheet has no safe edit for, such as skills that come with a plugin: turning the plugin off also turns off its hooks and commands, so that call is yours. [Rules](/docs/reference/rules) lists what each rule checks.

The summary ends with the command for each harness's breakdown. loadsheet changes none of your files: to apply the changes, see [Apply fixes with your agent](/docs/guide/fixes).

## One harness

```txt
skills · 9 listed                     0.4k     uses
  used, heaviest first
  terraform-plan                        57        1
  bench-compare                         47        5

  never used in 30 days, heaviest first
  docx-builder                          49    never   hide
  + 3 more: 3 used, 0 never used   loadsheet codex --all
```

`npx loadsheet claude-code`, or `npx loadsheet claude`, lists the harness's instruction files, skills, MCP servers and agents with their tokens and uses. Skills come in two groups, used and never used, the heaviest first; `--all` lists every one. `hide` marks a skill loadsheet has a fix for. Under "You can get back" each change names the file it edits, with the skill's name as `<name>`.

## The full report

`npx loadsheet --full` prints what the summary is built from: each harness's heaviest lines, what each harness lets loadsheet see, every finding grouped by rule with each fix's action, file, key and command, and the rules that did not run. A skill pack's report, `npx loadsheet ./skills`, always prints in full. See [Weigh a skill pack](/docs/guide/packs).

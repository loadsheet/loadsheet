---
title: Rules
description: The eleven rules loadsheet runs, what each one checks, and the thresholds you can change.
navigation.order: 1
---

Each rule reads the sheets and returns findings. A finding's level says how strongly it asks for action: `cut` removes context that does nothing, `fix` keeps the item and changes it, and `info` changes nothing.

Change a threshold with `--rule <id>.<option>=<n>` or in the [config file](/docs/reference/config). Turn a rule off with `--rule <id>=off`.

| Rule                    | Level | Finds                                                                                                        | Options and defaults             |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `dead-skill`            | cut   | A skill listed for weeks and never invoked, by the model or by you.                                          | `minSessions` 20, `minDays` 14   |
| `dead-pack`             | cut   | A pack none of whose skills is used. One finding covers all its skills.                                      | `minSkills` 5                    |
| `invisible-skill`       | fix   | A skill listed without its description in most sessions, so the model cannot tell when to use it.            | `minSessions` 5, `bareShare` 0.5 |
| `manual-only`           | fix   | A skill the model may invoke, but only you do. Hiding it from the model keeps `/name` and saves its listing. | `minUserUses` 3                  |
| `expensive-description` | fix   | A skill whose listing entry is longer than it needs to be.                                                   | `maxChars` 300                   |
| `duplicate`             | fix   | The same skill installed twice on one machine, from two sources or with two contents.                        | none                             |
| `harness-mismatch`      | fix   | A skill installed only for harnesses you do not use.                                                         | `minSessions` 1                  |
| `drift`                 | fix   | The same skill with different contents on two machines. Fleet reports only.                                  | none                             |
| `heavy-instructions`    | info  | An instruction file longer than it should be. Every session that loads it pays for all of it.                | `maxChars` 12000                 |
| `idle-mcp`              | info  | An MCP server listed and never called.                                                                       | `minSessions` 20                 |
| `short-history`         | info  | Too little history to judge use.                                                                             | `minDays` 30                     |

`minSessions` counts the sessions that listed the item. `minDays` counts days of history. For `harness-mismatch`, a harness with fewer than `minSessions` sessions in the window counts as unused.

## When a rule does not run

A rule needs signals from the transcripts, such as which skills a session listed or which ones the model invoked. When a harness does not log one, the rule skips that harness, and the report lists it under "Rules not run" with the missing signal. A rule also skips a harness with too few sessions to judge.

A [skill pack](/docs/guide/packs) has no sessions, so only `expensive-description`, `duplicate` and `heavy-instructions` run on it.

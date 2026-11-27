---
title: Rules
description: The thirteen rules loadsheet runs, what each one checks, and the thresholds you can change.
navigation.order: 1
---

Each rule reads the sheets and returns findings. A finding's level says how strongly it asks for action: `cut` removes context that does nothing, `fix` keeps the item and changes it, and `info` changes nothing.

Change a threshold with `--rule <id>.<option>=<n>` or in the [config file](/docs/reference/config). Turn a rule off with `--rule <id>=off`.

| Rule                    | Level | Finds                                                                                                                  | Options and defaults             |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `dead-skill`            | cut   | A skill listed for weeks and never invoked, by the model or by you.                                                    | `minSessions` 20, `minDays` 14   |
| `dead-pack`             | cut   | A pack none of whose skills is used. One finding covers all its skills.                                                | `minSkills` 5                    |
| `invisible-skill`       | fix   | A skill listed without its description in most sessions, so the model cannot tell when to use it.                      | `minSessions` 5, `bareShare` 0.5 |
| `manual-only`           | fix   | A skill the model may invoke, but only you do. Hiding it from the model keeps `/name` and saves its listing.           | `minUserUses` 3                  |
| `expensive-description` | fix   | A skill whose listing entry is longer than it needs to be.                                                             | `maxChars` 300                   |
| `duplicate`             | fix   | The same skill installed twice on one machine, from two sources or with two contents.                                  | none                             |
| `harness-mismatch`      | fix   | A skill installed only for harnesses you do not use.                                                                   | `minSessions` 1                  |
| `drift`                 | fix   | The same skill with different contents on two machines. Fleet reports only.                                            | none                             |
| `heavy-instructions`    | info  | An instruction file longer than it should be. Every session that loads it pays for all of it.                          | `maxChars` 12000                 |
| `idle-mcp`              | info  | An MCP server listed and never called.                                                                                 | `minSessions` 20                 |
| `short-history`         | info  | Too little history to judge use, or Claude Code's `cleanupPeriodDays` deletes what the window needs. Its fix sets 365. | `minDays` 30                     |
| `cache-ttl`             | fix   | Claude Code kept its prompt cache 5 minutes on the last 3 days with 1M cache writes, per entrypoint.                   | none                             |
| `cache-off`             | fix   | No request read the prompt cache, over at least 10 sessions and 1M tokens sent.                                        | none                             |

`minSessions` counts the sessions that listed the item. `minDays` counts days of history. For `harness-mismatch`, a harness with fewer than `minSessions` sessions in the window counts as unused.

## Prompt cache

Claude Code writes each request's prompt to a cache that lives 5 minutes or 1 hour. After a longer pause, the next request writes the whole prompt again. `cache-ttl` reads the main conversations' cache writes per UTC day and judges the last 3 days with at least 1M of them. A day is a 5-minute day when 5-minute writes are half or more. When all 3 are, the finding counts the tokens written again after a pause of 5 to 60 minutes on those days, and its fix sets `promptCacheTtl` to `"1h"` in `~/.claude/settings.json`. When `FORCE_PROMPT_CACHING_5M` set the lifetime, the fix turns it off in the file's `env`. When the settings already ask for 1 hour, Claude Code wrote the 5-minute caches itself ([anthropics/claude-code#101685](https://github.com/anthropics/claude-code/issues/101685)) and there is nothing to set. See Claude Code's [cache lifetime](https://code.claude.com/docs/en/prompt-caching#cache-lifetime) docs.

`cache-off` fires when a machine's sessions sent tokens and never read the cache. When a `DISABLE_PROMPT_CACHING` variable turned caching off, the fix sets it to `"0"` in the settings' `env`. Otherwise a gateway or proxy may drop the cache, and there is no setting to change.

## When a rule does not run

A rule needs signals from the transcripts, such as which skills a session listed or which ones the model invoked. When a harness does not log one, the rule skips that harness, and the report lists it under "Rules not run" with the missing signal. A rule also skips a harness with too few sessions to judge.

A [skill pack](/docs/guide/packs) has no sessions, so only `expensive-description`, `duplicate` and `heavy-instructions` run on it.

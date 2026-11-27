---
title: Rules
description: The thirteen rules loadsheet runs, what each one checks, and the thresholds you can change.
navigation.order: 1
---

Each rule reads the sheets and returns findings. A finding's level says how strongly it asks for action: `cut` removes context that does nothing, `fix` keeps the item and changes it, and `info` changes nothing.

Change a threshold with `--rule <id>.<option>=<n>` or in the [config file](/docs/reference/config). Turn a rule off with `--rule <id>=off`.

| Rule                    | Level | Finds                                                                                                                                     | Options and defaults             |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `dead-skill`            | cut   | A skill listed for weeks and never invoked, by the model or by you.                                                                       | `minSessions` 20, `minDays` 14   |
| `dead-pack`             | cut   | A pack none of whose skills is used. One finding covers all its skills.                                                                   | `minSkills` 5                    |
| `invisible-skill`       | fix   | A skill listed without its description in most sessions, so the model cannot tell when to use it.                                         | `minSessions` 5, `bareShare` 0.5 |
| `manual-only`           | fix   | A skill the model may invoke, but only you do. Hiding it from the model keeps `/name` and saves its listing.                              | `minUserUses` 3                  |
| `expensive-description` | fix   | A skill whose listing entry is longer than it needs to be.                                                                                | `maxChars` 300                   |
| `duplicate`             | fix   | The same skill installed twice on one machine, from two sources or with two contents.                                                     | none                             |
| `harness-mismatch`      | fix   | A skill installed only for harnesses you do not use.                                                                                      | `minSessions` 1                  |
| `drift`                 | fix   | The same skill with different contents on two machines. Fleet reports only.                                                               | none                             |
| `heavy-instructions`    | info  | An instruction file longer than it should be. Every session that loads it pays for all of it.                                             | `maxChars` 12000                 |
| `idle-mcp`              | info  | An MCP server listed and never called.                                                                                                    | `minSessions` 20                 |
| `short-history`         | info  | Too little history to judge use. It becomes a fix when Claude Code's `cleanupPeriodDays` deletes what the window needs: the fix sets 365. | `minDays` 30                     |
| `cache-ttl`             | fix   | Claude Code kept its prompt cache 5 minutes on the last 3 days with 1M cache writes, per entrypoint.                                      | none                             |
| `cache-off`             | fix   | No request read the prompt cache, over at least 10 sessions and 1M tokens sent.                                                           | none                             |

`minSessions` counts the sessions that listed the item. `minDays` counts days of history. For `harness-mismatch`, a harness with fewer than `minSessions` sessions in the window counts as unused.

## Prompt cache

Claude Code writes prompts to a cache that lives 5 minutes or 1 hour. `cache-ttl` reads main conversations' cache writes per UTC day and judges the last 3 days with at least 1M of them. When 5-minute writes make up at least half on all three days, the finding estimates potential reuse from 5-minute writes following a 5-to-60-minute pause between requests to the same model. This does not prove a cache hit or cost savings. When there is a reuse opportunity, the rule can suggest setting `promptCacheTtl` to `"1h"` in the active Claude Code `settings.json`, provided the scanner can safely name it. When `FORCE_PROMPT_CACHING_5M` set the lifetime, the fix also turns it off in the file's `env`. If the settings already ask for 1 hour, there is nothing to set. See Claude Code's [cache lifetime](https://code.claude.com/docs/en/prompt-caching#cache-lifetime) docs.

`cache-off` fires when a machine has at least 10 main sessions and 1M input and cache-write tokens, and no request read the cache. When a `DISABLE_PROMPT_CACHING` variable turned caching off, the fix sets it to `"0"` in the settings' `env`. Otherwise a gateway or proxy may drop the cache, and there is no setting to change.

## When a rule does not run

A rule needs signals from the transcripts, such as which skills a session listed or which ones the model invoked. When a harness does not log one, the rule skips that harness, and the report lists it under "Rules not run" with the missing signal. A rule also skips a harness with too few sessions to judge.

A [skill pack](/docs/guide/packs) has no sessions, so only `expensive-description`, `duplicate` and `heavy-instructions` run on it.

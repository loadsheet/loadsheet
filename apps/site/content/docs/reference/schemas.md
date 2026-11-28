---
title: Report and Scan
description: The two JSON documents loadsheet prints, and their JSON Schemas at loadsheet.dev/schema.
navigation.order: 3
---

loadsheet prints two JSON documents. Each one has a JSON Schema at the URL its `$id` names:

| Document | Printed by             | Schema                                                                         |
| -------- | ---------------------- | ------------------------------------------------------------------------------ |
| Report   | `npx loadsheet --json` | [loadsheet.dev/schema/v1.json](https://loadsheet.dev/schema/v1.json)           |
| Scan     | `npx loadsheet --scan` | [loadsheet.dev/schema/scan.v1.json](https://loadsheet.dev/schema/scan.v1.json) |

```sh
curl -s https://loadsheet.dev/schema/v1.json | jq -r '."$id"'
```

```txt
https://loadsheet.dev/schema/v1.json
```

Both carry `schema: 1`. A finding's `rule` may be the id of a rule a newer loadsheet added, so a reader should skip rule ids it does not know.

## Report

What loadsheet found: one sheet per harness and the findings.

```sh
npx loadsheet https://github.com/mattpocock/skills --json | jq -r .mode
```

```txt
pack
```

| Field         | What it holds                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`      | `1`.                                                                                                                                     |
| `tool`        | The tool and version that wrote it, such as `loadsheet@0.1.0`.                                                                           |
| `generatedAt` | When it was made, as an ISO 8601 timestamp.                                                                                              |
| `mode`        | `local` for this machine, `fleet` for several, `pack` for a skill pack with no usage.                                                    |
| `source`      | In pack mode, the folder name or GitHub URL it read.                                                                                     |
| `machines`    | The machines read, with `reachable` and, for one that failed, `error`. Empty in pack mode.                                               |
| `window`      | The first and last day it covers, inclusive.                                                                                             |
| `config`      | The config it ran with, every default filled in.                                                                                         |
| `coverage`    | What each harness on each machine could tell: `exact`, `inferred` or nothing, per signal.                                                |
| `sheet`       | One sheet per harness: its `sessions`, `fixedTokens` for the tokens a session starts with, the model's `contextWindow`, and its `lines`. |
| `findings`    | What the rules found.                                                                                                                    |
| `skipped`     | The rules that did not run on a harness, and why.                                                                                        |
| `usage`       | Sessions, compactions and tokens per project, summed over machines. Absent when no machine reports any, and from a shared Report.        |

Each line of a sheet has its `item` id, its size in `chars`, its `tokens`, the sessions that listed it in `exposure`, invocations by the model and by you in `use`, and for a skill or subagent its `description`.

Each finding has its `rule`, its `level`, the `item` or `pack` it is about, the `evidence` numbers the rule judged, `savesTokens`, and its `fixes`. A fix has an `action`, the `path` it changes, the `machine` it is for, and a `run` command or a `set` key and value. [Apply fixes with your agent](/docs/guide/fixes) explains each action.

## Scan

What one machine sends with `--fleet`: its items and usage counters, before any rule runs. A Scan holds every session in the window. `--harness`, `--ignore`, `--via`, `--exclude-via` and `--rule` shape the Report built from it, not the Scan.

```sh
npx loadsheet --scan | jq -r .schema
```

```txt
1
```

| Field       | What it holds                                  |
| ----------- | ---------------------------------------------- |
| `schema`    | `1`.                                           |
| `tool`      | The tool and version that wrote it.            |
| `machine`   | The machine's name.                            |
| `scannedAt` | When it was scanned, as an ISO 8601 timestamp. |
| `window`    | The first and last day it covers, inclusive.   |
| `coverage`  | What each harness on this machine could tell.  |
| `items`     | The installed pieces of context.               |
| `sessions`  | Session totals.                                |
| `cells`     | Usage counters.                                |
| `usage`     | Sessions, compactions and tokens per project.  |

## Coverage

Each `coverage` entry is one harness on one machine: whether it is `installed`, its `sessions`, the first and last day, its `versions`, how it grades each signal, and the model's `contextWindow`. Two fields come from its settings and stores:

- `settings` holds what the harness's settings and environment set, as derived values, never their text: `cacheTtl` and `subagentCacheTtl` (`5m` or `1h`) with `cacheTtlFrom`, the knob that set it, such as `settings.promptCacheTtl`; `caching` (`on` or `off`) with `cachingFrom`; `retentionDays`, how long transcripts are kept; `docMaxBytes`, the most of an instruction file the harness reads; `autoCompact` and `autoCompactWindow`.
- `unread` names the session stores that exist and could not be read, such as `opencode.db`. Without it, every store was read.

## Usage

`usage` holds two lists of counters. Each counter is keyed by `day` (UTC), `harness`, `via` (the entrypoint), `project` and `thread` (`main`, or `subagent` for a subagent's own conversation).

| List       | Counters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions` | `sessions` started that day, how many of them `compacted` at least once, their `compactions`, and of those the `manualCompactions` you asked for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tokens`   | Also keyed by `model`. `requests`, then `input` (sent without the cache), `output` (`reasoning` is part of it), `cacheRead` and `cacheWrite`. Of the writes, `cacheWrite5m` and `cacheWrite1h` went to a cache that lives 5 minutes or 1 hour. `cacheRewrite` counts 5-minute writes 5 to 60 minutes after a request to the same model in the conversation: potential reuse with a longer cache, not guaranteed hits. `unsplit`, when present, counts tokens a source keeps as one total with no split, such as a thread's whole count; they are in no other counter, totals include them, and the cache's figures leave them out. |

A session counts on the day it started, a request on the day it was made. `project` is `owner/repo` when the folder's git remote or the transcript names one, else the folder as `~/...` under your home or an absolute path elsewhere, or `unknown`. Totals are the sum of the cells; there is no record per session.

[Privacy](/docs/guide/privacy) lists what a Report and a Scan leave out.

---
title: Config file
description: Set loadsheet's defaults in config.json, which follows the JSON Schema at loadsheet.dev/schema/config.v1.json.
navigation.order: 2
---

loadsheet reads `~/.config/loadsheet/config.json`, or `$XDG_CONFIG_HOME/loadsheet/config.json` when that is set. `--config <path>` reads another file. Without a file, loadsheet uses its defaults. Every field is optional.

```json [~/.config/loadsheet/config.json]
{
  "$schema": "https://loadsheet.dev/schema/config.v1.json",
  "window": 14,
  "harnesses": ["claude-code", "codex"],
  "via": { "exclude": ["sdk-ts"] },
  "ignore": ["skill:pdf", "mcp:github"],
  "rules": {
    "dead-skill": { "minSessions": 40 },
    "idle-mcp": false
  }
}
```

| Field         | What it sets                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `window`      | Days of history to read. Default 30.                                                                     |
| `harnesses`   | Read only these harness ids.                                                                             |
| `via.include` | Read only sessions started from these entrypoints.                                                       |
| `via.exclude` | Skip sessions started from these entrypoints.                                                            |
| `ignore`      | Item ids never reported, as `kind:name`. The kinds are `skill`, `instructions`, `mcp` and `subagent`.    |
| `rules`       | Per rule, `false` turns it off and an object changes its thresholds. See [Rules](/docs/reference/rules). |

`window` bounds the sheets and the rules, not usage history: `loadsheet usage` counts every day your machines have a record of, unless you pass it `--days`, which the Report records as `config.usageWindow`.

Flags override the file: `--days` replaces `window`, `--harness` replaces `harnesses`, and `--rule` replaces a rule's setting. `--ignore` adds to `ignore`.

A file that is not valid JSON or does not match the schema stops loadsheet with exit code 2 and a message that names the field.

## The schema

The schema is at [loadsheet.dev/schema/config.v1.json](https://loadsheet.dev/schema/config.v1.json). With `$schema` set, editors such as VS Code check the file and complete its fields as you type.

```sh
curl -s https://loadsheet.dev/schema/config.v1.json | jq -r '."$id"'
```

```txt
https://loadsheet.dev/schema/config.v1.json
```

The Report keeps the config it ran with, every default filled in, under `config`.

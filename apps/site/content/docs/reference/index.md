---
title: Command line
description: Every command, option, exit code and environment variable of the loadsheet CLI.
navigation.title: Command line
---

```sh
npx loadsheet [options]                         # report this machine
npx loadsheet <folder | GitHub URL> [options]   # weigh a skill pack
npx loadsheet --ui [--port <n>] [options]       # serve the report on 127.0.0.1
npx loadsheet build [--out <folder>] [options]  # write the report as a web page
npx loadsheet fleet [command] [options]         # run fleetrc
```

`npx loadsheet --help` prints the same list.

## Options

| Option                     | What it does                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--days <n>`               | Days of history to read. Default 30.                                                                       |
| `--harness <id>`           | Report only this harness. Repeat it for more. A pack is weighed for one harness, `claude-code` by default. |
| `--ignore <kind:name>`     | Leave an item out of the findings, such as `--ignore skill:pdf`. Repeatable.                               |
| `--rule <id>=off`          | Turn a rule off, or `=on` to turn it back on. Repeatable.                                                  |
| `--rule <id>.<option>=<n>` | Set a rule's threshold, such as `--rule dead-skill.minSessions=40`. Repeatable.                            |
| `--via <name>`             | Read only sessions started from this entrypoint. Repeatable.                                               |
| `--exclude-via <name>`     | Skip sessions started from this entrypoint. Repeatable.                                                    |
| `--config <path>`          | Read this [config file](/docs/reference/config) instead of the default one.                                |
| `--no-cache`               | Read every transcript in full and write no cache.                                                          |
| `--json`                   | Print the [Report](/docs/reference/schemas) as JSON.                                                       |
| `--fleet`                  | Also read every other machine of your fleet over ssh. See [Several machines](/docs/guide/fleet).           |
| `--timeout <seconds>`      | With `--fleet`, how long to wait for each machine. Default 300.                                            |
| `--scan`                   | Print this machine's [Scan](/docs/reference/schemas#scan) as JSON.                                         |
| `--port <n>`               | With `--ui`, the port to serve on.                                                                         |
| `--out <folder>`           | With `build`, the folder to write. Default `./loadsheet-report`.                                           |
| `-v`, `--version`          | Print the version.                                                                                         |
| `-h`, `--help`             | Print the help.                                                                                            |

The harness ids are `claude-code`, `codex`, `grok`, `pi`, `opencode`, `cursor`, `gemini` and `kiro`.

Flags override the config file. `--ignore` adds to the file's list; every other flag replaces the file's value.

## Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | It printed a report, whatever it found.                                                      |
| `1`  | It could not read this machine, or could not serve or write the page.                        |
| `2`  | A bad flag, a bad config file, or a `build` folder that holds files loadsheet did not write. |

## Environment

| Variable                  | Use                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `XDG_CONFIG_HOME`         | The config file is `$XDG_CONFIG_HOME/loadsheet/config.json`, else `~/.config/loadsheet/config.json`. |
| `XDG_CACHE_HOME`          | The cache is `$XDG_CACHE_HOME/loadsheet`, else `~/.cache/loadsheet`.                                 |
| `LOADSHEET_FLEET_COMMAND` | With `--fleet`, the command each other machine runs in place of `npx -y loadsheet@<version>`.        |

---
title: Install and first run
description: Run loadsheet with npx, wait for the first scan, and read the report for this machine.
navigation.title: Install and first run
---

loadsheet needs Node.js 22.12 or later. Run it with `npx`, so there is nothing to install:

```sh
npx loadsheet
```

It reads the session transcripts of every harness it knows on this machine, from the last 30 days, and prints a report. A first run reads every transcript and can take a few minutes. When a scan takes longer than 2 seconds, it prints its progress on stderr, such as `Reading Claude Code sessions: 1,200 of 6,090 files`.

Later runs read only what was added to each transcript since the last run. loadsheet keeps that cache in `~/.cache/loadsheet`, or `$XDG_CACHE_HOME/loadsheet` when that is set. `--no-cache` reads everything again and writes no cache.

## Pick what it reads

```sh
npx loadsheet claude                 # Claude Code, item by item
npx loadsheet --days 7               # only the last 7 days
npx loadsheet --harness claude-code  # only Claude Code's sheet
npx loadsheet --json                 # the Report as JSON, for scripts and agents
```

`--harness` takes `claude-code`, `codex`, `grok`, `pi`, `opencode`, `cursor`, `gemini` or `kiro`, and you can repeat it. loadsheet still reads every harness, because a fix that removes a file has to know every harness that loads it. The flag only picks which sheets the report shows.

## Exit codes

| Code | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| `0`  | It printed a report. Findings never change the exit code. |
| `1`  | It could not read this machine.                           |
| `2`  | A bad flag or a bad config file. stderr says which.       |

## Next

- [Read the report](/docs/guide/reading) explains each part of the output.
- [Apply fixes with your agent](/docs/guide/fixes) hands the findings to Claude Code or Codex.
- [The report as a web page](/docs/guide/web-page) shows the same report in a browser.

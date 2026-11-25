---
title: Privacy
description: What loadsheet reads, what it keeps in its cache, and what leaves your machine.
navigation.order: 6
---

loadsheet runs on your machine. It reads your agents' transcripts there and sends nothing anywhere unless you ask it to.

## What a Report holds

A Report, and the Scan each machine sends with `--fleet`, holds counters and names: how many sessions listed an item, how often it was invoked, its size, its path relative to your home folder. It also holds each skill's and subagent's description, the text the harness lists for it.

These stay out of every Report and Scan:

- transcript text, and the input and output of every tool call
- the bodies of skills and instruction files
- session ids
- environment variables
- absolute paths under your home folder, which become `~/...`

## What it writes

loadsheet edits none of your files. It writes its scan cache to `~/.cache/loadsheet`, or `$XDG_CACHE_HOME/loadsheet`. The cache holds counters, keyed by a salted hash of each transcript's path, and no transcript text, session id or file name. `--no-cache` writes no cache.

`loadsheet build` writes the web page into the folder you name. See [The report as a web page](/docs/guide/web-page).

## What leaves your machine

- With `--fleet`, each of your machines sends its Scan to the one that asked, over your own ssh.
- A Share link from the web page holds the Report after the `#` of the URL, which browsers do not send to loadsheet.dev. The link drops every description first.
- `npx loadsheet <GitHub URL>` downloads that repository's archive from GitHub.
- A pack page on loadsheet.dev downloads a public GitHub repository. It takes no token and stores nothing.

Nothing else does. loadsheet sends no telemetry.

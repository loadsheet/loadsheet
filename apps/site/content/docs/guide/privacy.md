---
title: Privacy
description: What loadsheet reads, what it keeps in its cache, and what leaves your machine.
navigation.order: 6
---

loadsheet runs on your machine. It reads your agents' transcripts there and sends nothing anywhere unless you ask it to.

## What a Report holds

A Report, and the Scan each machine sends with `--fleet`, holds counters and names: how many sessions listed an item, how often it was invoked, its size, its path relative to your home folder. It also holds each skill's and subagent's description, the text the harness lists for it.

Its `usage` counts sessions, compactions and tokens per day, harness, entrypoint, model and project. A project is named by its git remote, such as `acme/web`, or else by its folder, such as `~/work/site`. Those names are yours, like the descriptions. `loadsheet usage` prints them. To name a folder's project, loadsheet reads the git config of the folder a session ran in, and Claude Code's `~/.claude.json` for folders that no longer exist.

It reads settings too, such as Claude Code's `settings.json` and `~/.codex/config.toml`, and keeps only what they mean: a cache lifetime of `1h` and which setting set it, the days transcripts are kept. Never a setting's text or a variable's value.

These stay out of every Report and Scan:

- transcript text, and the input and output of every tool call
- the bodies of skills and instruction files
- session ids, and any record per session: usage holds only sums
- environment variables
- absolute paths under your home folder, which become `~/...`

## What it writes

loadsheet edits none of your files. It writes its scan cache to `~/.cache/loadsheet`, or `$XDG_CACHE_HOME/loadsheet`. The cache holds counters, keyed by a salted hash of each transcript's path, and no transcript text, session id or file name. Its usage counters name the folder each session ran in, as `~/...`. To resume a transcript it keeps a hash of the last message id, never the id. It opens T3 Code's, OpenCode's and Codex's state databases read-only, so no file appears beside them, and reads T3 Code's usage cache file; it caches nothing from them. The session ids it compares with your transcripts, so that no session counts twice, stay in memory. `--no-cache` writes no cache.

`loadsheet build` writes the web page into the folder you name. See [The report as a web page](/docs/guide/web-page).

## What leaves your machine

- With `--fleet`, each of your machines sends its Scan to the one that asked, over your own ssh.
- A Share link from the web page holds the Report after the `#` of the URL, which browsers do not send to loadsheet.dev. The link drops every description, the whole usage, and custom settings paths and their exact edits.
- `npx loadsheet <GitHub URL>` downloads that repository's archive from GitHub.
- A pack page on loadsheet.dev downloads a public GitHub repository. It takes no token and stores nothing.
- [The MCP check](/mcp) on loadsheet.dev reads the `tools/list` of the public MCP server you paste, once. It takes no token and never stores the URL; it keeps only a daily count of checks.

Nothing else does. loadsheet sends no telemetry.

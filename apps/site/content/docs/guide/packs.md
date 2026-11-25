---
title: Weigh a skill pack
description: See what a skill pack would add to every session before you install it, from a folder or a GitHub URL.
navigation.order: 4
---

A skill pack is a folder or repository of skills. Before you install one, loadsheet can tell you what it would add to every session of your agent.

## From the command line

Give loadsheet a folder or a GitHub URL:

```sh
npx loadsheet ./my-skills
npx loadsheet https://github.com/mattpocock/skills
npx loadsheet https://github.com/anthropics/skills/tree/main/skills
```

A URL is `https://github.com/<owner>/<repo>`, with `/tree/<ref>/<folder>` to read one branch, tag or folder. loadsheet downloads the repository as an archive, with no git. A folder named `fleet` or `build` has to be written `./fleet` or `./build`, since those words are commands.

```txt
loadsheet@0.1.0: pack https://github.com/mattpocock/skills
Weighed for claude-code from its files alone: a pack has no sessions, so no usage.

claude-code: 39 lines, ~886 tokens listed; the 10 heaviest
  tokens  listed   body  item
     113     451  6,230  skill:mattpocock-skills:code-review
```

`tokens` is what the skill's listing entry adds to every session. `listed` is the characters of that entry and `body` the characters of the whole `SKILL.md`, which loads only when the skill runs.

A pack has no sessions, so the rules that judge use do not run on it. The rules that judge size do, such as `expensive-description`. Its fixes point at the pack's own files, relative to its folder.

## For another harness

loadsheet weighs a pack for Claude Code unless you name one harness:

```sh
npx loadsheet https://github.com/mattpocock/skills --harness codex
```

## On loadsheet.dev

Paste a GitHub URL or `owner/repo` on the loadsheet.dev home page. The site downloads the public repository, finds its skills with the same code as `npx skills add`, and shows each skill with its description and tokens. It reads public repositories only and keeps nothing.

For a private repository or a source outside GitHub, clone it and run `npx loadsheet <folder>` on your machine.

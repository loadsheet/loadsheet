---
title: Apply fixes with your agent
description: Hand loadsheet's findings to Claude Code, Codex or another agent, which applies only the fixes you accept.
navigation.order: 2
---

loadsheet writes no file of yours. Each finding carries fixes, and your coding agent applies the ones you accept.

Paste the prompt in [`docs/agent-prompt.md`](https://github.com/loadsheet/loadsheet/blob/main/docs/agent-prompt.md) into Claude Code, Codex or another agent, on the machine you want to clean up. The agent then:

1. Runs `npx loadsheet --json` and keeps the Report.
2. Shows you the findings in plain words, ranked by the tokens each would save, and asks which to apply.
3. Applies only the fixes you accept, one at a time, and shows you each command before it runs it.
4. Runs loadsheet again and tells you which findings are gone.

## The kinds of fix

| Action            | What the agent does                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hide-from-model` | Sets a key so the model stops invoking the skill on its own. You can still call it by name, such as `/pdf`.                                              |
| `set`             | Writes one key and value into a settings file, such as `~/.claude/settings.json` or `~/.codex/config.toml`.                                              |
| `shorten`         | Rewrites the skill's `description` in fewer characters, and waits for your approval of the new text.                                                     |
| `remove`          | Runs the command that removes the item. First it looks for links into the folder and for work that exists nowhere else, and asks you if it finds either. |
| `dedupe`          | Removes a second copy of a skill that the harness does not load.                                                                                         |

A fix names the machine it is for. In a [fleet report](/docs/guide/fleet), the agent applies the fixes for its own machine and lists the others for you to run there.

A finding may stay after its fix. loadsheet reads past sessions, so the item drops out once new sessions have run without it.

Without an agent, `npx loadsheet` prints the same findings and fixes as text.

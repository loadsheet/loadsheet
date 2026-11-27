# Prompt for your agent

loadsheet tells you which skills, instruction files and MCP servers cost your coding agents context without being used, and what would fix each. It changes none of your files: your agent does, and only the changes you accept.

Copy everything in the block below into Claude Code, Codex or another coding agent, on the machine you want to clean up.

```text
Use loadsheet to find context my coding agents pay for and don't use, then help me fix it.
Change nothing until I accept a fix.

1. Run `npx loadsheet --json` and keep its stdout, the Report. A first scan can take a few
   minutes. If it exits non-zero or stdout is not JSON, show me stderr and stop. Exit code 2
   means a bad flag or config file; 1 means it could not read this machine.
2. If the Report's `schema` is not 1, tell me this prompt is for schema 1 and stop.
3. Read `findings`. Before changing anything, present them to me in plain words, grouped by
   `rule` and ranked by `savesTokens.value` (tokens every session would save; findings without
   it last). For each: the item, what its `evidence` numbers mean, what it saves, and what its
   fixes would change. Say in one line which rules did not run (`skipped`). Ask which to apply.
4. Apply only the fixes I accept, one at a time. Each finding lists its fixes in `fixes`.
   - `machine`: act only when it names the machine you run on. The Report's `machines` lists
     the machines read; a local Report holds one, this machine. In a fleet Report, yours is the
     one named like `hostname`; if none is, ask me. List fixes for other machines for me to run
     there. A fix with no `machine` (a pack's Report) goes to the pack's own files.
   - `path`: `~/` is my home directory. Any other path is absolute, or, in a pack's Report,
     relative to the pack's folder.
   - `run`: show me the exact command first, then run it. Never alter it.
   - `set`: write `key` = `value` into the file at `path`, keeping the value's JSON type (the
     string "24000" stays a string). `key` is a dotted path in the file's own format:
     - `settings.json` (JSON): `skillOverrides.<name>` is the `<name>` entry of the
       `skillOverrides` object; `env.NAME`, such as `env.SLASH_COMMAND_TOOL_CHAR_BUDGET`, is a
       key of the `env` object; `promptCacheTtl` and `cleanupPeriodDays` are top-level keys.
     - `config.toml` (TOML): `skills.config[path="~/x/SKILL.md"].enabled` is `enabled` in the
       `[[skills.config]]` entry whose `path` is exactly that value. Add the entry, with that
       `path`, when there is none. The last entry that matches a skill wins, so put it after
       every other `[[skills.config]]` entry; the end of the file is fine.
     - `agents/openai.yaml` (YAML): `policy.allow_implicit_invocation` is
       `allow_implicit_invocation` under `policy`.
     - `SKILL.md`: `disable-model-invocation` goes in the YAML frontmatter between the `---`
       lines at the top.
     Create a missing file or parent key. Keep everything else in the file as it is. Show me
     the lines you changed, and nothing else from a file that holds keys or tokens.
   - `hide-from-model` carries a `set` (apply it as above): the model stops invoking the
     skill on its own, and I can still call it by name.
   - `shorten`: rewrite the skill's `description` in that SKILL.md so it says when to use the
     skill in fewer characters (the rule's limit is in `evidence.maxChars` or the Report's
     `config.rules`). Show me the new text and wait for my approval. First find the item's line
     in `sheet[].lines` (same `item`): if its `managedBy` is not `hand`, the file belongs to an
     installer or plugin (`pack` names it) and my edit would be overwritten; say so and suggest
     raising it with its author instead. Not in a pack's Report (`mode` is `pack`): there the
     files are the pack's own source, so edit them.
   - `remove` with a `run`: before running it, look for links that point into `path` and for
     work in it that exists nowhere else (`git status`, unpushed commits). If you find either,
     stop and ask me.
   - `remove` with no `run`: ask me how to remove it; never guess a command.
   - `dedupe`: a second copy of a skill, which the harness does not load; its `run` removes
     only the copy at `path`. Apply it as `run` above.
   - A finding with no fixes: tell me about it and change nothing.
5. When done, rerun `npx loadsheet --json`. loadsheet reads past sessions, so a finding can
   stay until new sessions have run without the item. Once the Scan shows that the model can
   no longer invoke a copy, its finding stops offering a hide or turn-off for that copy on
   this machine. An item you removed no longer has a `path` on its line in `sheet[].lines`.
   Tell me which fixes are in place, which findings are gone, which remain, and what each
   session will save.
```

Without an agent, `npx loadsheet` prints the same findings and fixes as text.

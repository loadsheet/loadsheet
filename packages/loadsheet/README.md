# loadsheet

Reports which skills, instruction files and MCP servers cost your coding agents context without being used. It reads Claude Code's and Codex's session transcripts on your machine, and with `--fleet` on the other machines fleetrc names, and edits none of your files.

```sh
npx loadsheet            # this machine's report
npx loadsheet --json     # the Report as JSON, schema 1
npx loadsheet --fleet    # this machine and every machine of its fleetrc fleet, over ssh
npx loadsheet ./skills   # weigh a skill pack, with no usage data
npx loadsheet build      # the report as a web page in ./loadsheet-report
npx loadsheet --ui       # the same page, served on 127.0.0.1
```

`npx loadsheet --help` lists every option. To have your agent apply the fixes you accept, paste it the prompt in [`docs/agent-prompt.md`](https://github.com/loadsheet/loadsheet/blob/main/docs/agent-prompt.md).

The first run reads every transcript and can take a minute; it prints its progress on stderr, and later runs read only what changed.

A Report holds counters, names and your skills' descriptions: no transcript text, tool input or output, file bodies, session ids, environment values or home paths. A report you share through loadsheet.dev drops the descriptions too. The Report's JSON Schema is at https://loadsheet.dev/schema/v1.json.

MIT licensed.

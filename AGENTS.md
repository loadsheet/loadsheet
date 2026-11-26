# loadsheet

`npx loadsheet` reads coding agents' session transcripts on the user's machines and shows what every skill, `AGENTS.md`/`CLAUDE.md`, MCP server and subagent costs in context, and whether anything uses it. It hands the user's agent the exact commands to fix what it finds.

## What we never compromise on

1. **Private by construction.** A Scan or Report holds counters and names, plus each skill's and subagent's description. Descriptions travel only between the user's own machines (`--fleet` uses the user's ssh). A Report shared through loadsheet.dev goes through `shareableReport`, which drops them. Transcript text, tool input and output, file bodies, session ids, environment variables and absolute home paths never reach any output or the cache.
2. **Read-only on the user's machine.** loadsheet writes only to its own cache. Fixes go to the user's agent as commands. `loadsheet build` writes where the user says, and only over files it wrote before.
3. **Works on a stock install.** Someone with a plain Claude Code or Codex setup must get a useful report. Group and name things by what every install has: personal skills, plugins, project files. Maxi's fleetrc manifest (`packages/harnesses/src/managed.ts`) is an extra, never what a view depends on.
4. **Now, before history.** The main question is what a session started now loads before you type. Usage history serves as evidence behind a fix; it is not a view of its own yet.

## Where each package runs

Before you move code between packages, change a type that crosses one, or add a harness or a rule, read `SPEC.md`: it maps each package, the data that flows between them, and the files each addition touches.

The dependencies in each `package.json` are the layering, and `vp lint` rejects the imports that break it. The reasons:

- `@loadsheet/schema`, `@loadsheet/core`, kit's `.` and `@loadsheet/harnesses` run in the browser. Only `@loadsheet/kit/node` touches the disk; a harness adapter receives `Files` from it.
- `@loadsheet/ui` renders in Nuxt SSR and in the CLI's single HTML file, so it reads `document` or `location` only inside handlers and never imports Nuxt.
- `@loadsheet/resolve` runs in a Cloudflare Worker: `fetch` is injected, and there is no git or `child_process`.
- `loadsheet` is the only package that parses argv, apart from fleet's own commands.
- `@loadsheet/fleet` knows nothing of loadsheet. `fleetrc` is the bin npm users already run, so it keeps behaving as before.
- `@loadsheet/fixtures` is for tests and scripts only.

## Web

There is one site and one deploy. `apps/site` is loadsheet.dev, a Nuxt 5 app on ViteHub (docs, CMS, console). It weighs a skills source from a URL with the same resolver as the skills CLI. `apps/page` is the fully static HTML file the CLI writes. Both mount `@loadsheet/ui`. Staging copies and `-next` projects are not part of the setup.

- Read `DESIGN.md` before any UI change.
- A new look, for a web page or the terminal output, is agreed on a prototype Maxi approves first; then it goes into the source.

## Test data

Real transcripts are private. Read them a few lines at a time. Make a fixture with `pnpm --filter @loadsheet/fixtures sanitize`, and read its output before you commit it: the repository is public.

## Harnesses

- Antigravity is not Gemini. Antigravity CLI keeps its config in `~/.gemini/config` and its sessions as SQLite files in `~/.gemini/antigravity-cli/conversations`.
- Readers copied from `vite-hub/t3code` keep its MIT notice as a header comment.

## Git and releases

- Push to `main` directly, or open a pull request when you want a review. Before each push, rebase on `origin/main` and run `pnpm build`, `pnpm check` and `vp test packages/<name>` for each package you changed. Tests run the built CLI, so build first. Never force-push `main`.
- Every public package shares one version, because the release runs in lockstep. The private `fleetrc` stays at 0.0.0.
- A merge into `main` opens a `release/v*` pull request; merging it publishes to npm through trusted publishing. CI on that bot pull request waits for approval: `gh api -X POST repos/loadsheet/loadsheet/actions/runs/<id>/approve`.
- A new public package needs its npm name claimed with a trusted publisher before its first release.

## Tracking

Linear (team LOAD) holds only what needs a human: a blocker such as a payment or 2FA, a decision an agent can't make, or something people must review. Decide and do the rest without an issue. Keep plans, notes and status reports out of the repository; report in the chat.

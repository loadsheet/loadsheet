# loadsheet

loadsheet is a CLI (`npx loadsheet`) that reads coding agents' session transcripts locally and reports which skills, instruction files and MCP servers cost context without being used. This repository is a pnpm workspace of the packages that build it, all versioned together.

## Layers

Each package's dependencies in `package.json` are the layering. Keep imports inside its row.

| Package                            | May import                   | Must not know                                                               |
| ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `@loadsheet/schema`                | nothing at runtime           | anything else in the repo, Node                                             |
| `@loadsheet/kit`                   | schema, Node                 | rules or findings                                                           |
| `@loadsheet/harnesses`             | schema, kit                  | rules; the filesystem: an adapter receives lines and virtual files from kit |
| `@loadsheet/core`                  | schema                       | kit, harnesses, `node:*`; it is isomorphic and runs in the browser          |
| `loadsheet` (`packages/loadsheet`) | schema, kit, harnesses, core | nothing; it is the only place that parses argv                              |

`vp lint` fails when `packages/core/src` or `packages/schema/src` imports a Node builtin, kit, harnesses or `loadsheet`.

## Privacy

A Scan or Report holds counters and names only. Transcript text, tool input and output, skill and instruction bodies, session ids, environment variables and absolute home paths stay out of both.

Real transcripts are private. Read them a few lines at a time, and scrub anything you copy into a fixture.

## Writes

loadsheet reads the user's files and edits none of them. It writes only to its own cache directory; fixes go to the user's agent as commands.

## Commands

- `pnpm build`: builds every package (cached by `vp run`); tests run the built CLI, so build first.
- `pnpm check`: format, lint and typecheck.
- `vp test packages/<name>`: one package's tests.

Readers copied from `vite-hub/t3code` keep its MIT notice as a header comment.

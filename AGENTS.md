# loadsheet

loadsheet is a CLI (`npx loadsheet`) that reads coding agents' session transcripts locally and reports which skills, instruction files and MCP servers cost context without being used. This repository is a pnpm workspace of the packages that build it, all versioned together.

## Layers

Each package's dependencies in `package.json` are the layering. Keep imports inside its row.

| Package                            | May import                   | Must not know                                                                |
| ---------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `@loadsheet/schema`                | nothing at runtime           | anything else in the repo, Node                                              |
| `@loadsheet/kit` (`.`)             | schema                       | rules or findings; `node:*`, `@loadsheet/kit/node`; it runs in the browser   |
| `@loadsheet/kit/node` (`src/node`) | schema, kit's `.`, Node      | rules or findings                                                            |
| `@loadsheet/harnesses`             | schema, kit's `.`, tinyaml   | rules; `node:*`, `@loadsheet/kit/node`: an adapter receives `Files` from kit |
| `@loadsheet/core`                  | schema                       | kit, harnesses, `node:*`; it is isomorphic and runs in the browser           |
| `loadsheet` (`packages/loadsheet`) | schema, kit, harnesses, core | nothing; it is the only place that parses argv                               |
| `@loadsheet/fixtures` (private)    | Node                         | every other package; only tests and scripts import it, and it is not built   |

`vp lint` fails when `packages/core/src` or `packages/schema/src` imports a Node builtin, kit, harnesses or `loadsheet`, and when `packages/harnesses/src` or `packages/kit/src` outside `node/` imports a Node builtin or `@loadsheet/kit/node`.

## Privacy

A Scan or Report holds counters and names only. Transcript text, tool input and output, skill and instruction bodies, session ids, environment variables and absolute home paths stay out of both.

Real transcripts are private. Read them a few lines at a time. Make a fixture with `pnpm --filter @loadsheet/fixtures sanitize <in.jsonl> <out.jsonl> --policy <module>`: it replaces every string its policy does not name with the canary `CANARY-LS` and every object key with `key-N`, so read the output before you commit it. Tests assert that `findCanary` and `findCanaryInDir` find nothing in a Scan, a Report or the cache.

## Writes

loadsheet reads the user's files and edits none of them. It writes only to its own cache directory; fixes go to the user's agent as commands.

## Commands

- `pnpm build`: builds every package (cached by `vp run`); tests run the built CLI, so build first.
- `pnpm check`: format, lint and typecheck.
- `vp test packages/<name>`: one package's tests.

Readers copied from `vite-hub/t3code` keep its MIT notice as a header comment.

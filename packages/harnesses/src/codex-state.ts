// Codex's state database, `$CODEX_HOME/state_N.sqlite`: one `threads` row per thread, kept after
// its rollout file is deleted. It fills in the threads whose rollouts are gone; a thread whose
// rollout this scan listed is skipped through `$native`, the thread ids in rollout names. `N` is
// the schema version Codex names the file by, so kit reads the highest one there.
//
// A row keeps one token total per thread (`tokens_used`, the rollout's last `total_tokens`) and
// no split, so it counts as `unsplit` on the day the thread was created, with no request counted.
// A fork's rollout copies its parent's history, which the rollout reader skips; the database does
// not say which thread is a fork. On the machine this was written on, each of the 132 forked
// threads whose rollout remains had a total equal to its own steps, none of the parent's.
import {
  repoOfRemote,
  type Place,
  type SqliteStore,
  type StoreFact,
  type StoreRow,
} from "@loadsheet/kit";
import { codexVia } from "./codex-transcripts.ts";
import { count, modelName, projectOfCwd, tokensOf, utcDay } from "./store-facts.ts";

// `source` is a client name such as `vscode`, or JSON such as `{"subagent":...}` for a spawned
// subagent; only the name or the flag leaves SQLite. `json_type` throws on text that is not JSON,
// so it runs only under `json_valid`. A thread is a subagent's as its rollout says:
// spawned, or started with `thread_source` `subagent`, as T3 Code's subagent threads are.
const QUERY = `SELECT COALESCE(created_at_ms, created_at * 1000) AS at,
  originator,
  CASE WHEN json_valid(source) THEN NULL ELSE source END AS source,
  CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NOT NULL ELSE 0 END AS spawned,
  thread_source = 'subagent' AS subagentSource,
  git_origin_url AS remote, cwd, model, tokens_used AS unsplit
FROM threads
WHERE COALESCE(created_at_ms, created_at * 1000) >= $since
  AND id NOT IN (SELECT value FROM json_each($native))`;

const rowFacts = (row: StoreRow, place: Place): StoreFact[] => {
  const day = utcDay(row.at);
  if (!day) return [];
  const spawned = count(row.spawned) > 0;
  const remote = typeof row.remote === "string" ? repoOfRemote(row.remote) : undefined;
  const base = {
    day,
    via: codexVia(row.originator, row.source, spawned),
    project: remote ?? projectOfCwd(row.cwd, place),
    thread: spawned || count(row.subagentSource) ? "subagent" : "main",
  } as const;
  const facts: StoreFact[] = [{ type: "usage-session", ...base }];
  const unsplit = count(row.unsplit);
  if (unsplit > 0) {
    facts.push({
      type: "usage-tokens",
      ...base,
      model: modelName(row.model),
      requests: 0,
      ...tokensOf({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, unsplit }),
    });
  }
  return facts;
};

/** Codex's state database under its home, read for the threads whose rollouts are gone. */
export const codexStateDb = (home: (place: Place) => string): SqliteStore => ({
  kind: "sqlite",
  name: "codex-state",
  path: (place) => ({ dir: home(place), pattern: /^state_(\d+)\.sqlite$/ }),
  query: QUERY,
  since: "ms",
  native: "codex",
  supplies: ["codex"],
  facts: (rows, place) => rows.flatMap((row) => rowFacts(row, place)),
});

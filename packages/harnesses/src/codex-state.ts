// Codex's state database, `$CODEX_HOME/state_N.sqlite`: one `threads` row per thread, kept after
// its rollout file is deleted. It fills in the threads whose rollouts are gone; a thread whose
// rollout this scan listed is skipped through `$native`, the thread ids in rollout names. `N` is
// the schema version Codex names the file by, so kit reads the highest one there.
//
// A gone thread's tokens come from T3 Code's usage cache when it has the rollout
// (`t3-scan-cache.ts`, bound as `$scanCache`): T3's reading of each request, split as the rollout
// reader splits it, on the day it was made. On the machine this was written on, the cache and the
// rollout reader agreed within 0.25% per day and token kind on the 1,768 rollouts both still had.
// The state database still gives such a thread its session, via, project and subagent flag. A
// thread the cache does not have counts its state row's one token total (`tokens_used`, the
// rollout's last `total_tokens`) as `unsplit` on the day it was created, with no request counted.
//
// A fork's rollout copies its parent's history, which the rollout reader and T3 both skip; the
// database does not say which thread is a fork. On the machine this was written on, each of the 132
// forked threads whose rollout remains had a total equal to its own steps, none of the parent's.
import {
  repoOfRemote,
  type Place,
  type SqliteStore,
  type StoreFact,
  type StoreRow,
} from "@loadsheet/kit";
import { codexVia } from "./codex-transcripts.ts";
import { trimSlash } from "./inventory.ts";
import { count, modelName, noTokens, projectOfCwd, tokensOf, utcDay } from "./store-facts.ts";
import { codexCacheFile, reduceScanCache, t3ScanCachePath } from "./t3-scan-cache.ts";

const CACHED = (field: string) => `json_extract(value, '$.${field}') AS ${field}`;

// `source` is a client name such as `vscode`, or JSON such as `{"subagent":...}` for a spawned
// subagent; only the name or the flag leaves SQLite. `json_type` throws on text that is not JSON,
// so it runs only under `json_valid`. A thread is a subagent's as its rollout says:
// spawned, or started with `thread_source` `subagent`, as T3 Code's subagent threads are.
const THREAD = `originator,
  CASE WHEN json_valid(source) THEN NULL ELSE source END AS source,
  CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NOT NULL ELSE 0 END AS spawned,
  thread_source = 'subagent' AS subagentSource,
  git_origin_url AS remote, cwd`;

// The cache's rows for the threads no listed rollout counts: a `start` row per rollout, which
// counts as a session only for a thread the state database lacks, and token rows per day and
// model, which take the state database's fields for their thread.
const QUERY = `WITH cached AS MATERIALIZED (SELECT ${["s", "day", "start", "model", "u", "c", "w", "o", "r", "n"].map(CACHED).join(", ")}
FROM json_each($scanCache)),
since AS (SELECT strftime('%Y-%m-%d', $since / 1000, 'unixepoch') AS day),
unlisted AS MATERIALIZED (SELECT id, COALESCE(created_at_ms, created_at * 1000) AS at, ${THREAD},
  model, tokens_used AS unsplit
FROM threads
WHERE id NOT IN (SELECT value FROM json_each($native)))
SELECT 'thread' AS kind, at, originator, source, spawned, subagentSource, remote, cwd, model,
  CASE WHEN id IN (SELECT s FROM cached) THEN 0 ELSE unsplit END AS unsplit,
  NULL AS input, NULL AS cacheRead, NULL AS cacheWrite, NULL AS output, NULL AS reasoning,
  NULL AS requests
FROM unlisted WHERE at >= $since
UNION ALL
SELECT CASE WHEN x.start THEN 'thread' ELSE 'cached' END, x.day, t.originator, t.source, t.spawned,
  t.subagentSource, t.remote, t.cwd, x.model, 0, x.u, x.c, x.w, x.o, x.r, x.n
FROM cached x LEFT JOIN unlisted t ON t.id = x.s
WHERE x.day >= (SELECT day FROM since) AND (x.start IS NULL OR t.id IS NULL)`;

const rowFacts = (row: StoreRow, place: Place): StoreFact[] => {
  // Epoch milliseconds from the state database, a UTC day from the cache.
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
  if (row.kind === "cached") {
    // The cache's input is without what was read from and written to the cache, as the rollout
    // reader counts it.
    const output = count(row.output);
    const tokens = {
      input: count(row.input),
      output,
      reasoning: Math.min(count(row.reasoning), output),
      cacheRead: count(row.cacheRead),
      cacheWrite: count(row.cacheWrite),
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRewrite: 0,
    };
    if (noTokens(tokens)) return [];
    return [
      {
        type: "usage-tokens",
        ...base,
        model: modelName(row.model),
        requests: count(row.requests),
        ...tokens,
      },
    ];
  }
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
  inputs: [
    {
      param: "$scanCache",
      path: (place) => t3ScanCachePath(trimSlash(place.home)),
      read: (document, native) =>
        reduceScanCache(document, { provider: "codex", file: codexCacheFile, native }),
    },
  ],
  facts: (rows, place) => rows.flatMap((row) => rowFacts(row, place)),
});

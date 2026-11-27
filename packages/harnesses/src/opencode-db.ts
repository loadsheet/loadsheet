// OpenCode's sessions: the `session` table of `opencode.db`, in `OPENCODE_DATA_DIR`, else
// `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. Each row sums one session's tokens,
// so they are counted as ccusage counts OpenCode's: on the day the session was created, under the
// model it last ran. `tokens_input` holds no cached tokens, and `tokens_reasoning` is apart from
// `tokens_output`, so a Fact's output is the two summed. A session with a `parent_id` is a
// subagent's, and `time_compacting` says it compacted at least once.
import type { Place, SqliteStore, StoreFact, StoreRow } from "@loadsheet/kit";
import { envDir, trimSlash } from "./inventory.ts";
import { count, modelName, noTokens, projectOfCwd, utcDay } from "./store-facts.ts";

/** OpenCode's data folder, which holds `opencode.db`. */
const dataDir = (place: Place) =>
  envDir(place, "OPENCODE_DATA_DIR") ??
  `${envDir(place, "XDG_DATA_HOME") ?? `${trimSlash(place.home)}/.local/share`}/opencode`;

// `model` is JSON, `{"id","providerID",...}`, in current versions and a plain name in older ones.
const QUERY = `SELECT time_created AS at,
  CASE WHEN json_valid(model) THEN json_extract(model, '$.id') ELSE model END AS model,
  directory AS cwd,
  parent_id IS NOT NULL AS subagent,
  time_compacting IS NOT NULL AS compacted,
  tokens_input AS input, tokens_output AS output, tokens_reasoning AS reasoning,
  tokens_cache_read AS cacheRead, tokens_cache_write AS cacheWrite
FROM session WHERE time_created >= $since`;

const rowFacts = (row: StoreRow, place: Place): StoreFact[] => {
  const day = utcDay(row.at);
  if (!day) return [];
  const base = {
    day,
    via: "cli",
    project: projectOfCwd(row.cwd, place),
    thread: count(row.subagent) ? "subagent" : "main",
  } as const;
  const facts: StoreFact[] = [{ type: "usage-session", ...base }];
  if (count(row.compacted)) facts.push({ type: "compaction", ...base, manual: false, first: true });
  const reasoning = count(row.reasoning);
  const tokens = {
    input: count(row.input),
    output: count(row.output) + reasoning,
    reasoning,
    cacheRead: count(row.cacheRead),
    cacheWrite: count(row.cacheWrite),
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRewrite: 0,
  };
  // One row sums the session's requests, which OpenCode does not count: it counts as one.
  if (!noTokens(tokens)) {
    facts.push({
      type: "usage-tokens",
      ...base,
      model: modelName(row.model),
      requests: 1,
      ...tokens,
    });
  }
  return facts;
};

/** OpenCode's database, read for usage. */
export const opencodeDb: SqliteStore = {
  kind: "sqlite",
  name: "opencode.db",
  path: (place) => `${dataDir(place)}/opencode.db`,
  query: QUERY,
  since: "ms",
  facts: (rows, place) => rows.flatMap((row) => rowFacts(row, place)),
};

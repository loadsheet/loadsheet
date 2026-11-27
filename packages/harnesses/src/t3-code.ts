// T3 Code (`~/.t3/userdata/statev2.sqlite`): the threads of the agents it drives, for the agents
// loadsheet has no reader of its own for, such as Antigravity. Claude Code, Codex, Grok and
// OpenCode keep their own sessions, which their adapters read, so T3's copies of theirs are left
// out rather than counted twice.
//
// Tokens come from each provider turn's `turnTokenUsage`: what that turn used, so turns sum. The
// thread's `tokenUsage` is the context's size at its last turn, which does not sum, and some
// providers leave it out. `inputTokens` holds `cachedInputTokens` and `cacheCreationTokens`, and
// `outputTokens` holds `reasoningTokens`. T3 records usage once per turn, so a turn counts as one
// request. A thread with a parent in its lineage is a subagent's; its compactions are its
// `compaction` turn items. Its project is its worktree, else its project's workspace root.
//
// Every value is picked out with `json_extract` in the query, so no message, title or id leaves
// SQLite. The threads are filtered first: the turns' and items' indexes by thread keep the query
// at about 50 ms on a 40 GB database.
import type { Place, SqliteStore, StoreFact, StoreRow } from "@loadsheet/kit";
import { trimSlash } from "./inventory.ts";
import { count, modelName, noTokens, projectOfCwd, tokensOf, utcDay } from "./store-facts.ts";

/** The id under which T3 Code's database is listed in a Coverage when it cannot be read. */
export const T3_CODE = "t3-code";

/** T3's provider ids that are loadsheet harnesses by another name. */
const HARNESS_OF: Readonly<Record<string, string>> = {
  claudeAgent: "claude-code",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  cursor: "cursor",
  gemini: "gemini",
  pi: "pi",
  kiro: "kiro",
};

/** The providers whose sessions loadsheet reads from the harness's own files. */
const NATIVE = ["claudeAgent", "codex", "grok", "opencode"];
const NATIVE_LIST = NATIVE.map((provider) => `'${provider}'`).join(", ");

const THREAD = `json_extract(t.payload_json, '$.modelSelection.model') AS model,
  coalesce(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd,
  json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL AS subagent`;
const USAGE = (field: string) => `json_extract(pt.payload_json, '$.turnTokenUsage.${field}')`;

// CROSS JOIN keeps the threads as the outer loop, so SQLite filters them by provider first and
// reaches each one's turns through their index by thread.
const QUERY = `SELECT 'turn' AS kind, pth.provider AS provider,
  coalesce(pt.completed_at, pt.started_at) AS at, ${THREAD},
  ${USAGE("inputTokens")} AS input, ${USAGE("cachedInputTokens")} AS cacheRead,
  ${USAGE("cacheCreationTokens")} AS cacheWrite, ${USAGE("outputTokens")} AS output,
  ${USAGE("reasoningTokens")} AS reasoning, NULL AS compactions
FROM orchestration_v2_projection_threads t
CROSS JOIN orchestration_v2_projection_provider_turns pt ON pt.thread_id = t.thread_id
JOIN orchestration_v2_projection_provider_threads pth ON pth.provider_thread_id = pt.provider_thread_id
LEFT JOIN projection_projects p ON p.project_id = t.project_id
WHERE t.default_provider NOT IN (${NATIVE_LIST}) AND pth.provider NOT IN (${NATIVE_LIST})
  AND coalesce(pt.completed_at, pt.started_at) >= ?1
UNION ALL
SELECT 'thread', t.default_provider, t.created_at, ${THREAD},
  NULL, NULL, NULL, NULL, NULL,
  (SELECT count(*) FROM orchestration_v2_projection_turn_items ti
    WHERE ti.thread_id = t.thread_id AND ti.type = 'compaction')
FROM orchestration_v2_projection_threads t
LEFT JOIN projection_projects p ON p.project_id = t.project_id
WHERE t.default_provider NOT IN (${NATIVE_LIST}) AND t.created_at >= ?1`;

/** A provider as a harness id: loadsheet's name for it, else its own, lowercased and hyphenated. */
const harnessOf = (provider: unknown): string | undefined => {
  if (typeof provider !== "string" || !provider) return undefined;
  const known = HARNESS_OF[provider];
  if (known) return known;
  const id = provider
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return /^[a-z][a-z0-9-]*$/u.test(id) ? id : undefined;
};

const rowFacts = (row: StoreRow, place: Place): StoreFact[] => {
  const harness = harnessOf(row.provider);
  const day = utcDay(row.at);
  if (!harness || !day) return [];
  const base = {
    harness,
    day,
    via: T3_CODE,
    project: projectOfCwd(row.cwd, place),
    thread: count(row.subagent) ? "subagent" : "main",
  } as const;
  if (row.kind === "thread") {
    const facts: StoreFact[] = [{ type: "usage-session", ...base }];
    const compactions = count(row.compactions);
    for (let index = 0; index < compactions; index += 1) {
      facts.push({ type: "compaction", ...base, manual: false, first: index === 0 });
    }
    return facts;
  }
  // A turn T3 has no usage for, such as one that failed before the provider answered.
  if (row.input === null && row.output === null) return [];
  const tokens = tokensOf({
    input: count(row.input),
    cacheRead: count(row.cacheRead),
    cacheWrite: count(row.cacheWrite),
    output: count(row.output),
    reasoning: count(row.reasoning),
  });
  if (noTokens(tokens)) return [];
  return [{ type: "usage-tokens", ...base, model: modelName(row.model), requests: 1, ...tokens }];
};

/** T3 Code's database, read for the usage of the agents loadsheet has no reader for. */
export const t3Code: SqliteStore & { readonly harness: string } = {
  kind: "sqlite",
  harness: T3_CODE,
  name: "statev2.sqlite",
  path: (place) => `${trimSlash(place.home)}/.t3/userdata/statev2.sqlite`,
  query: QUERY,
  since: "iso",
  facts: (rows, place) => rows.flatMap((row) => rowFacts(row, place)),
};

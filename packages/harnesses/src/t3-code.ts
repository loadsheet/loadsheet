// T3 Code (`~/.t3/userdata/statev2.sqlite`): the threads of the agents it drives, for the agents
// loadsheet has no reader of its own for, such as Antigravity, and for Claude Code sessions whose
// transcripts are gone. Codex, Grok and OpenCode keep their own sessions, which their adapters
// read, so T3's copies of theirs are left out rather than counted twice.
//
// Claude Code deletes old transcripts, and T3 keeps two copies of what they held. Its usage cache
// (`t3-scan-cache.ts`, bound as `$scanCache`) keeps every request of each transcript file it read,
// subagents' included; its database keeps each turn's sum for the sessions it drove, main
// conversations only. Each transcript file counts from the first of these that has it: itself,
// when its id is in `$native`, the ids of the transcript files this scan listed (a main
// conversation's is its session's id); else the cache; else, for a main conversation, T3's turns.
// So a session whose main transcript is gone and whose subagents' remain counts each file once.
// A session the cache fills in takes its project, subagent flag and
// compactions from T3's database when T3 drove it, its project from T3's runtime record of the
// resumed session next, else from a T3 project whose folder Claude would have filed it under. Its
// via is `t3-code` when T3 knows it, as Claude Code's own transcripts name T3's sessions, else
// `unknown`.
//
// From T3's turns, a `claudeAgent` provider thread counts when its `nativeThreadRef.nativeId`, the
// Claude session id that names a transcript file, is in neither; one with no id is skipped. Each
// such provider thread is one session: a T3 thread holds several provider threads after a
// provider switch, and only its Claude ones count.
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
// at about 50 ms on a 40 GB database. The Claude provider threads are filtered once, then reach
// their turns through the index by provider thread: on that database, with ~2,700 listed ids and
// ~750 sessions to backfill, about 1 s when its pages are cached and up to 20 s when they are not.
import type { Place, SqliteStore, StoreFact, StoreRow } from "@loadsheet/kit";
import { trimSlash } from "./inventory.ts";
import { count, modelName, noTokens, projectOfCwd, tokensOf, utcDay } from "./store-facts.ts";
import { claudeCacheFile, reduceScanCache, t3ScanCachePath } from "./t3-scan-cache.ts";

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
/** T3's provider for Claude Code, whose sessions it keeps after their transcripts are gone. */
const CLAUDE = "claudeAgent";
const NATIVE_LIST = NATIVE.map((provider) => `'${provider}'`).join(", ");

const THREAD = `json_extract(t.payload_json, '$.modelSelection.model') AS model,
  coalesce(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd,
  json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL AS subagent`;
const USAGE = (field: string) => `json_extract(pt.payload_json, '$.turnTokenUsage.${field}')`;

const NATIVE_ID = "json_extract(pth.payload_json, '$.nativeThreadRef.nativeId')";

const CACHED = (field: string) => `json_extract(value, '$.${field}') AS ${field}`;
/** How Claude Code names a project's folder under `projects/`: every other character is `-`. */
const FOLDER = (path: string) =>
  ["/", ".", "_", " "].reduce((sql, char) => `replace(${sql}, '${char}', '-')`, path);

// The scan cache's rows for the Claude sessions no listed transcript counts (`t3-scan-cache.ts`).
// The Claude provider threads whose transcript this scan did not list, with their T3 thread's
// project and lineage; `known` holds those the cache fills in, by session, and `gone` the rest,
// which T3's turns fill in. The model is the T3 thread's only while Claude is its provider.
const CLAUDE_CTES = `cached AS MATERIALIZED (SELECT ${["s", "sub", "dir", "day", "start", "model", "u", "c", "w", "w1h", "rw", "o", "r", "n"].map(CACHED).join(", ")}
FROM json_each($scanCache)),
claude AS MATERIALIZED (SELECT ${NATIVE_ID} AS id, pth.provider_thread_id, pth.thread_id, pth.provider,
  coalesce(json_extract(pth.payload_json, '$.createdAt'), t.created_at) AS created,
  CASE WHEN t.default_provider = pth.provider
    THEN json_extract(t.payload_json, '$.modelSelection.model') END AS model,
  coalesce(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd,
  json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL AS subagent
FROM orchestration_v2_projection_provider_threads pth
JOIN orchestration_v2_projection_threads t ON t.thread_id = pth.thread_id
LEFT JOIN projection_projects p ON p.project_id = t.project_id
WHERE pth.provider = '${CLAUDE}' AND ${NATIVE_ID} IS NOT NULL
  AND ${NATIVE_ID} NOT IN (SELECT value FROM json_each($native))),
gone AS MATERIALIZED (SELECT * FROM claude WHERE id NOT IN (SELECT s FROM cached)),
known AS MATERIALIZED (SELECT c.id, min(c.cwd) AS cwd, max(c.subagent) AS subagent,
  sum((SELECT count(*) FROM orchestration_v2_projection_turn_items ti
    WHERE ti.thread_id = c.thread_id AND ti.type = 'compaction'
      AND ti.provider_thread_id = c.provider_thread_id)) AS compactions
FROM claude c WHERE c.id IN (SELECT s FROM cached) GROUP BY c.id),
resumed AS MATERIALIZED (SELECT json_extract(resume_cursor_json, '$.resume') AS id,
  min(json_extract(runtime_payload_json, '$.cwd')) AS cwd
FROM provider_session_runtime
WHERE provider_name = '${CLAUDE}' AND json_valid(resume_cursor_json) AND json_valid(runtime_payload_json)
GROUP BY 1),
folders AS MATERIALIZED (SELECT ${FOLDER("root")} AS dir, min(root) AS cwd
FROM (SELECT workspace_root AS root FROM projection_projects
  UNION SELECT json_extract(payload_json, '$.worktreePath') FROM orchestration_v2_projection_threads)
WHERE root IS NOT NULL GROUP BY 1),
filled AS (SELECT x.*, k.id IS NOT NULL OR r.id IS NOT NULL AS t3,
  coalesce(k.cwd, r.cwd, f.cwd) AS cwd,
  x.sub OR coalesce(k.subagent, 0) AS subagent, k.compactions
FROM cached x LEFT JOIN known k ON k.id = x.s LEFT JOIN resumed r ON r.id = x.s
LEFT JOIN folders f ON f.dir = x.dir
WHERE x.day >= substr($since, 1, 10))`;

// CROSS JOIN keeps the threads as the outer loop, so SQLite filters them by provider first and
// reaches each one's turns through their index by thread.
const QUERY = `WITH ${CLAUDE_CTES}
SELECT 'turn' AS kind, pth.provider AS provider,
  coalesce(pt.completed_at, pt.started_at) AS at, ${THREAD},
  ${USAGE("inputTokens")} AS input, ${USAGE("cachedInputTokens")} AS cacheRead,
  ${USAGE("cacheCreationTokens")} AS cacheWrite, ${USAGE("outputTokens")} AS output,
  ${USAGE("reasoningTokens")} AS reasoning, NULL AS compactions, NULL AS cacheWrite1h,
  NULL AS cacheRewrite, NULL AS requests, 1 AS t3
FROM orchestration_v2_projection_threads t
CROSS JOIN orchestration_v2_projection_provider_turns pt ON pt.thread_id = t.thread_id
JOIN orchestration_v2_projection_provider_threads pth ON pth.provider_thread_id = pt.provider_thread_id
LEFT JOIN projection_projects p ON p.project_id = t.project_id
WHERE t.default_provider NOT IN (${NATIVE_LIST}) AND pth.provider NOT IN (${NATIVE_LIST})
  AND coalesce(pt.completed_at, pt.started_at) >= $since
UNION ALL
SELECT 'thread', t.default_provider, t.created_at, ${THREAD},
  NULL, NULL, NULL, NULL, NULL,
  (SELECT count(*) FROM orchestration_v2_projection_turn_items ti
    WHERE ti.thread_id = t.thread_id AND ti.type = 'compaction'), NULL, NULL, NULL, 1
FROM orchestration_v2_projection_threads t
LEFT JOIN projection_projects p ON p.project_id = t.project_id
WHERE t.default_provider NOT IN (${NATIVE_LIST}) AND t.created_at >= $since
UNION ALL
SELECT 'turn', g.provider, coalesce(pt.completed_at, pt.started_at), g.model, g.cwd, g.subagent,
  ${USAGE("inputTokens")}, ${USAGE("cachedInputTokens")}, ${USAGE("cacheCreationTokens")},
  ${USAGE("outputTokens")}, ${USAGE("reasoningTokens")}, NULL, NULL, NULL, NULL, 1
FROM gone g
CROSS JOIN orchestration_v2_projection_provider_turns pt ON pt.provider_thread_id = g.provider_thread_id
WHERE coalesce(pt.completed_at, pt.started_at) >= $since
UNION ALL
SELECT 'thread', g.provider, g.created, g.model, g.cwd, g.subagent, NULL, NULL, NULL, NULL, NULL,
  (SELECT count(*) FROM orchestration_v2_projection_turn_items ti
    WHERE ti.thread_id = g.thread_id AND ti.type = 'compaction'
      AND ti.provider_thread_id = g.provider_thread_id), NULL, NULL, NULL, 1
FROM gone g
WHERE g.created >= $since
UNION ALL
SELECT CASE WHEN start THEN 'thread' ELSE 'cached' END, '${CLAUDE}', day, model, cwd, subagent,
  u, c, w, o, r, CASE WHEN start AND NOT sub THEN compactions END, w1h, rw, n, t3
FROM filled`;

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
    via: count(row.t3) ? T3_CODE : "unknown",
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
  if (row.kind === "cached") {
    // The cache's own split: input without the cache, the write's hour part and rewrites apart.
    const cacheWrite = count(row.cacheWrite);
    const cacheWrite1h = Math.min(count(row.cacheWrite1h), cacheWrite);
    const output = count(row.output);
    const tokens = {
      input: count(row.input),
      output,
      reasoning: Math.min(count(row.reasoning), output),
      cacheRead: count(row.cacheRead),
      cacheWrite,
      cacheWrite5m: cacheWrite - cacheWrite1h,
      cacheWrite1h,
      cacheRewrite: Math.min(count(row.cacheRewrite), cacheWrite - cacheWrite1h),
    };
    if (noTokens(tokens)) return [];
    const requests = count(row.requests);
    return [{ type: "usage-tokens", ...base, model: modelName(row.model), requests, ...tokens }];
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

/**
 * T3 Code's database, read for the usage of the agents loadsheet has no reader for, and of the
 * Claude Code sessions whose transcripts are gone.
 */
export const t3Code: SqliteStore & { readonly harness: string } = {
  kind: "sqlite",
  harness: T3_CODE,
  name: "statev2.sqlite",
  native: "claude-code",
  supplies: ["claude-code"],
  path: (place) => `${trimSlash(place.home)}/.t3/userdata/statev2.sqlite`,
  inputs: [
    {
      param: "$scanCache",
      path: (place) => t3ScanCachePath(trimSlash(place.home)),
      read: (document, native) =>
        reduceScanCache(document, {
          provider: "claude",
          file: claudeCacheFile,
          native,
          rewrites: true,
        }),
    },
  ],
  query: QUERY,
  since: "iso",
  facts: (rows, place) => rows.flatMap((row) => rowFacts(row, place)),
};

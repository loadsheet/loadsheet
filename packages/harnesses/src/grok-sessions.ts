// Grok's sessions: `<GROK_HOME>/sessions/<percent-encoded cwd>/<id>/`, each with `summary.json`
// (when it started, the model, the folder and its git remotes), `usage.json` (tokens per turn and
// model) and `signals.json` (counters such as `compactionCount`).
//
// Tokens are counted as ccusage counts Grok's: per turn and model, from `modelUsage`, with
// `inputTokens` holding what was read from and written to the cache, and `outputTokens` holding
// the reasoning. A turn's day is the UTC day it ended. `usage.json` gives the same numbers as the
// `turn_completed` events of `updates.jsonl`, which ccusage reads, in a file a hundred times smaller.
import { repoOfRemote, type FolderStore, type Place, type StoreFact } from "@loadsheet/kit";
import { envDir, isRecord, trimSlash } from "./inventory.ts";
import { count, modelName, noTokens, projectOfCwd, tokensOf, utcDay } from "./store-facts.ts";

/** Grok's home: `GROK_HOME`, else `~/.grok`. */
export const grokHome = (place: Place) =>
  envDir(place, "GROK_HOME") ?? `${trimSlash(place.home)}/.grok`;

const json = (text: string | undefined): Record<string, unknown> => {
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};

/**
 * The session's project: the repository its git remotes name when they all name one, else its
 * folder, from `summary.json` or the session folder's encoded name.
 */
const projectOf = (summary: Record<string, unknown>, folder: string, place: Place) => {
  const remotes = Array.isArray(summary.git_remotes) ? summary.git_remotes : [];
  const repos = new Set(
    remotes.flatMap((remote) => {
      const repo = typeof remote === "string" ? repoOfRemote(remote) : undefined;
      return repo ? [repo] : [];
    }),
  );
  if (repos.size === 1) return [...repos][0]!;
  const info = isRecord(summary.info) ? summary.info : {};
  if (typeof info.cwd === "string") return projectOfCwd(info.cwd, place);
  try {
    return projectOfCwd(decodeURIComponent(folder.slice(0, folder.indexOf("/"))), place);
  } catch {
    return "unknown";
  }
};

const sessionFacts = (
  files: Readonly<Record<string, string | undefined>>,
  folder: string,
  place: Place,
): StoreFact[] => {
  const summary = json(files["summary.json"]);
  const usage = json(files["usage.json"]);
  const signals = json(files["signals.json"]);
  const turns = Array.isArray(usage.turns) ? usage.turns.filter(isRecord) : [];
  const day = utcDay(summary.created_at) ?? utcDay(turns[0]?.endedAt);
  if (!day) return [];
  const via =
    typeof summary.session_kind === "string" && /^[a-z][a-z0-9-]*$/u.test(summary.session_kind)
      ? summary.session_kind
      : "cli";
  const base = { day, via, project: projectOf(summary, folder, place), thread: "main" } as const;
  const facts: StoreFact[] = [{ type: "usage-session", ...base }];
  const compactions = count(signals.compactionCount);
  for (let index = 0; index < compactions; index += 1) {
    facts.push({ type: "compaction", ...base, manual: false, first: index === 0 });
  }
  for (const turn of turns) {
    const ended = utcDay(turn.endedAt);
    if (!ended) continue;
    // A turn without `modelUsage` ran one model, named by the turn or else by the session.
    const byModel = isRecord(turn.modelUsage)
      ? Object.entries(turn.modelUsage)
      : [[turn.primaryModelId ?? summary.current_model_id, turn] as const];
    for (const [model, used] of byModel) {
      if (!isRecord(used)) continue;
      const tokens = tokensOf({
        input: count(used.inputTokens),
        cacheRead: count(used.cachedReadTokens),
        cacheWrite: count(used.cacheCreationTokens),
        output: count(used.outputTokens),
        reasoning: count(used.reasoningTokens),
      });
      if (noTokens(tokens)) continue;
      facts.push({
        type: "usage-tokens",
        ...base,
        day: ended,
        model: modelName(model),
        requests: count(used.modelCalls) || 1,
        ...tokens,
      });
    }
  }
  return facts;
};

/** Grok's session folders, read for usage. */
export const grokSessions: FolderStore = {
  kind: "folder",
  name: "grok-sessions",
  root: (place) => `${grokHome(place)}/sessions`,
  depth: 2,
  files: ["usage.json", "summary.json", "signals.json"],
  facts: ({ files, folder }, place) => sessionFacts(files, folder, place),
};

import type { Item, Line, Report, ResolvedConfig } from "@loadsheet/schema";
import { NO_SIGNALS, runRules } from "./engine.ts";
import { estimateTokens } from "./rules/rule.ts";

/** Input for packReport. */
export interface PackReportInput {
  /** What the pack installs, from a harness's inventory. */
  items: Item[];
  /** The harness the pack was weighed for. */
  harness: { id: string };
  /** The GitHub URL or directory name read; never an absolute path. */
  source: string;
  config: ResolvedConfig;
  /** When the report is generated. */
  now: Date;
  /** The tool and version, such as loadsheet@0.0.1. */
  tool: string;
}

const byTokens = (a: Line, b: Line) =>
  b.tokens.value - a.tokens.value || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0);

/** One line of a pack's sheet: what the item adds to every session, with no usage. */
const packLine = (item: Item): Line => {
  const line: Line = {
    item: item.id,
    ref: item.ref,
    scope: item.scope,
    managedBy: item.managedBy,
    machines: [],
    path: item.path,
    chars: item.chars,
    tokens: { value: estimateTokens(item.chars.listed), basis: "estimated" },
    exposure: { sessions: 0, share: 0, bare: 0 },
    use: { byModel: 0, byUser: 0 },
  };
  if (item.pack !== undefined) line.pack = item.pack;
  if (item.description !== undefined) line.description = item.description;
  return line;
};

/** What a pack adds to every session of one harness, and what the rules that need no usage find. */
export const packReport = ({
  items,
  harness,
  source,
  config,
  now,
  tool,
}: PackReportInput): Report => {
  const lines = items.map(packLine).sort(byTokens);
  const today = now.toISOString().slice(0, 10);
  const { findings, skipped } = runRules({
    mode: "pack",
    sheets: [
      {
        harness: harness.id,
        sessions: 0,
        days: 0,
        machines: [],
        sessionsOn: () => 0,
        historyOn: () => 0,
        history: 0,
        signals: NO_SIGNALS,
        lines,
        // The pack's own Items, on no machine: a line holds for none, so only a rule that reads
        // installs by id, such as duplicate, sees them.
        installs: (id) =>
          items.filter((item) => item.id === id).map((item) => ({ machine: "", item })),
        itemsOn: () => [],
        usageOn: () => undefined,
        settingsOn: () => undefined,
      },
    ],
    config,
  });
  return {
    schema: 1,
    tool,
    generatedAt: now.toISOString(),
    mode: "pack",
    source,
    machines: [],
    window: [today, today],
    config,
    coverage: [],
    sheet: [{ harness: harness.id, sessions: 0, lines }],
    findings,
    skipped,
  };
};

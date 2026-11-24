import type {
  Finding,
  Grade,
  Line,
  ResolvedConfig,
  RuleId,
  Signal,
  Skipped,
} from "@loadsheet/schema";
import { RULES } from "@loadsheet/schema";
import { pendingRules, rules } from "./rules/index.ts";
import type { RuleContext } from "./rules/rule.ts";

/** Every signal graded none: what a pack, read without transcripts, can tell. */
export const NO_SIGNALS: Record<Signal, Grade> = {
  listing: "none",
  modelUse: "none",
  userUse: "none",
  instructions: "none",
  mcp: "none",
  tokens: "none",
};

/** Input for one harness's run of the rules. */
export interface RuleInput {
  mode: RuleContext["mode"];
  harness: string;
  lines: Line[];
  signals: Record<Signal, Grade>;
  config: ResolvedConfig;
}

/**
 * Runs every enabled rule on one harness's sheet. A rule that needs a signal graded none is skipped
 * as missing-signal; a disabled rule, or one not written yet whose signals are all there, is left out.
 */
export const runRules = ({ mode, harness, lines, signals, config }: RuleInput) => {
  const findings: Finding[] = [];
  const skipped: Skipped[] = [];
  const ignored = new Set(config.ignore);
  const visible = lines.filter((line) => !ignored.has(line.item));
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  for (const id of RULES as readonly RuleId[]) {
    if (!config.rules[id].enabled) continue;
    const rule = byId.get(id);
    const needs = rule?.needs ?? pendingRules[id] ?? [];
    const missing = needs.filter((signal) => signals[signal] === "none");
    if (missing.length) {
      skipped.push({ rule: id, harness, reason: "missing-signal", missing });
      continue;
    }
    if (!rule) continue;
    findings.push(
      ...rule.run({ mode, harness, lines: visible, signals, options: config.rules[id], config }),
    );
  }
  return { findings, skipped };
};

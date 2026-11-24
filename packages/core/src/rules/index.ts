import type { RuleId, Signal } from "@loadsheet/schema";
import { expensiveDescription } from "./expensive-description.ts";
import type { Rule } from "./rule.ts";

/** The rules that run. Adding one is a file in this folder and a line here. */
export const rules: Rule[] = [expensiveDescription as Rule];

/**
 * The signals each rule not written yet will need, so a report can say why it did not run.
 * A rule moves from here into `rules` when it is written.
 */
export const pendingRules: Partial<Record<RuleId, Signal[]>> = {
  "invisible-skill": ["listing"],
  "dead-skill": ["listing", "modelUse", "userUse"],
  "manual-only": ["modelUse", "userUse"],
  "dead-pack": ["listing", "modelUse", "userUse"],
  duplicate: [],
  "heavy-instructions": [],
  "idle-mcp": ["mcp"],
  "harness-mismatch": ["listing"],
  drift: [],
  "short-history": ["listing"],
};

import type {
  Finding,
  Grade,
  Line,
  ResolvedConfig,
  RuleId,
  RuleOptions,
  Signal,
} from "@loadsheet/schema";

/** What a rule sees: one harness's sheet, what its sources can tell, and the rule's thresholds. */
export interface RuleContext<R extends RuleId = RuleId> {
  /** local, fleet or pack. */
  mode: "local" | "fleet" | "pack";
  /** The harness id. */
  harness: string;
  /** The harness's sheet lines, without ignored items. */
  lines: Line[];
  /** How well each signal is provided for this sheet. */
  signals: Record<Signal, Grade>;
  /** This rule's thresholds. */
  options: RuleOptions[R];
  /** The whole config, for rules that need more than their own thresholds. */
  config: ResolvedConfig;
}

/** A rule: the signals it cannot judge without, and what it finds. One file per rule. */
export interface Rule<R extends RuleId = RuleId> {
  id: R;
  /** Signals the rule needs; it is skipped as missing-signal when any of them is graded none. */
  needs: Signal[];
  run(context: RuleContext<R>): Finding[];
}

/** Declares a rule; it only checks the shape. */
export const defineRule = <R extends RuleId>(rule: Rule<R>): Rule<R> => rule;

/** Tokens estimated from characters, at four characters a token. */
export const estimateTokens = (chars: number) => Math.round(chars / 4);

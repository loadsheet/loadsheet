import type {
  Finding,
  Grade,
  Id,
  ResolvedConfig,
  RuleId,
  Signal,
  Skipped,
  Where,
} from "@loadsheet/schema";
import { RULES } from "@loadsheet/schema";
import { rules } from "./rules/index.ts";
import {
  NOTHING_UNFILTERED,
  type Rule,
  type RuleContext,
  type RuleSheet,
  type Unfiltered,
} from "./rules/rule.ts";

/** Every signal graded none: what a pack, read without transcripts, can tell. */
export const NO_SIGNALS: Record<Signal, Grade> = {
  listing: "none",
  modelUse: "none",
  userUse: "none",
  instructions: "none",
  mcp: "none",
  tokens: "none",
  usage: "none",
  cacheTtl: "none",
  turns: "none",
  hours: "none",
  tools: "none",
  limits: "none",
};

/** Input for one run of the rules over a Report's sheets. */
export interface RuleInput {
  mode: RuleContext["mode"];
  /** Every sheet, ignored items included; the engine leaves those out of what rules see. */
  sheets: RuleSheet[];
  config: ResolvedConfig;
  /** The Scans before any filter; none in pack mode. */
  unfiltered?: Unfiltered;
}

/**
 * Runs every enabled rule once over the sheets that can answer it. A sheet whose harness grades a
 * needed signal none is skipped as missing-signal, one with too little history as not-enough-data;
 * a disabled rule is left out. A fix-level finding whose every machine and harness a cut finding
 * for the same item holds for is dropped, and an item finding whose every place a cut finding for
 * its pack holds for.
 */
export const runRules = ({ mode, sheets, config, unfiltered = NOTHING_UNFILTERED }: RuleInput) => {
  const findings: Finding[] = [];
  const skipped: Skipped[] = [];
  const ignored = new Set(config.ignore);
  const visible = sheets.map((sheet) => ({
    ...sheet,
    lines: sheet.lines.filter((line) => !ignored.has(line.item)),
  }));
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  for (const id of RULES as readonly RuleId[]) {
    if (!config.rules[id].enabled) continue;
    const rule = byId.get(id) as Rule;
    const needs = rule.needs;
    const options = config.rules[id];
    const ready: RuleSheet[] = [];
    for (const sheet of visible) {
      const missing = [
        ...needs.filter((signal) => sheet.signals[signal] === "none"),
        ...(rule.blind?.(sheet, unfiltered) ?? []),
      ];
      if (missing.length) {
        skipped.push({ rule: id, harness: sheet.harness, reason: "missing-signal", missing });
      } else if (rule.enough && !rule.enough(sheet, options, config)) {
        skipped.push({ rule: id, harness: sheet.harness, reason: "not-enough-data" });
      } else ready.push(sheet);
    }
    if (!ready.length) continue;
    findings.push(...rule.run({ mode, sheets: ready, options, config, unfiltered }));
  }
  const place = (item: Id, { machine, harness }: Where) => JSON.stringify([item, machine, harness]);
  const cut = new Set(
    findings
      .filter((finding) => finding.level === "cut" && finding.item !== undefined)
      .flatMap((finding) => finding.where.map((where) => place(finding.item!, where))),
  );
  // A cut for a pack holds for each of its skills where it holds and that machine's install of
  // the skill is the pack's.
  const packed = new Set<string>();
  for (const finding of findings) {
    if (finding.level !== "cut" || finding.pack === undefined || finding.item !== undefined)
      continue;
    for (const where of finding.where) {
      const sheet = visible.find((one) => one.harness === where.harness);
      if (!sheet) continue;
      for (const line of sheet.lines) {
        const installs = sheet
          .installs(line.item)
          .filter(({ machine }) => machine === where.machine);
        if (installs.length && installs.every(({ item }) => item.pack === finding.pack))
          packed.add(place(line.item, where));
      }
    }
  }
  // A finding goes only when a cut covers every place it holds for: a fix-level one by its item's
  // or its pack's cut, a cut by its pack's.
  const covered = (finding: Finding, by: (key: string) => boolean) =>
    finding.item !== undefined &&
    finding.where.length > 0 &&
    finding.where.every((where) => by(place(finding.item!, where)));
  const dropped = (finding: Finding) =>
    finding.level === "fix"
      ? covered(finding, (key) => cut.has(key) || packed.has(key))
      : finding.level === "cut" && covered(finding, (key) => packed.has(key));
  return { findings: findings.filter((finding) => !dropped(finding)), skipped };
};

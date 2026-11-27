import { cacheOff } from "./cache-off.ts";
import { cacheTtl } from "./cache-ttl.ts";
import { deadPack } from "./dead-pack.ts";
import { deadSkill } from "./dead-skill.ts";
import { drift } from "./drift.ts";
import { duplicate } from "./duplicate.ts";
import { expensiveDescription } from "./expensive-description.ts";
import { harnessMismatch } from "./harness-mismatch.ts";
import { heavyInstructions } from "./heavy-instructions.ts";
import { idleMcp } from "./idle-mcp.ts";
import { invisibleSkill } from "./invisible-skill.ts";
import { manualOnly } from "./manual-only.ts";
import type { Rule } from "./rule.ts";
import { shortHistory } from "./short-history.ts";

/** The rules that run. Adding one is a file in this folder and a line here. */
export const rules: Rule[] = [
  invisibleSkill as Rule,
  deadSkill as Rule,
  manualOnly as Rule,
  expensiveDescription as Rule,
  deadPack as Rule,
  duplicate as Rule,
  heavyInstructions as Rule,
  idleMcp as Rule,
  harnessMismatch as Rule,
  drift as Rule,
  shortHistory as Rule,
  cacheTtl as Rule,
  cacheOff as Rule,
];

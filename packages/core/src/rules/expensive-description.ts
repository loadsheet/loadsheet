import type { Fix } from "@loadsheet/schema";
import { defineRule, estimateTokens } from "./rule.ts";

/** A skill whose listing entry is longer than maxChars; shortening it saves the excess in every session. */
export const expensiveDescription = defineRule({
  id: "expensive-description",
  needs: [],
  run: ({ mode, harness, lines, options }) =>
    lines
      .filter((line) => line.ref.kind === "skill" && line.chars.listed > options.maxChars)
      .map((line) => {
        const fix: Fix | undefined = line.path
          ? {
              action: "shorten",
              path: line.path.endsWith(".md") ? line.path : `${line.path}/SKILL.md`,
            }
          : undefined;
        // In pack mode the change goes to the pack's source, so it names no machine.
        const machines = mode === "pack" ? [] : line.machines;
        return {
          id: `expensive-description:${line.item}`,
          rule: "expensive-description" as const,
          level: "fix" as const,
          item: line.item,
          where: machines.map((machine) => ({ machine, harness })),
          evidence: { listedChars: line.chars.listed, maxChars: options.maxChars },
          savesTokens: {
            value: estimateTokens(line.chars.listed - options.maxChars),
            basis: "estimated" as const,
          },
          fixes: !fix
            ? []
            : mode === "pack"
              ? [fix]
              : machines.map((machine) => ({ machine, ...fix })),
        };
      }),
});

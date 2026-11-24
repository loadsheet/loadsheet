import { defineHarness } from "@loadsheet/kit";
import { packInventory } from "./pack.ts";
import type { SkillMd } from "./skill-md.ts";

/**
 * Characters Claude Code's skill listing spends on one entry: the line `- name: description - when_to_use`
 * and its newline. A skill the model may not invoke is left out of the listing.
 */
export const claudeCodeListedChars = (name: string, skill: SkillMd): number => {
  if (skill.disableModelInvocation) return 0;
  let chars = "- ".length + name.length + "\n".length;
  if (skill.description) chars += ": ".length + skill.description.length;
  if (skill.whenToUse) chars += " - ".length + skill.whenToUse.length;
  return chars;
};

/** Claude Code. Its inventory reads a pack for now; step 5 adds the home directory and transcripts. */
export const claudeCode = defineHarness({
  id: "claude-code",
  signals: {
    listing: "exact",
    modelUse: "exact",
    userUse: "exact",
    instructions: "exact",
    mcp: "inferred",
    tokens: "exact",
  },
  inventory: (files) =>
    packInventory(files, { harness: "claude-code", listedChars: claudeCodeListedChars }),
});

import { defineHarness } from "@loadsheet/kit";
import { packInventory } from "./pack.ts";
import type { SkillMd } from "./skill-md.ts";

/** Claude Code cuts the description and when_to_use it lists, together, at this many characters. */
const LISTED_TEXT_CAP = 1536;

/** What Claude Code lists for a skill: its description, or without one the first line of its body. */
export const claudeCodeDescription = (skill: SkillMd): string | undefined =>
  skill.description ?? skill.firstLine;

/**
 * Characters Claude Code's skill listing spends on one entry: the line `- name: description - when_to_use`
 * and its newline. A skill the model may not invoke is left out of the listing.
 */
export const claudeCodeListedChars = (name: string, skill: SkillMd): number => {
  if (skill.disableModelInvocation) return 0;
  const text = [claudeCodeDescription(skill), skill.whenToUse].filter(Boolean).join(" - ");
  const listed = text ? ": ".length + Math.min(text.length, LISTED_TEXT_CAP) : 0;
  return "- ".length + name.length + listed + "\n".length;
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
    packInventory(files, {
      harness: "claude-code",
      description: claudeCodeDescription,
      listedChars: claudeCodeListedChars,
    }),
});

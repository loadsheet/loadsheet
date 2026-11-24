import { claudeCode } from "./claude-code.ts";

export { claudeCode, claudeCodeListedChars } from "./claude-code.ts";
export { packInventory, type PackListing } from "./pack.ts";
export { readSkillMd, type SkillMd } from "./skill-md.ts";

/** Every built-in harness. */
export const harnesses = [claudeCode] as const;

/** The built-in harness with this id. */
export const findHarness = (id: string) => harnesses.find((harness) => harness.id === id);

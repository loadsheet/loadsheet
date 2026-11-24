import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";

export {
  claudeCode,
  claudeCodeAgentChars,
  claudeCodeDescription,
  claudeCodeListedChars,
} from "./claude-code.ts";
export { claudeConfigDir } from "./claude-code-machine.ts";
export { claudeTranscripts, instructionName, type ClaudeState } from "./claude-code-transcripts.ts";
export {
  FLEETRC_MANIFEST,
  readManagers,
  SKILLS_LOCK,
  skillsLockPath,
  type Manager,
} from "./managed.ts";
export { codex, codexDescription, codexListedChars, codexMcpName } from "./codex.ts";
export { readCodexConfig, type CodexConfig } from "./codex-toml.ts";
export { CODEX_INSTRUCTIONS, codexTranscripts, type CodexState } from "./codex-transcripts.ts";
export { packInventory, type PackListing } from "./pack.ts";
export { readSkillMd, type SkillMd } from "./skill-md.ts";

/** Every built-in harness. */
export const harnesses = [claudeCode, codex] as const;

export const findHarness = (id: string) => harnesses.find((harness) => harness.id === id);

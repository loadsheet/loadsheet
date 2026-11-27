import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { gemini } from "./gemini.ts";
import { grok } from "./grok.ts";
import { kiro } from "./kiro.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";
import { t3Code } from "./t3-code.ts";

export {
  claudeCode,
  claudeCodeAgentChars,
  claudeCodeDescription,
  claudeCodeListedChars,
} from "./claude-code.ts";
export { CLAUDE_CODE_RETENTION_DAYS, claudeConfigDir } from "./claude-code-machine.ts";
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
export { cursor } from "./cursor.ts";
export { gemini } from "./gemini.ts";
export { grok } from "./grok.ts";
export { NO_USAGE } from "./inventory.ts";
export { kiro } from "./kiro.ts";
export { opencode } from "./opencode.ts";
export { pi } from "./pi.ts";
export { CODEX_INSTRUCTIONS, codexTranscripts, type CodexState } from "./codex-transcripts.ts";
export { packInventory, type PackListing } from "./pack.ts";
export { readSkillMd, type SkillMd } from "./skill-md.ts";
export { grokSessions } from "./grok-sessions.ts";
export { opencodeDb } from "./opencode-db.ts";
export { T3_CODE, t3Code } from "./t3-code.ts";

/** Every built-in harness. */
export const harnesses = [claudeCode, codex, grok, pi, opencode, cursor, gemini, kiro] as const;

/** Session stores no built-in harness owns: T3 Code's database of the agents it drives. */
export const sessionStores = [t3Code] as const;

export const findHarness = (id: string) => harnesses.find((harness) => harness.id === id);

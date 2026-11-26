import type { McpClientRule } from "../types.ts";
import { chatgptRules } from "./chatgpt.ts";
import { claudeCodeRules } from "./claude-code.ts";
import { claudeDirectoryRules } from "./claude-directory.ts";
import { claudeRules } from "./claude.ts";
import { codexRules } from "./codex.ts";
import { copilotStudioRules } from "./copilot-studio.ts";
import { cursorRules } from "./cursor.ts";
import { geminiCliRules } from "./gemini-cli.ts";
import { vscodeRules } from "./vscode.ts";

/** Every client limit Doctor checks, each with the primary source it was read from. */
export const mcpClientRules: readonly McpClientRule[] = [
  ...claudeCodeRules,
  ...claudeRules,
  ...claudeDirectoryRules,
  ...chatgptRules,
  ...codexRules,
  ...cursorRules,
  ...vscodeRules,
  ...geminiCliRules,
  ...copilotStudioRules,
];

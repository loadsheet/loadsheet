import { defineHarness } from "@loadsheet/kit";
import { claudeCodeDescription, claudeCodeEntryChars } from "./claude-code-listing.ts";
import {
  claudeConfigDir,
  claudeInventory,
  claudeRoots,
  claudeSources,
} from "./claude-code-machine.ts";
import { claudeTranscripts } from "./claude-code-transcripts.ts";
import { packInventory } from "./pack.ts";

export {
  claudeCodeAgentChars,
  claudeCodeDescription,
  claudeCodeListedChars,
} from "./claude-code-listing.ts";

/**
 * Claude Code. Its transcripts name every skill, subagent and instruction file a session listed,
 * with the text it took, so listing, instructions and use are read directly. MCP servers are
 * inferred: a server without instructions is seen only through its deferred tool names, and the
 * characters counted are its instructions and tool names, never tool schemas sent outside the
 * transcript.
 */
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
      listedChars: claudeCodeEntryChars,
    }),
  machine: {
    home: claudeConfigDir,
    sources: claudeSources,
    inventory: claudeInventory,
    roots: claudeRoots,
    transcripts: claudeTranscripts,
  },
});

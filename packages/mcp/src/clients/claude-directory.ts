import type { McpClientRule } from "../types.ts";
import { docs } from "./shared.ts";

const REVIEW = "https://claude.com/docs/connectors/building/review-criteria";
const SUBMISSION = "https://claude.com/docs/connectors/building/submission";
const ANNOTATIONS_QUOTE =
  "Every tool must include a `title` and the applicable hint: `readOnlyHint: true` for read-only tools, and `destructiveHint: true` for tools that modify or delete data.";

export const toolNameLength: McpClientRule = {
  client: "claude-directory",
  rule: "claude-directory/tool-name-length",
  scope: "tool",
  effect: "review",
  severity: "warn",
  confidence: "high",
  source: docs(`${REVIEW}#keep-tool-names-short`, "Tool names must be 64 characters or fewer."),
  check(tool) {
    if (tool.name.length <= 64) return;
    return {
      message: `Directory review requires tool names of 64 characters or fewer; \`${tool.name}\` has ${tool.name.length}.`,
      fix: "Shorten the tool name to 64 characters or fewer.",
      pointer: "/name",
      measured: { value: tool.name.length, limit: 64, unit: "characters" },
    };
  },
};

export const missingTitle: McpClientRule = {
  client: "claude-directory",
  rule: "claude-directory/missing-title",
  scope: "tool",
  effect: "review",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${SUBMISSION}#pre-submission-checklist-for-connectors`,
    "Every tool has a `title` and a `readOnlyHint` or `destructiveHint` annotation: the portal flags tools that are missing them",
    "2026-11-26",
  ),
  // The docs don't say where the title must be, but on 2026-11-06 the portal flagged a server's tools
  // that sent a top-level `title` without `annotations.title`. That is one observation, so a tool with
  // only a top-level title gets medium confidence.
  check(tool) {
    const title = tool.annotations?.title;
    if (typeof title === "string" && title.trim()) return;
    const topLevel = typeof tool.title === "string" && tool.title.trim();
    return {
      message: topLevel
        ? `Directory review asks every tool for a \`title\`, and its portal has flagged tools that set only the top-level \`title\`, as \`${tool.name}\` does.`
        : `Directory review asks every tool for a \`title\`, and its portal flags tools missing one; \`${tool.name}\` has none.`,
      fix: `Set \`annotations.title\` to a human-readable name${topLevel ? `, such as the top-level title ${JSON.stringify(tool.title)}` : ""}.`,
      pointer: "/annotations/title",
      ...(topLevel ? { confidence: "medium" as const } : {}),
    };
  },
};

/**
 * The fix for a tool with neither safety hint true, when its declared hints narrow it down.
 * A tool that declares `readOnlyHint: false` must never be told to set it to true, and an
 * additive tool can't truthfully set either hint to true.
 */
export function declaredHintFix(hints: {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
}): string | undefined {
  if (hints.readOnlyHint !== false) return;
  if (hints.destructiveHint === false)
    return "The tool declares `readOnlyHint: false` and `destructiveHint: false`, which MCP uses for tools that only add data. Keep them if that is accurate and expect the Connectors Directory review to flag the tool, since it asks for one hint to be true. If the tool can modify or delete data, set `destructiveHint: true`.";
  return "Add `destructiveHint: true` to the annotations if the tool can modify or delete data, which the Connectors Directory asks for. The tool declares `readOnlyHint: false`, so marking it read-only is not the fix. If it only adds data, `destructiveHint: false` is the accurate MCP hint, though the Directory review still asks for one hint to be true.";
}

export const missingHint: McpClientRule = {
  client: "claude-directory",
  rule: "claude-directory/missing-hint",
  scope: "tool",
  effect: "review",
  severity: "warn",
  confidence: "high",
  source: docs(`${REVIEW}#provide-tool-annotations`, ANNOTATIONS_QUOTE),
  check(tool) {
    const annotations = tool.annotations ?? {};
    if (annotations.readOnlyHint === true || annotations.destructiveHint === true) return;
    return {
      message: `Directory review requires \`readOnlyHint: true\` or \`destructiveHint: true\` on every tool; \`${tool.name}\` has neither.`,
      fix:
        declaredHintFix(annotations) ??
        "Set `annotations.readOnlyHint: true` on read-only tools and `annotations.destructiveHint: true` on tools that modify or delete data.",
      pointer: "/annotations",
    };
  },
};

export const claudeDirectoryRules: McpClientRule[] = [toolNameLength, missingTitle, missingHint];

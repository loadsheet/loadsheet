import type { McpClientRule } from "../types.ts";
import { docs } from "./shared.ts";

export const missingReadOnlyHint: McpClientRule = {
  client: "chatgpt",
  rule: "chatgpt/missing-read-only-hint",
  scope: "tool",
  effect: "review",
  // Under the default plugin permission, "Allow low-risk tools", ChatGPT ran such tools without
  // asking on 2026-11-26; it asked only under "Allow read-only tools". The docs still say write
  // actions need confirmation by default, so they back only the read-only detection.
  severity: "info",
  confidence: "medium",
  source: docs(
    "https://developers.openai.com/api/docs/guides/developer-mode",
    "Read-only detection: We respect the `readOnlyHint` tool annotation (see MCP tool annotations). Tools without this hint are treated as write actions.",
    "2026-11-26",
  ),
  // A tool that declares itself destructive should be confirmed, so the prompt is correct there.
  check(tool) {
    if (typeof tool.annotations?.readOnlyHint === "boolean") return;
    if (tool.annotations?.destructiveHint === true) return;
    return {
      message: `ChatGPT doesn't treat \`${tool.name}\` as read-only because it has no \`readOnlyHint\`, so users who set the plugin's permissions to "Allow read-only tools" must confirm every call.`,
      fix: "Set `annotations.readOnlyHint` to `true` on tools that only read, and to `false` on the rest.",
      pointer: "/annotations/readOnlyHint",
    };
  },
};

export const chatgptRules: McpClientRule[] = [missingReadOnlyHint];

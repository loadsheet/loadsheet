import { isSchema } from "../schema.ts";
import type { McpClientRule, McpToolResult } from "../types.ts";
import { declaresDraft2020OrNothing, draft2020Errors } from "../validate.ts";
import { assumedNote, docs, hasImage, serverName, source, textLength } from "./shared.ts";

const DOCS = "https://code.claude.com/docs/en/mcp";
// Claude Code ships minified; these claims were measured against this release.
const RELEASE = "https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.332";
const MCP_SDK =
  "https://github.com/modelcontextprotocol/typescript-sdk/blob/3b73021a0a2272c0c04c3917bcdb03398b3ec63f/src/types.ts";
const OBSERVED = "2026-11-26";
const DESCRIPTION_LIMIT = 4_096;
const DEFERRED_DESCRIPTION_LIMIT = 16_384;
const RESULT_CHARS = 50_000;
const RESULT_CHARS_CEILING = 500_000;
const ERROR_CHARS = 11_024;
const ERROR_KEPT = 5_000;
const TOKEN_WARNING = 10_000;
const IMAGE_TOKENS = 1_600;
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export const toolNameLength: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/tool-name-length",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    `${DOCS}#tools-with-names-longer-than-128-characters`,
    "Claude Code leaves an MCP tool out of the tools it sends to Claude when its full name is over 128 characters.",
  ),
  check(tool, context) {
    const server = serverName(context);
    const length = `mcp__${server.name}__${tool.name}`.length;
    if (length <= 128) return;
    return {
      message: `Claude Code leaves \`${tool.name}\` out of the tools it sends to Claude: its full name \`mcp__<server>__${tool.name}\` is ${length} characters${assumedNote(server)}, over 128.`,
      fix: "Shorten the tool name so `mcp__<server>__<tool>` stays within 128 characters.",
      pointer: "/name",
      measured: { value: length, limit: 128, unit: "characters" },
    };
  },
};

export const propertyName: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/property-name",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    `${DOCS}#tools-with-invalid-input-schemas`,
    "Top-level property names must be 1 to 64 characters long and use only ASCII letters and digits, `_`, `.`, and `-`",
  ),
  check(tool) {
    const properties = tool.inputSchema?.properties;
    if (!isSchema(properties)) return;
    return Object.keys(properties)
      .filter((name) => !PROPERTY_NAME.test(name))
      .map((name) => ({
        message: `Claude Code excludes \`${tool.name}\`: the top-level property name ${JSON.stringify(name)} is not 1 to 64 ASCII letters, digits, \`_\`, \`.\` or \`-\`.`,
        fix: "Rename the property to 1 to 64 characters from `A-Z`, `a-z`, `0-9`, `_`, `.` and `-`.",
        pointer: `/inputSchema/properties/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      }));
  },
};

export const schemaDraft2020: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/schema-draft-2020-12",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    `${DOCS}#tools-with-invalid-input-schemas`,
    "The schema must be valid against the JSON Schema draft 2020-12 meta-schema. Claude Code applies this check to schemas that declare no `$schema` and schemas that declare draft 2020-12.",
  ),
  check(tool) {
    const schema = tool.inputSchema;
    if (!isSchema(schema) || !declaresDraft2020OrNothing(schema)) return;
    const errors = draft2020Errors(schema);
    if (!errors.length) return;
    return {
      message: `Claude Code excludes \`${tool.name}\`: its input schema is invalid against the JSON Schema draft 2020-12 meta-schema (${errors.slice(0, 3).join("; ")}).`,
      fix: "Make the input schema valid draft 2020-12, for example `items` takes one schema and tuples use `prefixItems`.",
      pointer: "/inputSchema",
    };
  },
};

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"];

function rootCombinators(schema: Record<string, unknown>): string[] {
  return ROOT_COMBINATORS.filter((keyword) => keyword in schema);
}

export const rootCombinatorWithoutType: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/root-combinator-without-type",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: source(
    `${MCP_SDK}#L1389-L1393`,
    "* Must have type: 'object' at the root level per MCP spec.\n     */\n    inputSchema: z\n        .object({\n            type: z.literal('object'),",
    OBSERVED,
  ),
  check(tool) {
    const schema = tool.inputSchema;
    if (!isSchema(schema) || schema.type === "object") return;
    const keywords = rootCombinators(schema);
    if (!keywords.length) return;
    return {
      message: `Claude Code fails to list this server's tools, so none of them load: the input schema of \`${tool.name}\` has a root \`${keywords.join("`, `")}\` without \`type: "object"\`, and the MCP SDK rejects the whole \`tools/list\` result.`,
      fix: 'Add `type: "object"` at the root of the input schema.',
      pointer: "/inputSchema",
      affectedPointers: keywords.map((keyword) => `/inputSchema/${keyword}`),
    };
  },
};

export const rootCombinator: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/root-combinator",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: docs(
    `${DOCS}#tool-input-schemas-with-a-root-level-combinator`,
    "Before sending the tool to the API, Claude Code flattens the schema into a single object and prepends a sentence to the tool's description that tells Claude which parameter groups belong together",
    OBSERVED,
  ),
  check(tool) {
    const schema = tool.inputSchema;
    if (!isSchema(schema) || schema.type !== "object") return;
    const keywords = rootCombinators(schema);
    if (!keywords.length) return;
    return {
      message: `Claude Code flattens the root \`${keywords.join("`, `")}\` of \`${tool.name}\` into the schema's properties and adds an "Input constraint: …" line to its description that states the branches in prose.`,
      fix: "Declare one root object schema and keep combinators inside `properties`.",
      pointer: `/inputSchema/${keywords[0]}`,
      affectedPointers: keywords.map((keyword) => `/inputSchema/${keyword}`),
    };
  },
};

export const descriptionLength: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/description-length",
  scope: "tool",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#tool-search-for-mcp-server-authors`,
    "Server instructions, and the description of a tool that loads upfront: 4,096 characters",
  ),
  check(tool) {
    const length = tool.description?.length ?? 0;
    if (length <= DESCRIPTION_LIMIT) return;
    const deferred =
      length > DEFERRED_DESCRIPTION_LIMIT
        ? `, and at 16,384 when it loads through tool search`
        : `; through tool search it keeps up to 16,384, but search matches only the first 4,096`;
    return {
      message: `Claude Code cuts the description of \`${tool.name}\` (${length} characters) at 4,096 characters when the tool loads upfront${deferred}.`,
      fix: "Keep the description within 4,096 characters and put the words Claude searches for near the start.",
      pointer: "/description",
      measured: { value: length, limit: DESCRIPTION_LIMIT, unit: "characters" },
    };
  },
};

export const instructionsLength: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/instructions-length",
  scope: "server",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#tool-search-for-mcp-server-authors`,
    "Server instructions, and the description of a tool that loads upfront: 4,096 characters",
  ),
  check(list) {
    const length = list.initialize?.instructions?.length ?? 0;
    if (length <= DESCRIPTION_LIMIT) return;
    return {
      message: `Claude Code cuts the server instructions (${length} characters) at 4,096 characters, and Claude sees only the text before the cut.`,
      fix: "Keep the instructions within 4,096 characters, with the critical details first.",
      pointer: "/initialize/instructions",
      measured: { value: length, limit: DESCRIPTION_LIMIT, unit: "characters" },
    };
  },
};

export const missingInstructions: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/missing-instructions",
  scope: "server",
  effect: "context",
  severity: "info",
  confidence: "high",
  source: docs(
    `${DOCS}#scale-with-mcp-tool-search`,
    "Only tool names and server instructions load at session start",
  ),
  check(list) {
    if (!list.initialize || list.initialize.instructions?.trim()) return;
    return {
      message:
        "The server sends no instructions, so with tool search Claude Code shows Claude only the tool names until it searches.",
      fix: "Return `instructions` from `initialize` saying what tasks the tools handle and when to search for them.",
      pointer: "/initialize/instructions",
    };
  },
};

export const resultSavedToFile: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/result-saved-to-file",
  scope: "result",
  effect: "context",
  severity: "warn",
  confidence: "high",
  // A declared limit below 50,000 lowers the threshold too: a declared 20,000 saved a 30,000-character result.
  source: source(
    RELEASE,
    "function l3(e,n,r=mw,o=!1){if(!Number.isFinite(n))return n;if(o)return Math.min(n,r);",
    OBSERVED,
  ),
  check(result, context) {
    if (result.isError || hasImage(result)) return;
    const declared = context.tool?._meta?.["anthropic/maxResultSizeChars"];
    const honored = typeof declared === "number" && Number.isFinite(declared) && declared > 0;
    const limit = honored ? Math.min(declared, RESULT_CHARS_CEILING) : RESULT_CHARS;
    const length = textLength(result);
    if (length <= limit) return;
    const over = honored
      ? `the tool's \`anthropic/maxResultSizeChars\` of ${limit.toLocaleString("en-US")}`
      : `${limit.toLocaleString("en-US")} characters`;
    return {
      message: `Claude Code saves this ${length}-character result to a file and gives Claude only the path, since it is over ${over}.`,
      fix:
        limit < RESULT_CHARS_CEILING
          ? `Return less text, paginate, or ${honored ? "raise" : "set"} \`_meta["anthropic/maxResultSizeChars"]\` on the tool (up to 500,000).`
          : "Return less text or paginate.",
      pointer: "/content",
      measured: { value: length, limit, unit: "characters" },
    };
  },
};

export const errorResultTruncated: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/error-result-truncated",
  scope: "result",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#mcp-output-limits-and-warnings`,
    "Error text longer than about 11,000 characters keeps only its first 5,000 and last 5,000 characters, with a marker between them that says how many characters were removed",
    OBSERVED,
  ),
  check(result) {
    if (!result.isError) return;
    const length = textLength(result);
    if (length <= ERROR_CHARS) return;
    return {
      message: `Claude Code keeps the first 5,000 and last 5,000 characters of this ${length}-character error, with a \`... [${length - 2 * ERROR_KEPT} characters truncated] ...\` marker between them.`,
      fix: "Put the cause and the next step in the first 5,000 characters of the error text.",
      pointer: "/content",
      measured: { value: length, limit: ERROR_CHARS, unit: "characters" },
    };
  },
};

/** Claude Code's estimate: a quarter of each text item's length, rounded, and 1,600 per image. */
function estimatedTokens(result: McpToolResult): number {
  let tokens = 0;
  for (const item of result.content ?? []) {
    if (item?.type === "text" && typeof item.text === "string")
      tokens += Math.round(item.text.length / 4);
    else if (item?.type === "image") tokens += IMAGE_TOKENS;
  }
  return tokens;
}

export const resultTokenWarning: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/result-token-warning",
  scope: "result",
  effect: "context",
  severity: "info",
  confidence: "high",
  source: source(RELEASE, "var y=0.5,B=4,h=1600,E=25000;", OBSERVED),
  check(result) {
    const tokens = estimatedTokens(result);
    if (tokens <= TOKEN_WARNING) return;
    return {
      message: `Claude Code estimates this result at ${tokens} tokens (characters ÷ 4, plus 1,600 per image) and, since that is over 10,000, shows a warning in its transcript UI. Claude doesn't see the warning.`,
      fix: "Return less text or paginate.",
      pointer: "/content",
      measured: { value: tokens, limit: TOKEN_WARNING, unit: "tokens" },
    };
  },
};

export const claudeCodeRules: McpClientRule[] = [
  toolNameLength,
  propertyName,
  schemaDraft2020,
  rootCombinatorWithoutType,
  rootCombinator,
  descriptionLength,
  instructionsLength,
  missingInstructions,
  resultSavedToFile,
  errorResultTruncated,
  resultTokenWarning,
];

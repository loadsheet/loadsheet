// The policy that turned a real Claude Code session into session.jsonl:
// pnpm --filter @loadsheet/fixtures sanitize <in.jsonl> session.jsonl --policy policy.ts
// It keeps the line types, timestamps, entrypoint, version, token counts and the shape of every
// listing, renames skills, plugins, subagents, MCP servers and paths, and replaces all text with
// canary text of its length. usage.jsonl and usage-agent.jsonl came from one session and one of its
// subagents, sanitized as one file so they share pseudonyms; session.jsonl predates the rules for
// usage (cache splits, message ids, cwd, compactions), so it has those under `key-N` names.
import {
  CANARY,
  canaryText,
  pathPseudonym,
  type Policy,
  type SanitizeContext,
} from "@loadsheet/fixtures";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Subagents every Claude Code ships; their names are public. */
const BUILT_IN_AGENTS = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "output-style-setup",
]);

type Pseudonym = SanitizeContext["pseudonym"];

/** `pack:name` keeps its colon: both halves are renamed. */
const scoped = (kind: string, name: string, pseudonym: Pseudonym) => {
  const colon = name.indexOf(":");
  return colon === -1
    ? pseudonym(kind, name)
    : `${pseudonym("pack", name.slice(0, colon))}:${pseudonym(kind, name.slice(colon + 1))}`;
};
const skill = (name: string, pseudonym: Pseudonym) => scoped("skill", name, pseudonym);
const agent = (name: string, pseudonym: Pseudonym) =>
  BUILT_IN_AGENTS.has(name) ? name : scoped("agent", name, pseudonym);
const server = (name: string, pseudonym: Pseudonym) => pseudonym("server", name);
/** `mcp__server__tool` keeps its shape; Claude Code's own tool names are public. */
const tool = (name: string, pseudonym: Pseudonym) => {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match ? `mcp__${server(match[1]!, pseudonym)}__${pseudonym("tool", match[2]!)}` : name;
};

/** `- name: description` with the name renamed and the description replaced by canary text. */
const entry = (line: string, name: string, renamed: string) => {
  const rest = line.slice(`- ${name}`.length);
  return rest.startsWith(": ")
    ? `- ${renamed}: ${canaryText(rest.length - 2)}`
    : `- ${renamed}${canaryText(rest.length)}`;
};

/** The skill listing: entries split at each name, in the order `names` gives. */
const skillContent = (content: string, names: readonly string[], pseudonym: Pseudonym) => {
  const starts: { name: string; at: number }[] = [];
  let cursor = 0;
  for (const name of names) {
    const needle = `- ${name}`;
    const at =
      cursor === 0 && content.startsWith(needle) ? 0 : content.indexOf(`\n${needle}`, cursor) + 1;
    if (at === 0 && !(cursor === 0 && content.startsWith(needle))) continue;
    const after = content[at + needle.length];
    if (after !== undefined && after !== ":" && after !== "\n") continue;
    starts.push({ name, at });
    cursor = at + needle.length;
  }
  return starts
    .map(({ name, at }, index) => {
      const end = starts[index + 1]?.at ?? content.length + 1;
      return entry(content.slice(at, end - 1), name, skill(name, pseudonym));
    })
    .join("\n");
};

const instructionPath = pathPseudonym({
  keep: ["CLAUDE.md", "AGENTS.md", ".claude", "memory", "MEMORY.md", "rules"],
}) as (value: unknown, context: SanitizeContext) => unknown;

const attachment = (value: unknown, context: SanitizeContext): unknown => {
  const { pseudonym } = context;
  if (!isRecord(value)) return CANARY;
  switch (value.type) {
    case "skill_listing": {
      const names = strings(value.names);
      return {
        type: value.type,
        isInitial: value.isInitial,
        skillCount: value.skillCount,
        names: names.map((name) => skill(name, pseudonym)),
        content: skillContent(
          typeof value.content === "string" ? value.content : "",
          names,
          pseudonym,
        ),
      };
    }
    case "agent_listing_delta": {
      const added = strings(value.addedTypes);
      return {
        type: value.type,
        isInitial: value.isInitial,
        addedTypes: added.map((name) => agent(name, pseudonym)),
        addedLines: strings(value.addedLines).map((line) => {
          const name = added.find(
            (type) => line.startsWith(`- ${type}: `) || line.startsWith(`- ${type} (`),
          );
          return name === undefined
            ? canaryText(line.length)
            : entry(line, name, agent(name, pseudonym));
        }),
        builtInTypes: strings(value.builtInTypes).map((name) => agent(name, pseudonym)),
        builtInPluginTypes: strings(value.builtInPluginTypes).map((name) => agent(name, pseudonym)),
        removedTypes: strings(value.removedTypes).map((name) => agent(name, pseudonym)),
      };
    }
    case "mcp_instructions_delta":
      return {
        type: value.type,
        addedNames: strings(value.addedNames).map((name) => server(name, pseudonym)),
        addedBlocks: strings(value.addedBlocks).map((block) => canaryText(block.length)),
        removedNames: strings(value.removedNames).map((name) => server(name, pseudonym)),
      };
    case "deferred_tools_delta":
      return {
        type: value.type,
        addedNames: strings(value.addedNames).map((name) => tool(name, pseudonym)),
        addedLines: strings(value.addedLines).map((line) => canaryText(line.length)),
        removedNames: strings(value.removedNames).map((name) => tool(name, pseudonym)),
      };
    case "instructions":
      return {
        type: value.type,
        files: (Array.isArray(value.files) ? value.files : []).filter(isRecord).map((file) => ({
          path: instructionPath(file.path, context),
          type: file.type,
          content: typeof file.content === "string" ? canaryText(file.content.length) : CANARY,
        })),
      };
    default:
      return { type: typeof value.type === "string" ? value.type : CANARY, rest: CANARY };
  }
};

/** A slash command's line, with its name renamed and its arguments dropped. */
const command = (value: unknown, { pseudonym }: SanitizeContext) => {
  if (typeof value !== "string") return CANARY;
  const match =
    /^\s*<command-message>[^<]*<\/command-message>\s*<command-name>\/?([^<]+)<\/command-name>/u.exec(
      value,
    );
  if (!match) return CANARY;
  const name = skill(match[1]!.trim(), pseudonym);
  return `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`;
};

const folder = pathPseudonym() as (value: unknown, context: SanitizeContext) => unknown;
/** The working directory, renamed folder by folder under a home that names no one. */
const cwd = (value: unknown, context: SanitizeContext) => {
  const renamed = folder(value, context);
  return typeof renamed === "string" && renamed.startsWith("~")
    ? `/home/user${renamed.slice(1)}`
    : CANARY;
};

const toolInput = (value: unknown, { pseudonym }: SanitizeContext) => {
  if (!isRecord(value)) return CANARY;
  return {
    ...(typeof value.skill === "string" ? { skill: skill(value.skill, pseudonym) } : {}),
    ...(typeof value.subagent_type === "string"
      ? { subagent_type: agent(value.subagent_type, pseudonym) }
      : {}),
    rest: CANARY,
  };
};

const policy: Policy = {
  rules: {
    type: "keep",
    operation: "keep",
    timestamp: "keep",
    entrypoint: "keep",
    version: "keep",
    attachment,
    "message.role": "keep",
    "message.model": "keep",
    "message.content": (value, context) =>
      typeof value === "string"
        ? command(value, context)
        : context.sanitize(value, ["message", "body"]),
    "message.body.*.type": "keep",
    "message.body.*.name": (value, { pseudonym }) =>
      typeof value === "string" ? tool(value, pseudonym) : CANARY,
    "message.body.*.input": toolInput,
    "message.usage.input_tokens": "keep",
    "message.usage.cache_creation_input_tokens": "keep",
    "message.usage.cache_read_input_tokens": "keep",
    "message.usage.output_tokens": "keep",
    "message.usage.output_tokens_details.thinking_tokens": "keep",
    "message.usage.cache_creation.ephemeral_5m_input_tokens": "keep",
    "message.usage.cache_creation.ephemeral_1h_input_tokens": "keep",
    "message.id": { pseudonym: "msg" },
    cwd,
    subtype: "keep",
    "compactMetadata.trigger": "keep",
  },
  keys: ["parentUuid", "logicalParentUuid", "isSidechain", "isMeta", "content"],
};

export default policy;

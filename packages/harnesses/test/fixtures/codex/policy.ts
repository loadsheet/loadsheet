// Sanitize policy for Codex rollout transcripts:
// pnpm --filter @loadsheet/fixtures sanitize <rollout.jsonl> <out.jsonl> --policy <this file>
// It keeps what the Codex reader parses (line types, the skills section's shape, the AGENTS.md
// fragment's shape, MCP namespaces, SKILL.md paths in tool calls, token counts) with every name,
// path and text replaced: descriptions and instructions by canary text of the same length.
import { CANARY, canaryText, type Action, type Policy } from "@loadsheet/fixtures";

type Pseudonym = (kind: string, input: string) => string;

/** Skill names that ship with Codex, public enough to keep. */
const PUBLIC_SKILLS = new Set(["imagegen", "openai-docs", "skill-creator", "skill-installer"]);
/** MCP namespaces that are product names. */
const PUBLIC_SERVERS = new Set(["executor", "t3_code"]);
const KEPT_SEGMENTS = new Set([
  "",
  ".",
  "..",
  ".agents",
  ".codex",
  ".system",
  "skills",
  "plugins",
  "cache",
  "SKILL.md",
]);
const PROJECT_DOC = "\n\n--- project-doc ---\n\n";

const skillName = (name: string, pseudonym: Pseudonym) =>
  PUBLIC_SKILLS.has(name) ? name : pseudonym("skill", name);

/** `plugin:skill` or `skill`, each part replaced. */
const qualifiedName = (name: string, pseudonym: Pseudonym) => {
  const colon = name.indexOf(":");
  if (colon === -1) return skillName(name, pseudonym);
  return `${pseudonym("plugin", name.slice(0, colon))}:${skillName(name.slice(colon + 1), pseudonym)}`;
};

/**
 * A path, home becoming `~`: the folder holding a SKILL.md takes the skill's pseudonym, the folder
 * after `plugins/cache/<marketplace>/` the plugin's, version folders stay, the rest become `dir-N`.
 */
const mapPath = (path: string, pseudonym: Pseudonym): string => {
  const home = /^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root|~)(?=\/|$)/u.exec(path);
  const segments = (home ? path.slice(home[0].length) : path).split("/");
  const cache = segments.indexOf("cache");
  const mapped = segments.map((segment, index) => {
    if (KEPT_SEGMENTS.has(segment) || /^\d+(?:\.\d+)*$/u.test(segment)) return segment;
    if (segments[index + 1] === "SKILL.md") return skillName(segment, pseudonym);
    if (cache !== -1 && segments[cache - 1] === "plugins" && index === cache + 2) {
      return pseudonym("plugin", segment);
    }
    if (index === segments.length - 1) return pseudonym("file", segment);
    return pseudonym("dir", segment);
  });
  return (home ? "~" : "") + mapped.join("/");
};

/** `a/{b,c}/d` as `a/b/d` and `a/c/d`. */
const expandBraces = (path: string): string[] => {
  const match = /\{([^{}]*)\}/u.exec(path);
  if (!match) return [path];
  const head = path.slice(0, match.index);
  const tail = path.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((part) => expandBraces(head + part + tail));
};

const SKILL_LINE =
  /^- (.+?): (?:(.*) )?\((file|executor package|cloud package|custom resource): (.+)\)$/u;
const ROOT_LINE = /^- `(r\d+)` = `(.+)`$/u;
const OMITTED = /^- \d+ additional skills? omitted from this bounded skills list\.$/u;

/** The skills section with its frame kept and each line's parts replaced; any other line is canary text. */
const listing = (text: string, pseudonym: Pseudonym): string =>
  text
    .split("\n")
    .map((line) => {
      const root = ROOT_LINE.exec(line);
      if (root) return `- \`${root[1]}\` = \`${mapPath(root[2]!, pseudonym)}\``;
      const skill = SKILL_LINE.exec(line);
      if (skill) {
        const [, name, description, kind, locator] = skill;
        const slash = locator!.indexOf("/");
        const alias = /^r\d+$/u.test(locator!.slice(0, slash)) ? locator!.slice(0, slash + 1) : "";
        const rest = mapPath(locator!.slice(alias.length), pseudonym);
        const text = description ? `${canaryText(description.length)} ` : "";
        return `- ${qualifiedName(name!, pseudonym)}: ${text}(${kind}: ${alias}${rest})`;
      }
      if (OMITTED.test(line) || /^<\/?skills_instructions>$|^#{2,3} /u.test(line) || line === "") {
        return line;
      }
      return canaryText(line.length);
    })
    .join("\n");

/** The inner text of an AGENTS.md fragment: the user's part and the project docs' part as canary text. */
const instructions = (text: string): string => {
  const separator = text.indexOf(PROJECT_DOC);
  if (separator === -1) return canaryText(text.length);
  return (
    canaryText(separator) + PROJECT_DOC + canaryText(text.length - separator - PROJECT_DOC.length)
  );
};

const agentsFragment = (text: string, pseudonym: Pseudonym): string => {
  const header = /^# AGENTS\.md instructions(?: for ([^\n]*))?\n\n<INSTRUCTIONS>\n/u.exec(text);
  const close = text.lastIndexOf("\n</INSTRUCTIONS>");
  if (!header || close < header[0].length) return CANARY;
  const directory = header[1] === undefined ? "" : ` for ${mapPath(header[1], pseudonym)}`;
  const inner = instructions(text.slice(header[0].length, close));
  return `# AGENTS.md instructions${directory}\n\n<INSTRUCTIONS>\n${inner}${text.slice(close)}`;
};

const serverLine = (line: string) => {
  const match = /^- mcp__([^:\s]+)(?:: (.*))?$/u.exec(line);
  if (!match || !PUBLIC_SERVERS.has(match[1]!)) return line.startsWith("- ") ? CANARY : line;
  return `- mcp__${match[1]}${match[2] === undefined ? "" : `: ${canaryText(match[2].length)}`}`;
};

const messageText: Action = (value, { pseudonym }) => {
  if (typeof value !== "string") return CANARY;
  if (value.startsWith("<skills_instructions>")) return listing(value, pseudonym);
  if (value.startsWith("# AGENTS.md instructions")) return agentsFragment(value, pseudonym);
  if (value.startsWith("<tools>\n")) return value.split("\n").map(serverLine).join("\n");
  const skill = /^<skill>\n<name>([^<\n]+)<\/name>/u.exec(value);
  if (skill) return `<skill>\n<name>${qualifiedName(skill[1]!, pseudonym)}</name>\n${CANARY}`;
  return CANARY;
};

/** A tool call's code or arguments: only the SKILL.md paths and MCP names it mentions survive. */
const toolInput: Action = (value, { pseudonym }) => {
  if (typeof value !== "string") return CANARY;
  const kept = [
    ...[...value.matchAll(/[^\s"'`()<>;|&=\\]*SKILL\.md/gu)].flatMap((match) =>
      expandBraces(match[0]).map((path) => mapPath(path, pseudonym)),
    ),
    ...[...value.matchAll(/\bmcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_]+)/gu)]
      .filter((match) => PUBLIC_SERVERS.has(match[1]!))
      .map((match) => `mcp__${match[1]}__${pseudonym("tool", match[2]!)}`),
  ];
  return [CANARY, ...kept].join(" ");
};

const worldTools: Action = (value) => {
  if (typeof value !== "object" || value === null) return CANARY;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      key.startsWith("mcp__") && PUBLIC_SERVERS.has(key.slice(5))
        ? [[key, typeof item === "string" ? canaryText(item.length) : CANARY]]
        : [],
    ),
  );
};

const policy: Policy = {
  keys: [
    "type",
    "payload",
    "timestamp",
    "role",
    "content",
    "text",
    "name",
    "input",
    "arguments",
    // A token usage's counters, wherever it sits.
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ],
  rules: {
    type: "keep",
    timestamp: "keep",
    "payload.type": "keep",
    "payload.role": "keep",
    // Tool names (`exec`, `apply_patch`, `mcp__…`); anything longer or with spaces could be a title.
    "payload.name": (value) =>
      typeof value === "string" && /^[a-z_]{1,32}$/u.test(value) ? value : CANARY,
    "payload.timestamp": "keep",
    "payload.originator": "keep",
    "payload.cli_version": "keep",
    "payload.source": (value) => (typeof value === "string" ? value : { subagent: CANARY }),
    "payload.content.*.type": "keep",
    "payload.content.*.text": messageText,
    "payload.input": toolInput,
    "payload.arguments": toolInput,
    "payload.namespace": (value) =>
      typeof value === "string" && PUBLIC_SERVERS.has(value.replace(/^mcp__/u, ""))
        ? value
        : CANARY,
    "payload.info.last_token_usage.*": "keep",
    "payload.info.total_token_usage.*": "keep",
    "payload.info.model_context_window": "keep",
    // A model name such as `gpt-6`; anything else could be text.
    "payload.model": (value) =>
      typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : CANARY,
    "payload.thread_source": (value) => (value === "subagent" ? value : CANARY),
    "payload.forked_from_id": { pseudonym: "thread" },
    // Under a made-up home, so the folder still reads as absolute.
    "payload.cwd": (value, { pseudonym }) =>
      typeof value === "string"
        ? mapPath(value, pseudonym).replace(/^~(?=\/|$)/u, "/home/u")
        : CANARY,
    // A remote of the same shape, so the reader still names the project `owner/repo`.
    "payload.git.repository_url": (value, { pseudonym }) =>
      typeof value === "string"
        ? `https://git.example/${pseudonym("owner", value)}/${pseudonym("repo", value)}.git`
        : CANARY,
    // A compaction's summary and the history it replaced.
    "payload.message": "opaque",
    "payload.replacement_history": "opaque",
    "payload.state.host_skills.body": (value, { pseudonym }) =>
      typeof value === "string" ? listing(value, pseudonym) : CANARY,
    "payload.state.agents_md.text": (value) =>
      typeof value === "string" ? instructions(value) : CANARY,
    "payload.state.agents_md.directory": (value, { pseudonym }) =>
      typeof value === "string" && value ? mapPath(value, pseudonym) : value,
    "payload.state.tools": worldTools,
    // Of a world_state, only the parts the reader parses; the rest is dropped.
    "payload.state": (value, { path, sanitize }) =>
      Object.fromEntries(
        ["host_skills", "agents_md", "tools"].flatMap((key) => {
          const part = (value as Record<string, unknown> | null)?.[key];
          return part === undefined ? [] : [[key, sanitize(part, [...path, key])]];
        }),
      ),
    "payload.base_instructions": "opaque",
  },
};

export default policy;

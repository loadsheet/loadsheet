// How Claude Code's JSONL transcript lines become Facts. Line shapes were read from Claude Code
// 2.1 transcripts: `attachment` lines carry what a session listed, `assistant` lines the model's
// tool calls and usage, `user` lines slash commands.
import type { Fact, TranscriptFormat } from "@loadsheet/kit";
import type { Day, Id } from "@loadsheet/schema";
import { mcpToolName } from "./claude-code-machine.ts";

/**
 * What one transcript remembers between lines: the session's day, entrypoint and version, which
 * items it has listed, and names only. Plain JSON, saved in the cache.
 */
export interface ClaudeState {
  day?: Day;
  via?: string;
  version?: string;
  /** The session Fact was emitted. */
  started: boolean;
  /** The tokens Fact was emitted. */
  tokens: boolean;
  /** Ids already listed by this session. */
  listed: Record<Id, true>;
  /** Subagent types the session lists as built in. */
  builtIn: Record<string, true>;
  /** MCP servers seen in this turn's attachments, and their characters, until the turn starts. */
  mcp: Record<string, number>;
  /** Project instruction ids seen in this turn's attachments, and their characters, likewise. */
  project: Record<Id, number>;
  /** A slash command whose expansion the next line should carry. */
  command?: string;
}

/**
 * Subagents every Claude Code ships; a subagent's own transcript has no listing to say so. `fork`
 * is the session forking itself, which no listing names.
 */
const BUILT_IN_AGENTS = [
  "general-purpose",
  "fork",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "output-style-setup",
];
/** Claude Code's placeholder model for messages that never reached the API. */
const SYNTHETIC_MODEL = "<synthetic>";
/** A name loadsheet will put in an id: no spaces, markup, quotes or path separators. */
const NAME = /^[^\s<>"'`/\\]{1,128}$/u;
const COMMAND =
  /^\s*<command-message>[^<]*<\/command-message>\s*<command-name>\/?([^<]+)<\/command-name>/u;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** The server in a tool name `mcp__<server>__<tool>`. */
const mcpServer = (tool: string) => /^mcp__(.+?)__./u.exec(tool)?.[1];

/** Where an instruction id names a project's file. */
const PROJECT = "project/";

/**
 * An instruction file's name: `CLAUDE.md` and `rules/...` for the user's own, as the machine
 * inventory names them; `memory/MEMORY.md` for every project's auto memory; and for any project's
 * file, the home directory's included, `project/` and its file name, or `project/rules/` and its
 * file name for a rule under `.claude/rules`. No folder gets in: every worktree would be an id of
 * its own, and its name is the user's.
 */
export const instructionName = (path: string, type: string): string | undefined => {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const file = parts.at(-1);
  if (!file) return undefined;
  if (type === "AutoMem") return `memory/${file}`;
  if (type === "User" || type === "Managed") {
    const rules = parts.lastIndexOf("rules");
    return rules !== -1 && rules < parts.length - 1 ? parts.slice(rules).join("/") : file;
  }
  const dot = parts.lastIndexOf(".claude");
  if (dot !== -1 && parts[dot + 1] === "rules" && dot + 2 < parts.length) {
    return `${PROJECT}rules/${file}`;
  }
  return PROJECT + file;
};

/**
 * Each skill the listing names and the entry it got: `- name: description` or, past the
 * listing's budget, the bare `- name`. Entries follow `names`, one per line.
 */
const skillEntries = (names: readonly string[], content: string) => {
  const starts: { name: string; at: number }[] = [];
  let cursor = 0;
  for (const name of names) {
    const needle = `- ${name}`;
    let at = content.startsWith(needle, cursor) ? cursor : content.indexOf(`\n${needle}`, cursor);
    if (at === -1) continue;
    if (at !== cursor || !content.startsWith(needle, at)) at += 1;
    const after = content[at + needle.length];
    if (after !== undefined && after !== ":" && after !== "\n") continue;
    starts.push({ name, at });
    cursor = at + needle.length;
  }
  return starts.map(({ name, at }, index) => {
    const next = starts[index + 1];
    const entry = content
      .slice(at, next === undefined ? content.length : next.at - 1)
      .replace(/\n+$/u, "");
    return { name, chars: entry.length + 1, bare: entry === `- ${name}` };
  });
};

/** The text a user line starts with: its string content, or its first text block. */
const userText = (message: unknown) => {
  if (!isRecord(message)) return undefined;
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const first = content.find((block) => isRecord(block) && block.type === "text");
  return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
};

export const claudeTranscripts: TranscriptFormat<ClaudeState> = {
  // Every line loadsheet reads carries its entrypoint; request logs and titles do not.
  markers: ['"entrypoint"'],
  initial: () => ({ started: false, tokens: false, listed: {}, builtIn: {}, mcp: {}, project: {} }),
  parse(line, state) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isRecord(record)) return [];
    const { type } = record;
    if (type !== "user" && type !== "assistant" && type !== "attachment" && type !== "system") {
      return [];
    }

    if (state.day === undefined) {
      const time = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (Number.isNaN(time)) return [];
      state.day = new Date(time).toISOString().slice(0, 10);
      state.via =
        typeof record.entrypoint === "string" && NAME.test(record.entrypoint)
          ? record.entrypoint
          : "unknown";
      if (typeof record.version === "string" && NAME.test(record.version))
        state.version = record.version;
    }
    const day = state.day;
    const via = state.via ?? "unknown";
    // A subagent's lines, in its own transcript or (in older versions) its parent's.
    const side = record.isSidechain === true;
    const facts: Fact[] = [];

    if (!side && !state.started) {
      state.started = true;
      facts.push({
        type: "session",
        day,
        via,
        ...(state.version ? { version: state.version } : {}),
      });
    }
    const listed = (item: Id, chars: number, bare: boolean) => {
      if (side || state.listed[item]) return;
      state.listed[item] = true;
      facts.push({ type: "listed", day, via, item, chars, bare });
    };
    const used = (item: Id, by: "model" | "user") =>
      facts.push({ type: "used", day, via, item, by });

    if (type === "attachment") {
      // A subagent's listing is its parent's to count, and the parent counts it.
      if (side) return facts;
      const attachment = isRecord(record.attachment) ? record.attachment : {};
      switch (attachment.type) {
        case "skill_listing": {
          const content = typeof attachment.content === "string" ? attachment.content : "";
          for (const { name, chars, bare } of skillEntries(strings(attachment.names), content)) {
            if (NAME.test(name)) listed(`skill:${name}`, chars, bare);
          }
          break;
        }
        case "agent_listing_delta": {
          for (const name of [
            ...strings(attachment.builtInTypes),
            ...strings(attachment.builtInPluginTypes),
          ]) {
            if (NAME.test(name)) state.builtIn[name] = true;
          }
          const lines = strings(attachment.addedLines);
          for (const name of strings(attachment.addedTypes)) {
            if (!NAME.test(name) || state.builtIn[name]) continue;
            const entry = lines.find(
              (text) =>
                text === `- ${name}` ||
                text.startsWith(`- ${name}: `) ||
                text.startsWith(`- ${name} (`),
            );
            listed(`subagent:${name}`, (entry ?? `- ${name}`).length + 1, entry === undefined);
          }
          break;
        }
        case "mcp_instructions_delta": {
          const blocks = Array.isArray(attachment.addedBlocks) ? attachment.addedBlocks : [];
          strings(attachment.addedNames).forEach((name, index) => {
            const server = mcpToolName(name);
            const block = blocks[index];
            state.mcp[server] =
              (state.mcp[server] ?? 0) + (typeof block === "string" ? block.length : 0);
          });
          break;
        }
        case "deferred_tools_delta": {
          const lines = Array.isArray(attachment.addedLines) ? attachment.addedLines : [];
          strings(attachment.addedNames).forEach((tool, index) => {
            const server = mcpServer(tool);
            if (server === undefined) return;
            const text = lines[index];
            state.mcp[server] =
              (state.mcp[server] ?? 0) + (typeof text === "string" ? text.length + 1 : 0);
          });
          break;
        }
        case "instructions": {
          // Project files share ids, so one id's files add up until the turn starts, as MCP
          // servers do. A file that loads later for an id the session listed, such as one
          // reloaded after /compact, is not counted again.
          for (const file of Array.isArray(attachment.files) ? attachment.files : []) {
            if (!isRecord(file) || typeof file.path !== "string") continue;
            const name = instructionName(file.path, typeof file.type === "string" ? file.type : "");
            if (name === undefined) continue;
            const item = `instructions:${name}`;
            const chars = typeof file.content === "string" ? file.content.length : 0;
            if (!name.startsWith(PROJECT)) listed(item, chars, false);
            else if (!state.listed[item]) state.project[item] = (state.project[item] ?? 0) + chars;
          }
          break;
        }
      }
      return facts;
    }

    // A turn's attachments arrive one line each; its MCP servers and project instruction files are
    // counted once they are all in.
    for (const [server, chars] of Object.entries(state.mcp)) {
      if (NAME.test(server)) listed(`mcp:${server}`, chars, false);
    }
    state.mcp = {};
    for (const [item, chars] of Object.entries(state.project)) listed(item, chars, false);
    state.project = {};

    if (type === "user") {
      const command = state.command;
      delete state.command;
      // A skill or custom command run as `/name` expands into the next line, marked meta; a
      // built-in command such as /compact does not.
      if (command !== undefined && record.isMeta === true) used(`skill:${command}`, "user");
      const match = COMMAND.exec(userText(record.message) ?? "");
      const name = match?.[1]?.trim();
      if (name !== undefined && NAME.test(name)) state.command = name;
      return facts;
    }
    delete state.command;

    if (type === "assistant" && isRecord(record.message)) {
      const { message } = record;
      if (!side && !state.tokens && isRecord(message.usage) && message.model !== SYNTHETIC_MODEL) {
        state.tokens = true;
        const usage = message.usage;
        const tokens =
          count(usage.input_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens);
        facts.push({ type: "tokens", day, via, tokens });
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string")
          continue;
        const input = isRecord(block.input) ? block.input : {};
        if (block.name === "Skill") {
          const name =
            typeof input.skill === "string" ? input.skill.trim().replace(/^\//u, "") : "";
          if (NAME.test(name)) used(`skill:${name}`, "model");
        } else if (block.name === "Agent" || block.name === "Task") {
          const name =
            typeof input.subagent_type === "string"
              ? input.subagent_type.trim()
              : "general-purpose";
          if (NAME.test(name) && !state.builtIn[name] && !BUILT_IN_AGENTS.includes(name)) {
            used(`subagent:${name}`, "model");
          }
        } else {
          const server = mcpServer(block.name);
          if (server !== undefined && NAME.test(server)) used(`mcp:${server}`, "model");
        }
      }
    }
    return facts;
  },
};

import { parse } from "tinyaml";

/** What every harness reads from a SKILL.md, command or subagent file. */
export interface SkillMd {
  /** The frontmatter's `name`. */
  name?: string;
  /** The frontmatter's `description`, trimmed. */
  description?: string;
  /** The first non-empty line after the frontmatter, trimmed: what Claude Code lists for a skill with no description. */
  firstLine?: string;
  /** The frontmatter's `when_to_use`, trimmed. */
  whenToUse?: string;
  /** A subagent's frontmatter `tools`, as a list. */
  tools?: string[];
  /** A subagent's frontmatter `disallowedTools`, as a list. */
  disallowedTools?: string[];
  /** Whether the frontmatter sets `disable-model-invocation` to true, yes, on or 1. */
  disableModelInvocation: boolean;
  /** Characters after the frontmatter: what a session loads when it invokes the file. */
  bodyChars: number;
}

/**
 * A frontmatter name loadsheet will put in an id, as Claude Code allows it: words with one plain
 * space between them, and no markup, quotes, path separators or invisible characters. Claude Code
 * names an entry whose frontmatter name it refuses by its folder or file.
 */
export const SKILL_NAME = /^(?=.{1,128}$)[^\s<>"'`/\\\p{C}]+(?: [^\s<>"'`/\\\p{C}]+)*$/u;

// The opening `---` must be the first line; the block ends at the next line that is exactly `---` (or `...`).
const FRONTMATTER = /^---[ \t]*\n([\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/u;

// A plain scalar such as `name: 2024` parses as a number; the harness reads it as text.
const text = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }
  return String(value).trim() || undefined;
};

// A tool list is a YAML list or one comma-separated string.
const list = (value: unknown) => {
  const items = (Array.isArray(value) ? value.map(text) : (text(value)?.split(",") ?? []))
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
};

/** A Markdown file's frontmatter fields and the text after it. Frontmatter that is missing or not valid YAML counts as empty. */
export const splitFrontmatter = (
  source: string,
): { data: Record<string, unknown>; body: string } => {
  const normalized = source.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  const match = FRONTMATTER.exec(normalized);
  const body = match ? normalized.slice(match[0].length) : normalized;
  let data: Record<string, unknown> = {};
  if (match?.[1]) {
    try {
      const parsed = parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable frontmatter: the harness would not see its fields either.
    }
  }
  return { data, body };
};

/** Reads a SKILL.md-style file. Frontmatter that is missing or not valid YAML counts as empty. */
export const readSkillMd = (source: string): SkillMd => {
  const { data, body } = splitFrontmatter(source);
  const skill: SkillMd = {
    disableModelInvocation: /^(?:true|yes|on|1)$/iu.test(
      text(data["disable-model-invocation"]) ?? "",
    ),
    bodyChars: body.length,
  };
  const name = text(data.name);
  const description = text(data.description);
  const whenToUse = text(data.when_to_use);
  const firstLine = /\S.*/u.exec(body)?.[0].trim();
  const tools = list(data.tools);
  const disallowedTools = list(data.disallowedTools);
  if (name) skill.name = name;
  if (tools) skill.tools = tools;
  if (disallowedTools) skill.disallowedTools = disallowedTools;
  if (description) skill.description = description;
  if (firstLine) skill.firstLine = firstLine;
  if (whenToUse) skill.whenToUse = whenToUse;
  return skill;
};

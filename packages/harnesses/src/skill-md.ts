import { parse } from "tinyaml";

/** What every harness reads from a SKILL.md, command or subagent file. */
export interface SkillMd {
  /** The frontmatter's `name`. */
  name?: string;
  /** The frontmatter's `description`, trimmed. */
  description?: string;
  /** The frontmatter's `when_to_use`, trimmed. */
  whenToUse?: string;
  /** Whether the frontmatter sets `disable-model-invocation: true`. */
  disableModelInvocation: boolean;
  /** Characters after the frontmatter: what a session loads when it invokes the file. */
  bodyChars: number;
}

// The opening `---` must be the first line; the block ends at the next line that is exactly `---` (or `...`).
const FRONTMATTER = /^---[ \t]*\n([\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/u;

// A plain scalar such as `name: 2024` parses as a number; the harness reads it as text.
const text = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }
  return String(value).trim() || undefined;
};

/** Reads a SKILL.md-style file. Frontmatter that is missing or not valid YAML counts as empty. */
export const readSkillMd = (source: string): SkillMd => {
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
  const disable = data["disable-model-invocation"];
  const skill: SkillMd = {
    disableModelInvocation: disable === true || disable === "true",
    bodyChars: body.length,
  };
  const name = text(data.name);
  const description = text(data.description);
  const whenToUse = text(data.when_to_use);
  if (name) skill.name = name;
  if (description) skill.description = description;
  if (whenToUse) skill.whenToUse = whenToUse;
  return skill;
};

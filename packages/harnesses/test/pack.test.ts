import { memoryFiles, sha256 } from "@loadsheet/kit";
import { describe, expect, it } from "vite-plus/test";
import { claudeCode, claudeCodeListedChars, readSkillMd } from "../src/index.ts";

const skill = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

describe("claudeCodeListedChars", () => {
  it("counts `- name: description - when_to_use` and its newline", () => {
    const parsed = readSkillMd("---\ndescription: Does it.\nwhen_to_use: Always.\n---\n");
    expect(claudeCodeListedChars("x", parsed)).toBe("- x: Does it. - Always.\n".length);
    expect(claudeCodeListedChars("x", readSkillMd(""))).toBe("- x\n".length);
  });

  it("counts nothing for a skill the model may not invoke", () => {
    const parsed = readSkillMd("---\ndescription: D\ndisable-model-invocation: true\n---\n");
    expect(claudeCodeListedChars("x", parsed)).toBe(0);
  });
});

describe("Claude Code pack inventory", () => {
  it("finds every SKILL.md and leaves the pack's own instructions out", async () => {
    const files = memoryFiles(
      {
        "AGENTS.md": "# dev notes",
        "CLAUDE.md": "# dev notes",
        "README.md": "# readme",
        "skills/alpha/SKILL.md": skill("alpha", "Does alpha."),
        "skills/nested/beta/SKILL.md": skill("beta-renamed", "Does beta.", "when_to_use: Often.\n"),
        "skills/alpha/reference.md": "extra",
        "commands/ignored.md": "not a plugin, so not a command",
      },
      "acme/skills",
    );
    const items = await claudeCode.inventory(files);
    const alpha = skill("alpha", "Does alpha.");
    expect(items).toEqual([
      {
        id: "skill:alpha",
        ref: { kind: "skill", name: "alpha" },
        harnesses: ["claude-code"],
        scope: "user",
        pack: "acme/skills",
        managedBy: "skills",
        path: "skills/alpha",
        digest: await sha256(alpha),
        chars: { listed: "- alpha: Does alpha.\n".length, body: "\n# alpha\n".length },
        modelInvocable: true,
        description: "Does alpha.",
      },
      expect.objectContaining({
        id: "skill:beta-renamed",
        path: "skills/nested/beta",
        chars: { listed: "- beta-renamed: Does beta. - Often.\n".length, body: 16 },
      }),
    ]);
  });

  it("prefixes a plugin's skills, commands and subagents with the plugin name", async () => {
    const files = memoryFiles(
      {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "kit" }),
        "skills/how/SKILL.md": skill("how", "Explains.", "disable-model-invocation: true\n"),
        "commands/ship.md": "---\ndescription: Ships it.\n---\nSteps.",
        "agents/reviewer.md": skill("reviewer", "Reviews."),
        "agents/nested/ignored.md": skill("ignored", "Too deep."),
      },
      "acme/kit",
    );
    const items = await claudeCode.inventory(files);
    expect(
      items.map(({ id, path, scope, managedBy, pack, chars, modelInvocable }) => ({
        id,
        path,
        scope,
        managedBy,
        pack,
        listed: chars.listed,
        modelInvocable,
      })),
    ).toEqual([
      {
        id: "subagent:kit:reviewer",
        path: "agents/reviewer.md",
        scope: "plugin",
        managedBy: "plugin",
        pack: "acme/kit",
        listed: "- kit:reviewer: Reviews.\n".length,
        modelInvocable: true,
      },
      {
        id: "skill:kit:ship",
        path: "commands/ship.md",
        scope: "plugin",
        managedBy: "plugin",
        pack: "acme/kit",
        listed: "- kit:ship: Ships it.\n".length,
        modelInvocable: true,
      },
      {
        id: "skill:kit:how",
        path: "skills/how",
        scope: "plugin",
        managedBy: "plugin",
        pack: "acme/kit",
        listed: 0,
        modelInvocable: false,
      },
    ]);
  });

  it("names a skill after its folder when the frontmatter has no name, and a root SKILL.md after the pack", async () => {
    const items = await claudeCode.inventory(
      memoryFiles({ "SKILL.md": "# root", "x/y/SKILL.md": "# y" }, "acme/solo"),
    );
    expect(items.map((item) => [item.id, item.path])).toEqual([
      ["skill:solo", "SKILL.md"],
      ["skill:y", "x/y"],
    ]);
  });
});

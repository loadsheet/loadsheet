import { describe, expect, it } from "vite-plus/test";
import { readSkillMd } from "../src/index.ts";

describe("readSkillMd", () => {
  it("reads name, description, when_to_use and the body size", () => {
    const body = "\n# Title\n\nText.\n";
    expect(
      readSkillMd(
        `---\nname: tidy\ndescription: Tidies things.\nwhen_to_use: When it is messy.\n---\n${body}`,
      ),
    ).toEqual({
      name: "tidy",
      description: "Tidies things.",
      whenToUse: "When it is messy.",
      disableModelInvocation: false,
      bodyChars: body.length,
    });
  });

  it("treats a file without frontmatter as all body", () => {
    expect(readSkillMd("# Just text\n")).toEqual({ disableModelInvocation: false, bodyChars: 12 });
  });

  it("folds a multi-line description", () => {
    const skill = readSkillMd(
      "---\nname: x\ndescription: >-\n  First line\n  second line.\n---\nb",
    );
    expect(skill.description).toBe("First line second line.");
    expect(skill.bodyChars).toBe(1);
  });

  it("reads a quoted description with escapes and colons", () => {
    const skill = readSkillMd(
      '---\nname: x\ndescription: "Use for \\"how\\": walkthroughs"\n---\n',
    );
    expect(skill.description).toBe('Use for "how": walkthroughs');
    expect(skill.bodyChars).toBe(0);
  });

  it("reads CRLF files the same as LF, and counts the body in LF", () => {
    const lf =
      "---\nname: x\ndescription: D\ndisable-model-invocation: true\n---\nline 1\nline 2\n";
    expect(readSkillMd(lf.replaceAll("\n", "\r\n"))).toEqual(readSkillMd(lf));
    expect(readSkillMd(lf)).toMatchObject({ disableModelInvocation: true, bodyChars: 14 });
  });

  it("ignores frontmatter that is not valid YAML", () => {
    expect(readSkillMd("---\nname: [unclosed\n---\nbody")).toEqual({
      disableModelInvocation: false,
      bodyChars: 4,
    });
  });

  it("treats an unclosed frontmatter block as body", () => {
    expect(readSkillMd("---\nname: x\n").name).toBeUndefined();
  });
});

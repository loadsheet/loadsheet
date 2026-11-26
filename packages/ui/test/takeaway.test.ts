import { describe, expect, it } from "vite-plus/test";
import { type CItem, type Context, type Phrase, type SegId, takeaway } from "../src/lib/context";

const item = (name: string, tokens: number): CItem => ({
  id: name,
  name,
  tokens,
  group: "personal",
  project: false,
});
const seg = (id: SegId, items: CItem[]) => ({
  id,
  label: id,
  sub: "",
  about: "",
  tokens: items.reduce((n, i) => n + i.tokens, 0),
  items,
});
function context(parts: Partial<Record<SegId, CItem[]>>, harness = 24_679): Context {
  const segments = Object.entries(parts).map(([id, items]) => seg(id as SegId, items));
  if (harness) segments.unshift(seg("harness", [item("harness", harness)]));
  const setup = segments.filter((s) => s.id !== "harness").reduce((n, s) => n + s.tokens, 0);
  const total = setup + harness;
  return { total, measured: true, setup, window: 200_000, free: 200_000 - total, segments };
}
const text = (p: Phrase) => p.map((r) => (typeof r === "string" ? r : r.b)).join("");

describe("the report's takeaway", () => {
  it("calls a small setup light and says what is left", () => {
    const c = context({ skill: [item("notes", 900)], mcp: [item("executor", 1100)] });
    expect(text(takeaway(c, "Claude Code"))).toBe(
      "Your setup is light. Claude Code itself takes 24.7k tokens, and you added 2k tokens. That leaves 87% free for your chat.",
    );
  });

  it("names the MCP server that weighs most", () => {
    const c = context({ mcp: [item("playwright", 7900), item("github", 18_200)] });
    expect(text(takeaway(c, "Claude Code"))).toContain("github alone takes 18.2k tokens");
  });

  it("counts global and project skills together and leaves out ones that load nothing", () => {
    const c = context({
      skill: [item("a", 4000), item("b", 0)],
      pskill: [item("c", 3000)],
      instructions: [item("CLAUDE.md", 6000)],
    });
    expect(text(takeaway(c, "Codex"))).toMatch(
      /^Your 2 skills add 7k tokens to Codex’s startup list/,
    );
  });

  it("speaks of the limit once half of it is gone, and never says what to do", () => {
    const c = context({ instructions: [item("CLAUDE.md", 90_000)] });
    const said = text(takeaway(c, "Claude Code"));
    expect(said).toMatch(/^That’s 57% of the limit,/);
    expect(said).not.toMatch(/\b(run|delete|remove|turn off|shorten)\b/i);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../app/skills/${path}`, import.meta.url), "utf8"));
const { packs } = read("packs.json") as {
  packs: { slug: string; sha: string; jobs: string[]; items: { path: string }[] }[];
};
const copy = read("copy.json") as {
  packs: Record<string, unknown>;
  compare: Record<string, { verdict: { slug: string }[] }>;
};
const slugs = packs.map((p) => p.slug);

describe("the skill pack reviews", () => {
  test("every measured pack has its text, and no text is left without a pack", () => {
    expect(Object.keys(copy.packs).toSorted()).toEqual(slugs.toSorted());
  });

  test("a comparison names only packs it compares", () => {
    for (const [job, c] of Object.entries(copy.compare)) {
      const on = packs.filter((p) => p.jobs.includes(job)).map((p) => p.slug);
      expect(c.verdict.map((v) => v.slug).toSorted()).toEqual(on.toSorted());
    }
  });

  test("every pack lists its files at the commit it was measured at, with each skill's SKILL.md", () => {
    for (const p of packs) {
      const list = read(`files/${p.slug.replaceAll("/", "_")}.json`) as {
        sha: string;
        files: { path: string }[];
      };
      expect(list.sha).toBe(p.sha);
      const paths = new Set(list.files.map((f) => f.path));
      for (const s of p.items)
        expect(paths).toContain(s.path === "SKILL.md" ? "SKILL.md" : `${s.path}/SKILL.md`);
    }
  });
});

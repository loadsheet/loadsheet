import { setupBudget } from "@loadsheet/core";

/**
  The skill packs loadsheet.dev reviews: each measured at a pinned commit by `apps/site/scripts/skill-packs.ts`, with
  text written for each pack and each comparison.
*/
export interface SkillItem {
  name: string;
  /** The skill's folder, relative to the pack; `SKILL.md` for a skill at the pack's root. */
  path: string;
  /** What its listing adds to every session; 0 for a skill only a slash command runs. */
  tokens: number;
  listed: number;
  /** Characters of SKILL.md and its files, read when the skill runs. */
  body: number;
  description: string;
}
export interface SkillPack {
  /** `owner/repo[/dir]`. */
  slug: string;
  title: string;
  by: string;
  /** `owner/repo` on GitHub. */
  repo: string;
  /** The pack's folder inside the repository. */
  dir?: string;
  /** The commit it was measured at. */
  sha: string;
  stars: number;
  pushed: string;
  /** The comparisons it appears in. */
  jobs: string[];
  /** Heaviest first. */
  items: SkillItem[];
  findings: { rule: string; item?: string; evidence: Record<string, number> }[];
}
export interface SkillPackCopy {
  what: string;
  pick: string;
  skip: string;
  post: string[];
}
export interface SkillCompareCopy {
  title: string;
  sub: string;
  post: string[];
  verdict: { slug: string; line: string }[];
}
export interface SkillCatalog {
  measuredAt: string;
  packs: SkillPack[];
  unmeasured: { slug: string; why: string }[];
  copy: {
    index: { title: string; sub: string };
    packs: Record<string, SkillPackCopy>;
    compare: Record<string, SkillCompareCopy>;
  };
}
/** Every file in a pack's skill folders, paths relative to the pack. */
export interface SkillFiles {
  files: { path: string; size: number; binary?: true }[];
}

/** The budget every bar on these pages is drawn against: a setup's share of a 200k window. */
export const BUDGET = setupBudget().budget;

export const JOBS: Record<string, string> = {
  workflow: "Workflow",
  ui: "UI",
  framework: "Framework",
};

export const packTotals = (p: SkillPack) => {
  const listed = p.items.filter((s) => s.tokens > 0);
  return {
    tokens: listed.reduce((n, s) => n + s.tokens, 0),
    skills: p.items.length,
    listed: listed.length,
    slashOnly: p.items.length - listed.length,
    body: p.items.reduce((n, s) => n + s.body, 0),
  };
};
/** Skills whose description is over the length the expensive-description rule allows. */
export const longDescriptions = (p: SkillPack) =>
  p.findings.filter((f) => f.rule === "expensive-description");
export const isLong = (p: SkillPack, name: string) =>
  longDescriptions(p).some((f) => f.item === `skill:${name}`);

/** A share of the budget, as the pages print it. */
export const ofBudget = (tokens: number) => {
  const p = (tokens / BUDGET) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
};
export const kchars = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The written copy may use `code` and nothing else. */
export const md = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

const inPack = (p: SkillPack, path: string) => (p.dir ? `${p.dir}/${path}` : path);
export const githubUrl = (p: SkillPack) =>
  `https://github.com/${p.repo}${p.dir ? `/tree/HEAD/${p.dir}` : ""}`;
/** A file at the commit the pack was measured at. */
export const blobUrl = (p: SkillPack, path: string) =>
  `https://github.com/${p.repo}/blob/${p.sha}/${inPack(p, path)}`;
export const rawUrl = (p: SkillPack, path: string) =>
  `https://raw.githubusercontent.com/${p.repo}/${p.sha}/${inPack(p, path)}`;

export const skillPackRoute = (slug: string) => ({
  name: "skill-pack",
  params: { slug: slug.split("/") },
});
export const skillCompareRoute = (job: string) => ({ name: "skill-compare", params: { job } });
/** The packs a comparison covers, in the order of its packs. */
export const packsFor = (c: SkillCatalog, job: string) =>
  c.packs.filter((p) => p.jobs.includes(job));

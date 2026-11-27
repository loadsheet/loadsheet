import type { SkillCatalog, SkillFiles } from "@loadsheet/ui";
import copy from "./copy.json";
import measured from "./packs.json";

/** The reviewed packs, measured by `scripts/skill-packs.ts`, with the review text for each. */
export const catalog: SkillCatalog = { ...(measured as Omit<SkillCatalog, "copy">), copy };

const lists = import.meta.glob<SkillFiles>("./files/*.json", { import: "default" });
/** A pack's file list, loaded only on its own page. */
export const filesOf = (slug: string) => lists[`./files/${slug.replaceAll("/", "_")}.json`]?.();

/** Copy may mark code with backticks; meta tags take plain text. */
export const plain = (s: string) => s.replaceAll("`", "");
